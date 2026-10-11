// lib/traffic-log.js — 请求流量日志：经过插件的每条请求一条记录（内存环形缓冲，不落盘）
//
// 覆盖两条通道，互不重叠：
//   1) fetch 包装层（globalThis.fetch → proxiedFetch）——完整元数据 + 请求/响应体预览；
//   2) harness 中继层（web_fetch 经本地中继）——CONNECT 隧道记目标与双向字节（TLS 内容
//      不可见，如实标注），明文 http 记完整请求/响应 + 预览。
// 汇总（条数/上行/下行/错误数）随记录累加，进程重启清零。
//
// 隐私边界：全部数据只存本进程内存，GET /_dsh/net-proxy/log 返回给同源设置页，
// 不写磁盘、不外发。URL 与响应体预览可能包含业务数据，属预期行为（用户要看的正是它）。

const MAX_PREVIEW_CHARS = 4096; // 单侧预览存储上限（字符），超出截断

// 常见二进制魔数（图片/压缩包/PDF 等）：命中直接存占位符，不存乱码
const BIN_MAGIC = [
  [0, [0x89, 0x50, 0x4e, 0x47], "PNG"],
  [0, [0xff, 0xd8, 0xff], "JPEG"],
  [0, [0x47, 0x49, 0x46, 0x38], "GIF"],
  [0, [0x25, 0x50, 0x44, 0x46], "PDF"],
  [0, [0x50, 0x4b, 0x03, 0x04], "ZIP"],
  [0, [0x1f, 0x8b], "GZIP"],
  [0, [0x42, 0x4d], "BMP"],
  [0, [0x00, 0x00, 0x00], "MP4/二进制"],
];

function clip(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) : s;
}

/** 二进制嗅探：魔数命中或控制字符占比过高（>8%）→ 返回类型名，否则 null（按文本处理）。 */
function sniffBinary(buf) {
  for (const [off, magic, name] of BIN_MAGIC) {
    if (buf.length >= off + magic.length) {
      let hit = true;
      for (let i = 0; i < magic.length; i++) {
        if (buf[off + i] !== magic[i]) { hit = false; break; }
      }
      if (hit) return name;
    }
  }
  const sample = Math.min(buf.length, 512);
  let ctrl = 0;
  for (let i = 0; i < sample; i++) {
    const c = buf[i];
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++;
  }
  return ctrl / sample > 0.08 ? "二进制" : null;
}

/** 字节块 → 预览字符串：二进制存占位符；文本取前 previewBytes 字节，控制字符以 · 展示。 */
function previewOf(buf, previewBytes) {
  if (!previewBytes || !buf || !buf.length) return null;
  const bin = sniffBinary(buf);
  if (bin) return `‹${bin} ${buf.length}B，不存内容›`;
  const b = buf.length > previewBytes ? buf.subarray(0, previewBytes) : buf;
  let s = Buffer.from(b).toString("utf8");
  if (buf.length > previewBytes) s += `…(+${buf.length - previewBytes}B)`;
  // 去掉会撑破 UI 的控制字符（保留 \t \n \r；不用正则，避免 no-control-regex）
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 ? "·" : ch;
  }
  return clip(out, MAX_PREVIEW_CHARS);
}

/**
 * 创建流量日志器。
 * @param opts.maxEntries   环形缓冲条数上限（默认 500）
 * @param opts.previewBytes 请求/响应体预览的最大字节数（默认 512，0 = 不记预览）
 * @param opts.maxLive      进行中记录数上限（默认 2000）：挂死/长连接的记录在
 *                          finalize 前不进环形缓冲，为防半开连接无限积累设此保险丝，
 *                          超限后新请求不再记录（转发不受影响），旧记录回收后自动恢复。
 * @param opts.maxFullBytes 单条「完整体」上限（默认 256KB）：供设置页「查看全部内容」；
 *                          超限不存（如实标注），二进制内容不存。
 * @param opts.maxFullPool  完整体总池预算（默认 4MB）：超出时从最旧记录开始挤出，
 *                          挤出的条目退回「仅预览」状态；保证完整体总内存有硬上限。
 */
export function createTrafficLog({
  maxEntries = 500,
  previewBytes = 512,
  maxLive = 2000,
  maxFullBytes = 256 * 1024,
  maxFullPool = 4 * 1024 * 1024,
} = {}) {
  let entries = []; // 新的在前
  let nextId = 1;
  let cfg = { previewBytes };
  let liveN = 0;
  let fullPoolBytes = 0; // 完整体池当前总字节（仅计入 state==="ok" 的 body）
  const sum = { total: 0, upBytes: 0, downBytes: 0, errors: 0, live: 0, since: Date.now() };

  function configure({ previewBytes: pb } = {}) {
    if (pb != null && Number.isInteger(pb) && pb >= 0 && pb <= 8192) cfg = { previewBytes: pb };
  }

  // ── 完整体池：存/挤出/扣减。side: "req" | "res" ──
  function fullStore(entry, side, state, body) {
    const stKey = side === "req" ? "reqFullState" : "resFullState";
    const oldBody = side === "req" ? entry._reqFull : entry._resFull;
    if (oldBody && oldBody.length) fullPoolBytes -= oldBody.length;
    entry[side === "req" ? "_reqFull" : "_resFull"] = null;
    entry[stKey] = state;
    if (state === "ok" && body && body.length) {
      // 池预算：先挤最旧的已完条目，挤不动（都还在进行中）则拒绝存入
      if (fullPoolBytes + body.length > maxFullPool) {
        for (let i = entries.length - 1; i >= 0 && fullPoolBytes + body.length > maxFullPool; i--) {
          const old = entries[i];
          const ob = old[side === "req" ? "_reqFull" : "_resFull"];
          if (ob && ob.length) {
            fullPoolBytes -= ob.length;
            old[side === "req" ? "_reqFull" : "_resFull"] = null;
            old[stKey] = "evicted";
          }
        }
      }
      if (fullPoolBytes + body.length <= maxFullPool) {
        entry[side === "req" ? "_reqFull" : "_resFull"] = body;
        fullPoolBytes += body.length;
      } else {
        entry[stKey] = "evicted";
      }
    }
  }
  // 环形截断/清空时释放被删条目的完整体
  function fullRelease(entry) {
    for (const k of ["_reqFull", "_resFull"]) {
      if (entry[k] && entry[k].length) fullPoolBytes -= entry[k].length;
      entry[k] = null;
    }
  }

  /**
   * 开一条新记录。返回 handle 供协议栈沿途回填；调用方必须在流结束时 finalize。
   * 全部调用点都以 `if (entry)` 判空，熔断/禁用时返回 null 即整体不记录。
   */
  function begin(meta) {
    if (liveN >= maxLive) return null; // 熔断：防挂死连接把内存拖穿
    const m = meta || {};
    const entry = {
      id: nextId++,
      ts: Date.now(),
      kind: m.kind || "fetch",
      method: String(m.method || "GET").toUpperCase(),
      url: clip(String(m.url || ""), 2048), // 超长 URL（巨型 query）也设上限，防条目膨胀
      host: safeHost(m.url),
      status: null,
      upBytes: 0,
      downBytes: 0,
      ms: null,
      reqPreview: null,
      resPreview: null,
      reqFullState: null,
      resFullState: null,
      error: null,
      live: true,
    };
    let resFullChunks = []; // 响应完整体累积（明文解压后），受 maxFullBytes 约束
    let resFullBytes = 0;
    let resBinType = null;
    const h = {
      /** 请求体（Buffer/string，一次性；调用方持有的是完整 body）→ 预览 + 完整体 */
      setRequestPreview(buf) {
        const b = Buffer.isBuffer(buf) ? buf : buf != null ? Buffer.from(String(buf)) : null;
        if (b && b.length && entry.reqFullState == null) {
          const bin = sniffBinary(b);
          if (bin) entry.reqFullState = "binary";
          else if (b.length > maxFullBytes) entry.reqFullState = "too-large";
          else fullStore(entry, "req", "ok", Buffer.from(b));
        }
        if (entry.reqPreview == null && cfg.previewBytes > 0) {
          entry.reqPreview = previewOf(b, cfg.previewBytes);
        }
      },
      setResponse(status) {
        if (entry.status == null && Number.isFinite(Number(status))) entry.status = Number(status);
      },
      addUp(n) { const v = Number(n); if (Number.isFinite(v) && v > 0) entry.upBytes += v; },
      addDown(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return;
        entry.downBytes += v;
      },
      /** 明文（解压后）响应块 → 首块预览 + 完整体累积（供「查看全部内容」） */
      addPlain(buf) {
        if (!buf || !buf.length) return;
        if (resBinType == null) {
          const bin = sniffBinary(buf);
          if (bin) {
            resBinType = bin;
            if (entry.resFullState == null) entry.resFullState = "binary";
          }
        }
        if (resBinType == null && entry.resFullState !== "too-large" && entry.resFullState !== "binary") {
          if (resFullBytes + buf.length <= maxFullBytes) {
            resFullChunks.push(Buffer.from(buf));
            resFullBytes += buf.length;
          } else {
            entry.resFullState = "too-large";
            resFullChunks = [];
            resFullBytes = 0;
          }
        }
        if (entry.resPreview == null && cfg.previewBytes > 0) {
          entry.resPreview = previewOf(buf, cfg.previewBytes);
        }
      },
      finalize(err) {
        if (!entry.live) return;
        entry.live = false;
        liveN -= 1;
        entry.ms = Date.now() - entry.ts;
        if (err) entry.error = clip(String((err && err.message) || err), 300);
        sum.total += 1;
        sum.upBytes += entry.upBytes;
        sum.downBytes += entry.downBytes;
        if (err || (entry.status != null && entry.status >= 400)) sum.errors += 1;
        // 响应完整体收尾入池（流式中途超限/二进制已在 addPlain 标注）
        if (resFullChunks.length && entry.resFullState == null) {
          fullStore(entry, "res", "ok", Buffer.concat(resFullChunks));
        } else if (entry.resFullState == null) {
          entry.resFullState = resFullChunks.length ? "ok" : null;
        }
        resFullChunks = [];
        entries.unshift(entry);
        if (entries.length > maxEntries) {
          const dropped = entries.splice(maxEntries);
          for (const d of dropped) fullRelease(d);
        }
      },
    };
    liveN += 1;
    return h;
  }

  function summary() { return { ...sum, live: liveN }; }
  function list(limit = 200) {
    const n = Math.max(1, Math.min(Number(limit) || 200, maxEntries));
    // 剥离内部完整体 Buffer（不进列表 JSON；全量内容经 full(id) 单独取）
    return entries.slice(0, n).map((e) => {
      const { _reqFull, _resFull, ...pub } = e;
      void _reqFull; void _resFull;
      return pub;
    });
  }
  function liveCount() { return liveN; }
  /** 取一条记录的完整体（设置页「查看全部内容」）。返回 { state, body, truncated }。 */
  function full(id, side) {
    const n = Number(id);
    if (!Number.isInteger(n) || (side !== "req" && side !== "res")) return { state: "gone", body: null };
    const it = entries.find((e) => e.id === n);
    if (!it) return { state: "gone", body: null };
    const state = side === "req" ? it.reqFullState : it.resFullState;
    const buf = side === "req" ? it._reqFull : it._resFull;
    if (state !== "ok" || !buf) return { state: state || "none", body: null };
    return { state: "ok", body: buf.toString("utf8"), truncated: false };
  }
  function clear() {
    for (const e of entries) fullRelease(e);
    entries = [];
    // liveN 不清零：进行中的记录仍会 finalize（届时正常累加统计），清零会导致计数变负
    sum.total = 0; sum.upBytes = 0; sum.downBytes = 0; sum.errors = 0; sum.since = Date.now();
  }

  return { begin, configure, summary, list, clear, liveCount, full, get maxEntries() { return maxEntries; } };
}

function safeHost(u) {
  try { return new URL(String(u)).host || null; } catch { return null; }
}
