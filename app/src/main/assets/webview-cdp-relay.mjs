#!/usr/bin/env node
/**
 * webview-cdp-relay.mjs — 把 Android System WebView 接到 ego-browser 上。
 *
 * 为什么需要这一层（都是本机实测结论，不是推测）：
 *
 *   1. 本机没有任何 Chrome/Chromium 可执行文件（全盘 find 命中 0），只有
 *      com.google.android.webview。所以「另装一个浏览器」这条路不存在，
 *      唯一可用的 Chromium 能力就是应用自己的 WebView。
 *
 *   2. 该 WebView 在同进程的抽象 unix socket
 *      `@webview_devtools_remote_<app pid>` 上提供完整 DevTools/CDP 服务
 *      （/json/version 报 Chrome/153.0.8010.36）。读类能力全通：
 *      page.info / page.snapshot（实测 32KB 真实可访问性树）/ page.evaluate。
 *      但 Node 的 WebSocket 只能拨 ws:// TCP，拨不了抽象 socket —— 需要这一步桥接。
 *
 *   3. 该端点的 Target.createTarget 恒返回
 *      {"code":-32000,"message":"Not supported"}，createBrowserContext 同理。
 *      而 ego 每个工具的第一步都是
 *      useSpace -> createTaskSpace -> Target.createTarget，所以不补这一手，
 *      ego 在本机永远停在 running:false。
 *
 *   4. 该端点的 /json/version 返回的 webSocketDebuggerUrl **不带端口**
 *      （"ws://127.0.0.1/devtools/browser"）。ego 的 probe() 原样把它交给
 *      new WebSocket()，必然连不上 —— 所以本中继必须改写这个字段，指回自己的端口。
 *
 *   5. /json/list 的每条记录都带一个 webview 元数据块
 *      （attached / visible / width / height），说明**每个 WebView 实例都会在同一
 *      个进程级 socket 上注册成独立的 page target**。因此「CDP 建页」可以等价成
 *      「让页面 window.open 一次」—— 由宿主 WebChromeClient.onCreateWindow 真正
 *      造出第二个 WebView，它自动注册成新 target。本文件把这条等价关系补进转发层。
 *
 * 于是 vendored ego 运行时（runtime/ego-linux/src/*.mjs）**一个字节都不用改**，
 * 插件整包继续与上游 npm 产物同源。
 *
 * 环境变量：
 *   EGO_LINUX_WEBVIEW_RELAY_PORT        监听端口（默认 41999）
 *   DSH_APP_PACKAGE                     宿主包名（默认 com.dsh.nextapp1）
 *   EGO_LINUX_WEBVIEW_CREATE_TIMEOUT_MS 等新 target 的上限（默认 10000）
 */
import net from "node:net";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.EGO_LINUX_WEBVIEW_RELAY_PORT || 41999);
const HOST = "127.0.0.1";
const APP = process.env.DSH_APP_PACKAGE || "com.dsh.nextapp1";
const INTERNAL_ID_BASE = 900000000;
const CREATE_TIMEOUT_MS = Number(process.env.EGO_LINUX_WEBVIEW_CREATE_TIMEOUT_MS || 10000);
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DBG = !!process.env.RELAY_DEBUG;
/**
 * 宿主是否已经实现多窗口（setSupportMultipleWindows + onCreateWindow）。
 *
 * 这个开关决定「能不能拿用户的 GUI 页当 opener」，是本中继最关键的一条安全边界：
 *
 *   · 未开启多窗口时，对页面执行 window.open(url,"_blank") **不会**被忽略，
 *     而是把**当前页**导航过去 —— 真机实测：用户的 dsh GUI 被导航成了 about:blank。
 *     所以此时绝不能用 GUI 当 opener，宁可报错。
 *   · 已开启多窗口时，window.open 会被 onCreateWindow 拦下并造出第二个 WebView，
 *     原页不动。这才是能安全使用 GUI 作为 opener 的唯一前提。
 *
 * 而且第一个 target 只能这么来（鸡生蛋）：ego 的 createTaskSpace 直接调
 * Target.createTarget，那一刻只有 GUI 一个页，没有 agent 页可当 opener。
 */
const MULTIWINDOW = process.env.EGO_LINUX_WEBVIEW_MULTIWINDOW === "1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------- 上游抽象 socket */

function findAppPid() {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let cmd = "";
    try {
      cmd = readFileSync("/proc/" + entry + "/cmdline", "utf8").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (cmd === APP) return entry;
  }
  return null;
}

function upstreamSocketName() {
  // 显式覆盖优先：既方便在非 Android 环境复用，也让本文件可被集成测试
  // 指向一个仿造的 WebView socket（见 tools/webview-cdp-relay.test.mjs）。
  // 环境变量装不下 NUL，所以这里用 "@name" 前缀表示抽象 socket（Android 用），
  // 不带前缀则当成普通文件路径（测试与其它平台用）。
  const override = process.env.EGO_LINUX_WEBVIEW_SOCKET;
  if (override) return override.startsWith("@") ? "\0" + override.slice(1) : override;
  const pid = findAppPid();
  return pid ? "\0webview_devtools_remote_" + pid : null;
}

/* ------------------------------------------------------------ WS 编解码 */

function encodeFrame(payload, opcode, maskKey) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let b1;
  let extLen;
  if (len < 126) {
    b1 = len;
    extLen = Buffer.alloc(0);
  } else if (len < 65536) {
    b1 = 126;
    extLen = Buffer.alloc(2);
    extLen.writeUInt16BE(len, 0);
  } else {
    b1 = 127;
    extLen = Buffer.alloc(8);
    extLen.writeBigUInt64BE(BigInt(len), 0);
  }
  if (maskKey) b1 |= 0x80;
  const head = Buffer.concat([Buffer.from([0x80 | opcode, b1]), extLen]);
  if (!maskKey) return Buffer.concat([head, data]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i & 3];
  return Buffer.concat([head, maskKey, masked]);
}

function serverFrame(obj) {
  return encodeFrame(JSON.stringify(obj), 0x1, null);
}

function clientFrame(obj) {
  return encodeFrame(JSON.stringify(obj), 0x1, Buffer.from([1, 2, 3, 4]));
}

/** 把缓冲区里**完整**的帧切出来；半帧留在 rest 里等下一批字节。 */
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      p += 8;
      if (big > BigInt(MAX_FRAME_BYTES)) return { frames, rest: Buffer.alloc(0), broken: true };
      len = Number(big);
    }
    let key = null;
    if (masked) {
      if (buf.length - p < 4) break;
      key = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
      payload = out;
    }
    const end = p + len;
    frames.push({ fin, opcode, payload, raw: buf.subarray(off, end) });
    off = end;
  }
  return { frames, rest: buf.subarray(off), broken: false };
}

/** /json/version 里的 webSocketDebuggerUrl 不带端口，必须指回本中继。 */
function rewriteVersionBody(text) {
  let out = text.split("ws://127.0.0.1/devtools/").join("ws://127.0.0.1:" + PORT + "/devtools/");
  out = out.split("ws://localhost/devtools/").join("ws://127.0.0.1:" + PORT + "/devtools/");
  return out;
}

/* ---------------------------------------------------------------- 连接 */

function onClient(client) {
  client.setNoDelay(true);

  const st = {
    client,
    up: null,
    pre: Buffer.alloc(0), // 还没连上上游时暂存的客户端字节
    cbuf: Buffer.alloc(0), // 流模式下 client->up 的半帧
    ubuf: Buffer.alloc(0), // 流模式下 up->client 的半帧 / 半响应头
    jbuf: Buffer.alloc(0), // /json/version 的完整响应
    hdr: Buffer.alloc(0), // 客户端请求头（收全前暂存）
    hdrDone: false,
    ws: false,
    closed: false,
    method: null,
    path: null,
    rewritable: false,
    local: false,
    nid: INTERNAL_ID_BASE,
    pend: new Map(),
    sess: new Set(),
    ctrl: null,
    guiId: null, // 认领到的用户 GUI 页 targetId，认领后钉住（见 isUserPage）
  };

  function teardown() {
    if (st.closed) return;
    st.closed = true;
    for (const entry of st.pend.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("relay closed"));
    }
    st.pend.clear();
    try { client.destroy(); } catch {}
    try { if (st.up) st.up.destroy(); } catch {}
  }

  function toUpstream(bytes) {
    if (st.up && !st.up.destroyed) st.up.write(bytes);
    else st.pre = Buffer.concat([st.pre, bytes]);
  }

  function toClient(bytes) {
    if (st.closed) return;
    try { client.write(bytes); } catch { teardown(); }
  }

  /* --- 内部 CDP 调用（本进程自己的 id 空间，与客户端互不干扰） --- */

  function internalCall(method, params, sessionId) {
    const id = st.nid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        st.pend.delete(id);
        reject(new Error("internal CDP timeout: " + method));
      }, 15000);
      st.pend.set(id, { resolve, reject, timer });
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      toUpstream(clientFrame(msg));
    });
  }

  async function internalPages() {
    const result = await internalCall("Target.getTargets", {});
    return (result.targetInfos || []).filter((t) => t.type === "page");
  }

  async function controlSession(targetId) {
    if (st.ctrl && st.ctrl.targetId === targetId) return st.ctrl.sessionId;
    const result = await internalCall("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = result.sessionId;
    if (!sessionId) throw new Error("attachToTarget returned no sessionId");
    st.sess.add(sessionId);
    st.ctrl = { targetId, sessionId };
    return sessionId;
  }

  /** 用户的 dsh GUI 页。**任何情况下都不许拿它当 opener。** */
  function isUserPage(target) {
    if (!target) return false;
    // 按 url 认领（首次见到 :3080 就记住 targetId），认领后**钉住 id**。
    // 为什么不能只看 url：GUI 页可能被重定向 / 用户自己在页面里跳到别处 /
    // 落到错误页，那时 url 不再是 :3080。若只认 url，它会被误判成 agent 页，
    // 于是被 pickOpener 拿去当 opener（window.open 会把它导航走）或被
    // closeTarget 关掉 —— 这两件事都违反「不牺牲用户界面」。
    if (String(target.url || "").includes(":3080")) {
      st.guiId = target.targetId;
      return true;
    }
    return st.guiId !== null && target.targetId === st.guiId;
  }

  /**
   * 挑 opener。优先 agent 自己的页；只有在宿主已开多窗口时才允许用 GUI 页兜底。
   *
   * ⚠️ 真机实测（本轮踩过的坑，已复现）：宿主 WebView **未**开启多窗口时，
   * 对页面执行 `window.open(url, "_blank")` **不会**被忽略，而是把**当前页**
   * 导航到该 url —— 实测用户的 dsh GUI 被导航成了 about:blank（已恢复）。
   *
   * 因此这里绝不能无条件退回 pages[0]：未开多窗口时当只有 GUI 一个页，
   * 宁可失败，也不能把用户的界面导航走。这条守卫与「不牺牲用户界面」是同一件事。
   */
  function pickOpener(pages) {
    const agentPages = pages.filter((p) => !isUserPage(p));
    if (agentPages.length) return agentPages[0];
    if (MULTIWINDOW) return pages.find(isUserPage) || pages[0] || null;
    return null;
  }

  /**
   * 若 window.open 意外把 GUI 页导航走了，立刻导航回原 url。
   *
   * 「不牺牲用户界面」的第二道防线（第一道是 pickOpener 的拒绝策略）：
   * 运行时无法可靠断言 onCreateWindow 是否真的接住了这次 open，所以事后核对
   * GUI 页的 url，变了就用内部 session 导航回去（不再走 window.open）。
   */
  async function restoreUserPage(guiId, originalUrl) {
    if (!guiId || !originalUrl) return;
    try {
      const pages = await internalPages();
      const gui = pages.find((t) => t.targetId === guiId);
      if (!gui || String(gui.url) === originalUrl) return;
      const sessionId = await controlSession(guiId);
      await internalCall("Page.navigate", { url: originalUrl }, sessionId);
      if (DBG) process.stderr.write("DBG restored user page -> " + originalUrl + "\n");
    } catch (e) {
      if (DBG) process.stderr.write("DBG restore failed: " + String((e && e.message) || e) + "\n");
    }
  }

  /** 把 Target.createTarget 等价成页面侧 window.open，等新 target 注册出来。 */
  async function openTarget(url) {
    const before = await internalPages();
    const known = new Set(before.map((t) => t.targetId));
    const opener = pickOpener(before);
    if (!opener) {
      throw new Error(
        "refusing to open a window: the only page is the user's dsh UI, and " +
          "window.open() on it would navigate it away. Enable multi-window " +
          "(setSupportMultipleWindows + onCreateWindow) so a second WebView exists.",
      );
    }
    const guiId = isUserPage(opener) ? opener.targetId : null;
    const guiUrl = guiId ? String(opener.url || "") : null;
    const sessionId = await controlSession(opener.targetId);
    await internalCall(
      "Runtime.evaluate",
      {
        // 必须回一个**原始值**：window.open 返回 Window 对象，
        // returnByValue 序列化它会报 -32000 "Object reference chain is too long"。
        expression:
          "(function(){try{return window.open(" +
          JSON.stringify(url) +
          ", \"_blank\") ? 1 : 0;}catch(e){return -1;}})()",
        userGesture: true,
        returnByValue: true,
      },
      sessionId,
    );
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const now = await internalPages();
      const fresh = now.filter((t) => !known.has(t.targetId));
      if (fresh.length) {
        await restoreUserPage(guiId, guiUrl);
        return fresh[fresh.length - 1];
      }
      await sleep(120);
    }
    // 没等出新页：GUI 很可能被这次 open 导航走了，先还原再报错。
    await restoreUserPage(guiId, guiUrl);
    throw new Error(
      "window.open produced no new target: the host WebView needs " +
        "setSupportMultipleWindows(true) + WebChromeClient.onCreateWindow",
    );
  }

  async function closeTarget(targetId) {
    const pages = await internalPages();
    const target = pages.find((t) => t.targetId === targetId);
    if (target && isUserPage(target)) {
      // 用户正在看的 dsh GUI：绝不关。交给原生 closeTarget（多半不支持，失败也安全）。
      await internalCall("Target.closeTarget", { targetId }).catch(() => {});
      return;
    }
    // ⚠️ 真机实测（新 APK，2026-10-12）：对子 WebView 关页时，
    //    · window.close() / Target.closeTarget 经内部 session 发出去**收不到回包**
    //      （早期实现在这里白等 internalCall 的 15s 超时，每次都卡）；
    //    · 但 **Page.close** 有效：页面真的消失，且宿主 WebChromeClient.onCloseWindow
    //      被触发、日志出现 "popup WebView destroyed"。
    //    所以这里改成「发了就走」，并按 有效度 从高到低依次尝试，不等任何回包。
    // ⚠️ 必须把 sessionId 传给 internalCall：Page.close / Runtime.evaluate 只有在
    //    该页的 session 里发才有意义。早先这里的 fire 辅助只收 (method, params)，
    //    把 sessionId 悄悄丢了 ⇒ Page.close 落到**浏览器级**（对整棵 target 树无效），
    //    表现为关页静默失败、页面一直留着。现已修。
    const fire = (method, params, sessionId) =>
      internalCall(method, params, sessionId).catch(() => {}); // 只求送出，不求确认
    controlSession(targetId)
      .then((sessionId) => {
        // ① 最强：Page.close（在该页 session 里发，触发宿主的 onCloseWindow）
        fire("Page.close", {}, sessionId);
        // ② 兜底：让页面自己 window.close()
        fire("Runtime.evaluate", { expression: "window.close()", userGesture: true }, sessionId);
      })
      .catch(() => {})
      // ③ 最后再交给原生（多半回 Not supported，失败也安全）
      .then(() => fire("Target.closeTarget", { targetId }));
    if (st.ctrl && st.ctrl.targetId === targetId) st.ctrl = null;
  }

  /* --- 客户端帧 --- */

  function handleClientFrame(frame) {
    if (frame.opcode === 0x8 || frame.opcode === 0x9 || frame.opcode === 0xa) {
      toUpstream(frame.raw);
      return;
    }
    if (frame.opcode === 0x1 && frame.fin) {
      let msg = null;
      try { msg = JSON.parse(frame.payload.toString("utf8")); } catch { msg = null; }
      if (msg && typeof msg.id === "number" && msg.id < INTERNAL_ID_BASE) {
        if (msg.method === "Target.createTarget") {
          const p = msg.params || {};
          const url = typeof p.url === "string" && p.url !== "" ? p.url : "about:blank";
          openTarget(url)
            .then((t) => toClient(serverFrame({ id: msg.id, result: { targetId: t.targetId } })))
            .catch((e) =>
              toClient(
                serverFrame({
                  id: msg.id,
                  error: { code: -32000, message: String((e && e.message) || e) },
                }),
              ),
            );
          return; // 不往上转发：WebView 一定会回 "Not supported"
        }
        if (msg.method === "Target.closeTarget") {
          const targetId = (msg.params || {}).targetId;
          closeTarget(targetId)
            .then(() => toClient(serverFrame({ id: msg.id, result: {} })))
            .catch(() => toClient(serverFrame({ id: msg.id, result: {} })));
          return;
        }
      }
    }
    toUpstream(frame.raw);
  }

  /* --- 上游帧 --- */

  function handleUpstreamFrame(frame) {
    if (frame.opcode === 0x1 && frame.fin) {
      let msg = null;
      try { msg = JSON.parse(frame.payload.toString("utf8")); } catch { msg = null; }
      if (msg) {
        if (typeof msg.id === "number" && msg.id >= INTERNAL_ID_BASE) {
          const entry = st.pend.get(msg.id);
          if (entry) {
            st.pend.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(msg.error.message || "internal CDP error"));
            else entry.resolve(msg.result || {});
            return;
          }
        }
        // 本进程自己开的 session，它的事件归本进程：漏给客户端会把 harness 的
        // 事件缓冲淹掉（见 vendored transport.mjs 的同名注释）。
        if (msg.sessionId && st.sess.has(msg.sessionId)) return;
      }
    }
    toClient(frame.raw);
  }

  function upstreamFrames(buf) {
    const parsed = parseFrames(buf);
    st.ubuf = parsed.rest;
    for (const frame of parsed.frames) handleUpstreamFrame(frame);
    if (parsed.broken) teardown();
  }

  function clientFrames(buf) {
    const parsed = parseFrames(buf);
    st.cbuf = parsed.rest;
    for (const frame of parsed.frames) handleClientFrame(frame);
    if (parsed.broken) teardown();
  }

  function onUpstreamData(chunk) {
    if (st.ws) {
      upstreamFrames(Buffer.concat([st.ubuf, chunk]));
      return;
    }
    st.jbuf = Buffer.concat([st.jbuf, chunk]);
    const seen = st.jbuf.toString("latin1");
    const end = seen.indexOf("\r\n\r\n");
    if (end < 0) {
      if (st.jbuf.length > 262144) teardown(); // 一个响应头不该长成这样
      return;
    }
    const head = seen.slice(0, end + 4);
    const rest = st.jbuf.subarray(end + 4);

    if (head.indexOf(" 101 ") > 0) {
      st.ws = true;
      st.jbuf = Buffer.alloc(0);
      // 同样剥掉 accept：两端都不压缩，中继才解析得了帧。
      const clean101 = head
        .split("\r\n")
        .filter((line) => line.toLowerCase().indexOf("sec-websocket-extensions:") !== 0)
        .join("\r\n");
      toClient(Buffer.from(clean101, "latin1"));
      if (rest.length) upstreamFrames(rest);
      return;
    }

    if (!st.rewritable) {
      // 非 /json/version：原样透传（含 /json/list —— 它的 id 就是 targetId，
      // 客户端只用 id/type，不需要改写）。
      st.jbuf = Buffer.alloc(0);
      toClient(Buffer.from(head, "latin1"));
      if (rest.length) toClient(rest);
      return;
    }

    const low = head.toLowerCase();
    const ci = low.indexOf("content-length:");
    if (ci < 0) {
      // 没有长度就等连接结束再改写；由 close 分支兜底。
      st.jbuf = Buffer.concat([Buffer.from(head, "latin1"), rest]);
      return;
    }
    let j = ci + "content-length:".length;
    while (low[j] === " " || low[j] === "\t") j += 1;
    let k = j;
    while (low[k] >= "0" && low[k] <= "9") k += 1;
    const want = Number(head.slice(j, k));
    if (!Number.isFinite(want) || want < 0) {
      st.jbuf = Buffer.alloc(0);
      toClient(Buffer.from(head, "latin1"));
      if (rest.length) toClient(rest);
      return;
    }
    if (rest.length < want) {
      st.jbuf = Buffer.concat([Buffer.from(head, "latin1"), rest]);
      return;
    }
    const body = rest.subarray(0, want).toString("utf8");
    const extra = rest.subarray(want);
    const out = Buffer.from(rewriteVersionBody(body), "utf8");
    const newHead = head.split("\r\n").map((line) =>
      line.toLowerCase().indexOf("content-length:") === 0
        ? "Content-Length:" + out.length
        : line,
    ).join("\r\n");
    st.jbuf = Buffer.alloc(0);
    toClient(Buffer.concat([Buffer.from(newHead, "latin1"), out, extra]));
  }

  /* --- /json/new 本地处理（HTTP 版新建页） --- */

  function respondJson(status, obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    toClient(
      Buffer.from(
        "HTTP/1.1 " + status + "\r\n" +
          "Content-Type: application/json; charset=UTF-8\r\n" +
          "Content-Length: " + body.length + "\r\n" +
          "Connection: close\r\n\r\n",
        "latin1",
      ),
    );
    toClient(body);
    setTimeout(teardown, 30);
  }

  /* --- 客户端请求头 --- */

  /**
   * 客户端字节泵（HTTP 请求头处理）。
   *
   * 每收到一个完整的 \r\n\r\n 头就处理一次，然后**重置**头缓冲，这样同一条
   * keep-alive 连接上的第 N 个请求头也会被处理。早先这里用「一次性」标志
   * （处理过就不再处理），结果是 Node fetch 复用连接池时，WebSocket 升级请求
   * 的头被原样转发 —— permessage-deflate 报价漏到上游，协商成功，帧被压缩，
   * 中继从此读不懂自己的回包（表现为 createTarget 永远超时）。
   *
   * @returns {boolean} true 表示调用方不要重复转发这批字节。
   */
  function pumpClientHttp(chunk) {
    st.hdr = Buffer.concat([st.hdr, chunk]);
    for (;;) {
      const end = st.hdr.indexOf("\r\n\r\n");
      if (end < 0) {
        // 一个请求头不该长成这样；见到就断开，避免畸形输入把内存撑爆。
        if (st.hdr.length > 65536) teardown();
        return true;
      }
      const rawHead = st.hdr.subarray(0, end + 4).toString("latin1");
      const rest = st.hdr.subarray(end + 4);
      st.hdr = Buffer.alloc(0);

      const firstLine = rawHead.split("\r\n")[0];
      const sp1 = firstLine.indexOf(" ");
      const sp2 = sp1 > 0 ? firstLine.indexOf(" ", sp1 + 1) : -1;
      if (sp1 > 0 && sp2 > sp1) {
        st.method = firstLine.slice(0, sp1);
        st.path = firstLine.slice(sp1 + 1, sp2);
      }
      st.rewritable = st.path !== null && st.path.indexOf("/json/version") === 0;

      // HTTP 版新建页：本地处理，不转发（WebView 的 PUT /json/new 会返回 500）。
      if (
        st.method &&
        (st.method === "PUT" || st.method === "POST") &&
        st.path &&
        st.path.indexOf("/json/new") === 0
      ) {
        st.local = true;
        const q = st.path.indexOf("?");
        const raw = q < 0 ? "about:blank" : st.path.slice(q + 1);
        const url = raw.indexOf("url=") === 0 ? decodeURIComponent(raw.slice(4)) : raw;
        openTarget(url || "about:blank")
          .then((t) =>
            respondJson("200 OK", {
              id: t.targetId,
              type: "page",
              url: t.url || url,
              webSocketDebuggerUrl: "ws://127.0.0.1:" + PORT + "/devtools/page/" + t.targetId,
            }),
          )
          .catch((e) =>
            respondJson("500 Internal Server Error", { error: String((e && e.message) || e) }),
          );
        return true;
      }

      // 剥掉 permessage-deflate：两端都由本中继牵线，不协商就没有压缩帧。
      const cleaned = rawHead
        .split("\r\n")
        .filter((line) => line.toLowerCase().indexOf("sec-websocket-extensions:") !== 0)
        .join("\r\n");

      toUpstream(Buffer.concat([Buffer.from(cleaned, "latin1"), rest]));

      // 头之后可能还有本批的剩余字节（例如升级请求后面紧跟的帧）。
      // 若这批里正好只有一个头，就结束本轮；若还有下一个头，循环继续。
      if (st.hdr.length === 0) return true;
    }
  }

  client.on("data", (chunk) => {
    if (st.closed || st.local) return;
    if (st.ws) {
      clientFrames(Buffer.concat([st.cbuf, chunk]));
      return;
    }
    pumpClientHttp(chunk);
  });

  client.on("error", teardown);
  client.on("close", teardown);

  const sock = upstreamSocketName();
  if (!sock) {
    teardown();
    return;
  }
  const up = net.connect(sock);
  up.setNoDelay(true);
  st.up = up;
  up.on("connect", () => {
    if (st.pre.length) {
      const pending = st.pre;
      st.pre = Buffer.alloc(0);
      up.write(pending);
    }
  });
  up.on("data", onUpstreamData);
  up.on("error", teardown);
  up.on("close", teardown);
}

const server = net.createServer(onClient);
server.on("error", (e) => {
  process.stderr.write("relay: " + String((e && e.message) || e) + "\n");
  process.exit(1);
});
/**
 * 写 ego 的 browser.json，让 `--status` / ego_doctor 看到「浏览器在跑」。
 *
 * ego 的 browserStatus() 读 STATE_DIR/browser.json 的 port 再探 /json/version，
 * 我们的中继两头都答得上（version 已被改写成带端口的 ws url），所以状态自洽：
 * 不会出现「CDP 明明能用、--status 却说 running:false」的分裂。
 * pid 记本进程 —— 于是 ego 的 `--stop` 语义正好是「停掉这个桥」。
 */
function writeBrowserStateFile() {
  try {
    const home = process.env.HOME || "";
    if (!home) return;
    const base = process.env.XDG_STATE_HOME || home + "/.local/state";
    const dir = base + "/ego-lite-linux";
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dir + "/browser.json",
      JSON.stringify(
        {
          port: PORT,
          wsUrl: "ws://127.0.0.1:" + PORT + "/devtools/browser",
          pid: process.pid,
          headless: false,
          binary: process.env.EGO_LINUX_CHROME || "webview-cdp-relay",
          profileDir: dir + "/profile",
          via: "android-system-webview-relay",
        },
        null,
        2,
      ),
    );
  } catch (e) {
    process.stderr.write("relay: browser.json write failed: " + String((e && e.message) || e) + "\n");
  }
}

server.listen(PORT, HOST, () => {
  const sock = upstreamSocketName();
  writeBrowserStateFile();
  process.stdout.write(
    "RELAY_READY port=" + PORT + " socket=" + (sock ? sock.slice(1) : "(app not running)") + "\n",
  );
});
