/*!
 * webview-download.js —— WebView 页面侧「导出 / 下载」助手。
 *
 * 为什么需要它：dsh 的 Web UI 与插件全部用「Blob + a[download].click()」导出文件
 * （例如 jet hub 的账号备份：lib/client/jet-hub.js 的 downloadJson）。Android WebView
 * 默认既不下载也不报错 —— 点了导出毫无反应。而 blob: URL 在原生 DownloadListener 里
 * 只是一串不可读的地址，shouldInterceptRequest 也看不到它，所以内容只能在页面侧读出来，
 * 再交给宿主落盘。
 *
 * 本脚本由 WebViewActivity 在每次 onPageFinished 注入（自带幂等守卫），注入前宿主会先写
 * window.__dshDownloadNonce（每个 WebView 一份，闭包内读取）。remote iframe 读不到父页的
 * JS 变量，因此拿不到 nonce，也就不能借这个桥往磁盘写文件。它做三件事：
 *   1. 记录 URL.createObjectURL 产出的 Blob 引用（页面会在 1s 后 revoke，引用仍有效）；
 *   2. 捕获 click 阶段的「导出型」锚点（带 download 属性，或 href 是 blob:/data:），
 *      先向宿主申请一次导出，宿主接收后才拦掉默认动作并分块提交；
 *   3. 暴露 window.__dshDownload.pull(url, name, mime) 供宿主在兜底路径上主动索取。
 *
 * 约定：本文件只负责「把字节交出去」，落盘位置、是否弹保存框全在 Kotlin 侧决定。
 * 原生桥方法：begin(nonce, name, mime, size) -> id；chunk(id, base64) -> bool；
 *              finish(id, total) -> bool；abort(id, reason)。
 */
(function () {
  "use strict";

  if (window.__dshDownloadInstalled) return "already-installed";
  var bridge = window.DshDownload;
  if (!bridge || typeof bridge.begin !== "function") return "no-native-bridge";
  window.__dshDownloadInstalled = true;

  // 注入时由宿主写入的一次性凭证；没有它宿主的 begin 会直接拒收。
  var nonce = String(window.__dshDownloadNonce || "");

  // 96 KB 原始字节 → 128 KB base64。桥是同步调用，分块小一点可避免长任务卡住渲染。
  var CHUNK_BYTES = 96 * 1024;
  /** 最多记住多少个 blob 引用（页面只在点击后一秒内 revoke，留 16 个足够）。 */
  var MAX_TRACKED_BLOBS = 16;

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /** 纯 JS 的 base64（不走 btoa：String.fromCharCode.apply 在数万参数时会爆栈）。 */
  function toBase64(u8) {
    var out = "";
    var i = 0;
    var len = u8.length;
    for (; i + 2 < len; i += 3) {
      var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    var rest = len - i;
    if (rest === 1) {
      var a = u8[i];
      out += B64[a >> 2] + B64[(a << 4) & 63] + "==";
    } else if (rest === 2) {
      var b = (u8[i] << 8) | u8[i + 1];
      out += B64[b >> 10] + B64[(b >> 4) & 63] + B64[(b << 2) & 63] + "=";
    }
    return out;
  }

  var blobByUrl = Object.create(null);
  var trackedOrder = [];

  function track(url, blob) {
    if (!url || !blob) return;
    if (!blobByUrl[url]) trackedOrder.push(url);
    blobByUrl[url] = blob;
    while (trackedOrder.length > MAX_TRACKED_BLOBS) {
      delete blobByUrl[trackedOrder.shift()];
    }
  }

  var nativeCreate = URL.createObjectURL;
  if (typeof nativeCreate === "function") {
    URL.createObjectURL = function (obj) {
      var url = nativeCreate.apply(URL, arguments);
      try {
        if (obj instanceof Blob) track(url, obj);
      } catch (e) { /* 跨 realm 的 Blob 判断失败不影响原功能 */ }
      return url;
    };
  }

  /** 向宿主申请一次导出，成功返回 token（空串 = 拒收）。 */
  function beginTransfer(name, mime, size) {
    try {
      return bridge.begin(nonce, name || "", mime || "", size | 0) || "";
    } catch (e) {
      return "";
    }
  }

  /** 把已申请的这次导出的内容分块推给宿主。返回 Promise<string>。 */
  function sendBlob(id, blob) {
    return blob.arrayBuffer().then(function (buf) {
      var u8 = new Uint8Array(buf);
      var off = 0;
      while (off < u8.length) {
        var end = Math.min(u8.length, off + CHUNK_BYTES);
        if (!bridge.chunk(id, toBase64(u8.subarray(off, end)))) {
          bridge.abort(id, "chunk-rejected");
          return "chunk-rejected";
        }
        off = end;
      }
      return bridge.finish(id, u8.length) ? "ok" : "finish-rejected";
    })["catch"](function (e) {
      try { bridge.abort(id, String((e && e.message) || e)); } catch (ignored) {}
      return "error:" + String((e && e.message) || e);
    });
  }

  /** 申请 + 提交。申请被拒时返回 rejected，宿主不会留下半截文件。 */
  function pushBlob(blob, name, mime) {
    var id = beginTransfer(name, mime || blob.type, blob.size | 0);
    if (!id) return Promise.resolve("rejected");
    return sendBlob(id, blob);
  }

  /** 宿主主动索取：blob: / data: / 同源 http(s) 都走这里。 */
  function pull(url, name, mime) {
    var known = blobByUrl[url];
    if (known) return pushBlob(known, name, mime || known.type);
    return fetch(url, { credentials: "include" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.blob();
      })
      .then(function (blob) { return pushBlob(blob, name, mime || blob.type); })
      ["catch"](function (e) { return "error:" + String((e && e.message) || e); });
  }

  /** 判断一个元素是不是「导出型」锚点；不是则返回 null。 */
  function asDownloadAnchor(el) {
    if (!el || el.nodeType !== 1) return null;
    if (String(el.tagName || "").toUpperCase() !== "A") return null;
    var raw = el.getAttribute("href") || "";
    var download = el.getAttribute("download");
    var isBlob = /^blob:/i.test(raw) || /^blob:/i.test(el.href || "");
    var isData = /^data:/i.test(raw);
    if (download === null && !isBlob && !isData) return null;
    return {
      href: raw,
      abs: el.href || raw,
      name: download || "",
    };
  }

  function onClickCapture(ev) {
    var node = ev.target;
    if (node && node.nodeType === 3) node = node.parentNode; // 文本节点
    var hit = null;
    var el = node;
    while (el && el !== document) {
      hit = asDownloadAnchor(el);
      if (hit) break;
      el = el.parentNode;
    }
    if (!hit) return;

    var blob = blobByUrl[hit.abs] || blobByUrl[hit.href];
    if (!blob) return; // 交回默认动作：原生 DownloadListener / pull 兜底

    // 先申请、拿到 token 才拦默认动作。顺序必须是这个：宿主拒收（来源不可信、
    // 体积超限）时保持默认动作不变，交给原生 DownloadListener 与页面自带的降级路径，
    // 绝不能把点击吞掉却什么也不做 —— 那正是用户抱怨的「点了没反应」。
    var id = beginTransfer(hit.name, blob.type, blob.size | 0);
    if (!id) return;
    ev.preventDefault();
    ev.stopPropagation();
    sendBlob(id, blob);
  }

  document.addEventListener("click", onClickCapture, true);

  window.__dshDownload = {
    version: 2,
    pull: pull,
    /** 测试/排障用：当前记住的 blob 数量。 */
    tracked: function () { return trackedOrder.length; },
  };

  return "ok";
})();
