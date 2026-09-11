// 会话级用量统计：扫描 DSH 会话存储（session.jsonl.zstd），按模型/会话聚合 token 用量。
//
// 数据源是本地会话日志（NDJSON，zstd 压缩），与 CodeBuddy 计费接口完全独立：
//   - 首行  {"type":"session", id, createdAt, cwd, ...}
//   - 标题  {"type":"session/title", data:{title}}
//   - 消息  {"type":"assistant/message", time, data:{source:{provider,model}, usage:{inputTokens,outputTokens,cacheReadTokens}}}
//     （旧格式 fallback：外层 usage / 内层 message.usage 同义，都认）
// 因此本统计能覆盖所有 Provider（codebuddy-cn/intl、agent-route、free 等），
// 且粒度到"单次 assistant 消息"，计费接口做不到这一点（它只有总 credits）。
//
// 只读。每文件 mtime 缓存：未变更的会话文件不解压、不重扫。

import { zstdDecompressSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// DSH 会话日志（session.jsonl.zstd）是流式追加的多帧 zstd 文件：每条事件 flush
// 一个独立帧（实测单文件上万帧）。zstdDecompressSync 遇到多帧输入只解第一帧
// 就返回，因此必须按帧边界（0x28B52FFD magic）切开后逐帧解压再拼接。
// 压缩数据里偶然出现 magic 序列会造成假阳性边界，但那种"帧"解压必然抛错，
// 丢弃即可——真实帧永远从真实边界开始，逐帧独立解压天然抗假阳性。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressSessionLog(buf) {
  const chunks = [];
  let start = 0;
  while (start < buf.length) {
    let next = buf.indexOf(ZSTD_MAGIC, start + 4);
    if (next === -1) next = buf.length;
    try {
      chunks.push(zstdDecompressSync(buf.subarray(start, next)));
    } catch {
      /* 假阳性边界（或损坏帧）：跳过，不影响其余帧 */
    }
    start = next;
  }
  return chunks;
}

/**
 * 会话存储根目录：$DSH_HOME/sessions（与 DSH 主进程同 env）。
 * web 路由调用 collectSessionUsage 时不传参即使用此默认值。
 */
export function defaultSessionsRoot() {
  return join(process.env.DSH_HOME ?? join("data", "user", "0", "com.dsh.launcher", "files", ".dsh"), "sessions");
}

// 全量扫描实测 35 文件 / 46MB / ~80ms·MB（Node 26 内置 zstdDecompressSync），
// 一次冷扫 <2s，热扫（全部命中缓存）接近 0。无需后台 worker。
const SCAN_BUDGET_MS = 10_000;

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 单个 assistant 消息事件 → {provider, model, tokens} 或 null。 */
function usageOfEvent(event) {
  if (event?.type !== "assistant/message") return undefined;
  const data = event.data ?? {};
  const message = data.message ?? data;
  const source = message.source ?? {};
  if (source.kind !== "model") return null;
  // usage 位置随版本迁移：data.usage（当前）/ message.usage（旧）。
  const usage = data.usage ?? message.usage;
  if (!usage) return null;
  const input = safeNumber(usage.inputTokens);
  const output = safeNumber(usage.outputTokens);
  const cacheRead = safeNumber(usage.cacheReadTokens);
  const cacheWrite = safeNumber(usage.cacheWriteTokens);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  return {
    provider: source.provider ?? "?",
    model: source.model ?? "?",
    input,
    output,
    cacheRead,
    cacheWrite,
    time: typeof event.time === "number" ? event.time : undefined,
  };
}

/** 解析单个 .jsonl.zstd 会话文件；损坏/空文件返回 null（跳过，不拖垮整体）。 */
function parseSessionFile(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  // 多帧拼接后按行切分。个别帧损坏只丢那段字节；行解析失败由 tryParse 兜底。
  const events = decompressSessionLog(buf).map((c) => c.toString("utf8")).join("").split("\n");
  const header = events.length > 0 ? tryParse(events[0]) : undefined;
  if (header?.type !== "session") return null;
  const title = { text: "", at: 0 };
  let lastActivity = header.createdAt ?? 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  const models = new Map(); // "provider\x1fmodel" → {provider, model, input, output, cacheRead, cacheWrite, requests}
  for (const line of events) {
    if (!line) continue;
    const event = tryParse(line);
    if (!event) continue;
    if (typeof event.time === "number" && event.time > lastActivity) lastActivity = event.time;
    if (event.type === "session/title") {
      const text = event.data?.title;
      if (typeof text === "string" && text && event.time >= title.at) {
        title.text = text;
        title.at = event.time ?? 0;
      }
      continue;
    }
    const entry = usageOfEvent(event);
    if (!entry) continue;
    usage.input += entry.input;
    usage.output += entry.output;
    usage.cacheRead += entry.cacheRead;
    usage.cacheWrite += entry.cacheWrite;
    usage.requests += 1;
    const key = `${entry.provider}\x1f${entry.model}`;
    const bucket = models.get(key) ?? {
      provider: entry.provider,
      model: entry.model,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0,
    };
    bucket.input += entry.input;
    bucket.output += entry.output;
    bucket.cacheRead += entry.cacheRead;
    bucket.cacheWrite += entry.cacheWrite;
    bucket.requests += 1;
    models.set(key, bucket);
  }
  if (usage.requests === 0) return null; // 从未跑过模型的会话（空壳/纯 CLI），不进统计
  return {
    sessionId: header.id ?? "",
    cwd: header.cwd ?? "",
    createdAt: header.createdAt ?? 0,
    lastActivity,
    title: title.text || "(未命名会话)",
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    requests: usage.requests,
    models: [...models.values()].sort((a, b) => b.output - a.output),
  };
}

function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** 汇总：按模型 / 按 provider 归并所有会话。 */
function aggregate(sessions) {
  const byModel = new Map();
  const byProvider = new Map();
  const zeroModel = (provider, model) => ({
    provider, model,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, sessions: 0,
  });
  for (const session of sessions) {
    for (const bucket of session.models) {
      const key = `${bucket.provider}\x1f${bucket.model}`;
      // 注意：新桶必须从零初始化，不能用 {...bucket} —— 否则首个会话会被
      // 展开计入一次、再累加一次，造成重复计数。
      const model = byModel.get(key) ?? zeroModel(bucket.provider, bucket.model);
      const provider = byProvider.get(bucket.provider) ?? {
        provider: bucket.provider,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, sessions: 0,
      };
      model.input += bucket.input;
      model.output += bucket.output;
      model.cacheRead += bucket.cacheRead;
      model.cacheWrite += bucket.cacheWrite;
      model.requests += bucket.requests;
      model.sessions += 1;
      provider.input += bucket.input;
      provider.output += bucket.output;
      provider.cacheRead += bucket.cacheRead;
      provider.cacheWrite += bucket.cacheWrite;
      provider.requests += bucket.requests;
      provider.sessions += 1;
      byModel.set(key, model);
      byProvider.set(bucket.provider, provider);
    }
  }
  const sum = (pick) => sessions.reduce((acc, s) => acc + pick(s), 0);
  return {
    totals: {
      sessions: sessions.length,
      input: sum((s) => s.input),
      output: sum((s) => s.output),
      cacheRead: sum((s) => s.cacheRead),
      cacheWrite: sum((s) => s.cacheWrite),
      requests: sum((s) => s.requests),
    },
    models: [...byModel.values()].sort((a, b) => b.output - a.output),
    providers: [...byProvider.values()].sort((a, b) => b.output - a.output),
  };
}

// ---- mtime 缓存：key = 会话文件绝对路径，value = {mtimeMs, session|null} ----
const cache = new Map();

function listSessionFiles(sessionsRoot) {
  const files = [];
  let projects;
  try {
    projects = readdirSync(sessionsRoot);
  } catch {
    return files;
  }
  for (const project of projects) {
    let ids;
    try {
      ids = readdirSync(join(sessionsRoot, project));
    } catch {
      continue;
    }
    for (const id of ids) {
      const path = join(sessionsRoot, project, id, "session.jsonl.zstd");
      try {
        if (statSync(path).isFile()) files.push(path);
      } catch {
        /* 竞态：会话被清理，跳过 */
      }
    }
  }
  return files;
}

/**
 * 扫描全部会话并聚合。带缓存的重复调用（UI 轮询）几乎零开销。
 * 返回 {sessions:[按最近活跃倒序], models, providers, totals, scannedAt, stale}
 */
export function collectSessionUsage(sessionsRoot) {  const started = Date.now();
  const files = listSessionFiles(sessionsRoot);
  const sessions = [];
  let changed = 0;
  for (const path of files) {
    let mtimeMs;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) {
      if (hit.session) sessions.push(hit.session);
      continue;
    }
    const session = parseSessionFile(path);
    cache.set(path, { mtimeMs, session });
    changed += 1;
    if (session) sessions.push(session);
    if (Date.now() - started > SCAN_BUDGET_MS) break; // 预算兜底：绝不挂死路由
  }
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return {
    ...aggregate(sessions),
    sessions,
    scannedAt: new Date().toISOString(),
    files: files.length,
    reparsed: changed,
    truncated: Date.now() - started > SCAN_BUDGET_MS,
  };
}

// ---- worker 线程调度 ----
// 全量冷扫实测 ~12s 纯 CPU（多帧 zstd 解压），同步跑会阻塞宿主事件循环
// （卡住 LLM 流式与其它 web 路由）。因此 collectSessionUsageAsync 把解析
// 挪到 worker 线程：宿主只等待 Promise，不阻塞；缓存仍在 worker 内。
let workerJob = null; // {promise, root} —— 去重并发请求
let worker = null;

function getWorker() {
  if (worker?.thread) return worker;
  const require = createRequire(import.meta.url);
  const { Worker } = require("node:worker_threads");
  // worker 入口 = 本文件 + "/worker"（worker.mjs 重导出 runCollect）。
  const workerPath = fileURLToPath(import.meta.url).replace(/codebuddy-sessions\.js$/, "codebuddy-sessions-worker.mjs");
  const thread = new Worker(workerPath);
  const pending = new Map();
  thread.on("message", ({ id, error, result }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) job.reject(new Error(error)); else job.resolve(result);
  });
  thread.on("error", () => {
    // worker 崩溃：拒绝所有 pending 并复位，下次调用重建。
    for (const job of pending.values()) job.reject(new Error("会话统计 worker 崩溃"));
    pending.clear();
    worker = null;
  });
  // 注意：不要 unref()。主线程唯一挂起的就是这里的 promise 时（无其它活跃句柄），
  // unref 会让事件循环提前退出、promise 永远不 resolve（实测复现）。
  worker = {
    thread,
    seq: 0,
    pending,
  };
  return worker;
}

/** collectSessionUsage 的异步封装：解析在 worker 线程执行，不阻塞宿主事件循环。 */
export function collectSessionUsageAsync(sessionsRoot) {
  if (workerJob && workerJob.root === sessionsRoot) return workerJob.promise;
  const w = getWorker();
  const id = ++w.seq;
  const promise = new Promise((resolve, reject) => {
    w.pending.set(id, { resolve, reject });
    w.thread.postMessage({ id, root: sessionsRoot });
  });
  workerJob = { promise, root: sessionsRoot };
  // 完成后清掉去重句柄，允许下一次刷新重新发扫（缓存让重复扫描很便宜）。
  promise.finally(() => {
    if (workerJob?.promise === promise) workerJob = null;
  });
  return promise;
}
