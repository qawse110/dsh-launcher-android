/**
 * process-governance — 统一的进程治理层（策略层，不含终止机制）
 *
 * 职责：融合截止时间与取消 → 保证受管范围清空 → 产出可诊断的截断/编码/退出信号事实。
 * 不负责：终止手段本身。终止与范围回收由注入的端口提供；生产环境即宿主
 *         ctx.subprocess 的受管范围（signal 触发 SIGTERM→SIGKILL 升级，waitForExit 等范围清空）。
 *
 * 显式声明（见 PROCESS-GOVERNANCE.md）：
 * 1) 超时/归因语义对齐 @deepseek-ai/dsh-timeout，但该包无法从工作区裸导入（实测 ERR_MODULE_NOT_FOUND），
 *    故在此按同语义实现，未引入新语义。
 * 2) UTF-8 字节诊断是新增能力：宿主收集器只做 buffer.toString("utf8")，非法字节静默变 U+FFFD，
 *    官方不提供该诊断；验收标准要求可诊断，故由本层补齐。
 */
export const GOVERNANCE_VERSION = "1";

/* ── 超时与首个原因归因 ────────────────────────────────────────────── */

export function createTimeoutReason(code, timeoutMs) {
  const reason = new Error("timeout " + code + " after " + timeoutMs + "ms");
  reason.name = "TimeoutReason";
  reason.code = String(code);
  reason.timeoutMs = Number(timeoutMs);
  return reason;
}

export function timeoutOf(carrier, code) {
  const reason = carrier && carrier.reason !== undefined ? carrier.reason : carrier;
  if (!reason || reason.name !== "TimeoutReason") return undefined;
  if (code !== undefined && reason.code !== code) return undefined;
  return reason;
}

/**
 * 把上游取消与超时融合成单一信号：谁先触发就是唯一的首个原因。
 * timeoutMs <= 0 表示不装计时器（对齐官方内部哨兵语义）。
 */
export function fuseDeadline(upstream, timeoutMs, code) {
  const controller = new AbortController();
  let timer = null;
  let disposed = false;
  const onUpstream = () => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(upstream.reason === undefined ? new Error("cancelled") : upstream.reason);
  };
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason === undefined ? new Error("cancelled") : upstream.reason);
    else upstream.addEventListener("abort", onUpstream, { once: true });
  }
  if (Number(timeoutMs) > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(createTimeoutReason(code, timeoutMs));
    }, Number(timeoutMs));
  }
  return {
    signal: controller.signal,
    cause() {
      const t = timeoutOf(controller.signal, code);
      if (t) return { reason: "timeout", timeoutMs: t.timeoutMs, code: t.code };
      if (controller.signal.aborted) return { reason: "cancelled" };
      return { reason: "exit" };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      if (upstream) upstream.removeEventListener("abort", onUpstream);
    }
  };
}

/* ── UTF-8 原始字节诊断 ────────────────────────────────────────────── */

/** 扫描 UTF-8 序列，返回首个非法位置。lenient=false 表示严格（拒绝过长编码/代理区/越界）。 */
export function scanUtf8(bytes) {
  const b = bytes;
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) { i += 1; continue; }
    let need;
    let cp;
    if (c >= 0xc2 && c <= 0xdf) { need = 1; cp = c & 0x1f; }
    else if (c >= 0xe0 && c <= 0xef) { need = 2; cp = c & 0x0f; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; cp = c & 0x07; }
    else return { valid: false, offset: i, kind: "invalid-lead-byte" };
    for (let k = 1; k <= need; k += 1) {
      if (i + k >= b.length) return { valid: false, offset: i, kind: "truncated-sequence" };
      const cc = b[i + k];
      if ((cc & 0xc0) !== 0x80) return { valid: false, offset: i, kind: "invalid-continuation" };
      cp = (cp << 6) | (cc & 0x3f);
    }
    const overlong = (need === 1 && cp < 0x80) || (need === 2 && cp < 0x800) || (need === 3 && cp < 0x10000);
    if (overlong) return { valid: false, offset: i, kind: "overlong-encoding" };
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return { valid: false, offset: i, kind: "invalid-code-point" };
    i += need + 1;
  }
  return { valid: true, offset: null, kind: "valid" };
}

/**
 * 区分两类成因：
 *  - window-started-mid-codepoint：截断把窗口起点落在多字节序列内部（截断伪影，不算数据损坏）
 *  - invalid-bytes：流本身含非法字节（真损坏）
 */
export function diagnoseEncoding(bytes, options) {
  const opts = options || {};
  const truncated = opts.truncated === true;
  if (!bytes || bytes.length === 0) return { status: "clean", truncated, empty: true };
  let skip = 0;
  while (skip < Math.min(3, bytes.length) && (bytes[skip] & 0xc0) === 0x80) skip += 1;
  if (skip === 0) {
    const scan = scanUtf8(bytes);
    if (scan.valid) return { status: "clean", truncated };
    return { status: "invalid-bytes", offset: scan.offset, kind: scan.kind, truncated };
  }
  const rest = scanUtf8(bytes.subarray(skip));
  if (rest.valid) {
    // 只有声明了截断时才允许把孤立的开头续字节解释为窗口切在多字节序列内部；
    // 未截断的完整流出现孤立续字节属于真损坏。
    if (truncated) return { status: "window-started-mid-codepoint", skippedLeadBytes: skip, truncated };
    return { status: "invalid-bytes", offset: 0, kind: "stray-continuation-byte", partialLeadBytes: skip, truncated };
  }
  return { status: "invalid-bytes", offset: skip + rest.offset, kind: rest.kind, partialLeadBytes: skip, truncated };
}

/* ── 退出事实诊断 ──────────────────────────────────────────────────── */

const SIGNAL_NAMES = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 17: "SIGCHLD", 18: "SIGCONT", 19: "SIGSTOP", 20: "SIGTSTP", 21: "SIGTTIN", 22: "SIGTTOU", 24: "SIGXCPU", 25: "SIGXFSZ", 26: "SIGVTALRM", 27: "SIGPROF", 29: "SIGIO", 30: "SIGPWR", 31: "SIGSYS" };

/**
 * 描述退出事实。已上报的 signal 是事实；Windows 无 POSIX 信号，MSYS 会把致命信号
 * 编码进退出码高位（实测 bash 被 SIGKILL 后退出码为 2304 = 9*256）。
 * 该推断只作为带 confidence 的注记，绝不改写上报的 exitCode/signal。
 */
export function describeExit(outcome, platform) {
  const exitCode = outcome && outcome.exitCode !== undefined ? outcome.exitCode : null;
  const signal = outcome && outcome.signal !== undefined ? outcome.signal : null;
  if (signal) return { terminatedBySignal: true, signal, exitCode, interpretation: "reported-signal" };
  const plat = platform === undefined ? process.platform : platform;
  if (plat === "win32" && Number.isInteger(exitCode) && exitCode >= 256 && exitCode % 256 === 0) {
    const name = SIGNAL_NAMES[exitCode / 256];
    if (name) {
      return {
        terminatedBySignal: true, signal: name, exitCode,
        interpretation: "heuristic-win32-high-byte-encoding", confidence: "heuristic",
        caveat: "Windows 无 POSIX 信号；此形状与 MSYS 致命信号编码一致，属推断而非已上报事实"
      };
    }
  }
  return { terminatedBySignal: false, signal: null, exitCode, interpretation: "exit-status" };
}

/* ── 治理执行 ──────────────────────────────────────────────────────── */

function toText(bytes) {
  return Buffer.from(bytes).toString("utf8");
}

/**
 * 端口可以只给原始字节，也可以只给已解码文本。
 * 只有字节才能做编码诊断；只有文本时如实报 not-evaluated，不猜测。
 */
function streamFacts(entry) {
  const truncated = entry.truncated === true;
  const hasBytes = entry.bytes !== undefined && entry.bytes !== null;
  const out = {
    text: hasBytes ? toText(entry.bytes) : String(entry.text === undefined ? "" : entry.text),
    truncated,
    encoding: hasBytes
      ? diagnoseEncoding(entry.bytes, { truncated })
      : { status: "not-evaluated", reason: "端口只提供已解码文本，无法做字节级编码诊断" }
  };
  if (entry.spillPath) out.spillPath = String(entry.spillPath);
  if (entry.totalBytes !== undefined) { out.bytes = entry.totalBytes; out.totalBytes = entry.totalBytes; }
  if (entry.windowOffset !== undefined) out.windowOffset = entry.windowOffset;
  return out;
}

/**
 * 在受管范围内执行一次命令，并保证超时/取消后范围被回收。
 *
 * ports = {
 *   spawn(request) -> Handle
 *   observeSurvivors?(pid) -> [{pid, started, name}]      // 独立观测，用于证明无孤儿
 *   graceMs?: number
 * }
 * Handle = {
 *   pid: number,
 *   done: Promise<{exitCode, signal}>,
 *   output(): { stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated, stdoutSpillPath?, stderrSpillPath? },
 *   terminate(): void|Promise<void>,      // 幂等：开始终止整个受管范围
 *   waitForExit(timeoutMs): Promise<boolean>  // 等范围清空
 * }
 */
export async function runGoverned(request, ports) {
  if (!request || typeof request !== "object") throw new TypeError("request must be an object");
  if (!ports || typeof ports.spawn !== "function") throw new TypeError("ports.spawn is required");
  const req = request;
  const graceMs = Math.max(0, Number(ports.graceMs === undefined ? 3000 : ports.graceMs));
  const timeoutMs = Number(req.timeoutMs === undefined ? 120000 : req.timeoutMs);
  const effective = req.onExpiry === "none" ? 0 : timeoutMs;
  const deadline = fuseDeadline(req.signal, effective, "GOVERNED_TIMEOUT");
  const started = performance.now();
  const diagnostics = { termination: null, survivors: null, cleanup: { terminateCalled: false, waitForExit: null }, timings: {} };
  let handle = null;
  let spawnError = null;
  let settled = null;
  let onAbort;
  const errorText = (error) => String(error?.message || error);
  const cleanupRange = async () => {
    diagnostics.cleanup.terminateCalled = true;
    try { await handle.terminate(); }
    catch (error) { diagnostics.cleanup.terminateError = errorText(error); }
    try { diagnostics.cleanup.waitForExit = await handle.waitForExit(graceMs); }
    catch (error) { diagnostics.cleanup.waitForExitError = errorText(error); }
  };
  // Clear the losing timer: a fast exit must not leave a grace timer alive.
  const boundedOutcome = async (done) => {
    let timer;
    try {
      return await Promise.race([done, new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "still-running" }), graceMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    try {
      if (deadline.signal.aborted) settled = { kind: "not-started" };
      else handle = await ports.spawn({ ...req, signal: deadline.signal, timeoutMs });
    } catch (error) { spawnError = errorText(error); }
    diagnostics.timings.spawnMs = performance.now() - started;
    if (handle) {
      const done = Promise.resolve(handle.done).then(
        (outcome) => ({ kind: "outcome", outcome }),
        (error) => ({ kind: "error", error })
      );
      const deadlineHit = new Promise((resolve) => {
        onAbort = () => resolve({ kind: "deadline" });
        if (deadline.signal.aborted) onAbort();
        else deadline.signal.addEventListener("abort", onAbort, { once: true });
      });
      settled = await Promise.race([done, deadlineHit]);
      // Freeze exit attribution before cleanup so a late deadline cannot turn a
      // completed command into a timeout. Cancellation still wins while waiting.
      diagnostics.completionCause = deadline.cause().reason;
      deadline.dispose();
      if (settled.kind === "deadline" || settled.kind === "error") {
        await cleanupRange();
        if (settled.kind === "deadline") settled = await boundedOutcome(done);
      } else if (typeof handle.waitForExit === "function") {
        try { diagnostics.cleanup.waitForExit = await handle.waitForExit(0); }
        catch (error) { diagnostics.cleanup.waitForExitError = errorText(error); }
        if (diagnostics.cleanup.waitForExit === false) await cleanupRange();
      }
      if (settled.kind === "error") spawnError = errorText(settled.error);
      if (settled.kind === "outcome" && settled.outcome?.error) spawnError = errorText(settled.outcome.error);
      diagnostics.cleanup.scope = handle.scope || "port-managed";
      if (typeof ports.observeSurvivors === "function") {
        try { diagnostics.survivors = await ports.observeSurvivors(handle.pid); }
        catch (error) { diagnostics.survivors = { error: errorText(error) }; }
      }
    }
    const cause = deadline.cause();
    const outcome = settled?.kind === "outcome" ? settled.outcome : null;
    const raw = handle && typeof handle.output === "function" ? await handle.output() : {};
    const streams = {};
    for (const name of ["stdout", "stderr"]) {
      streams[name] = streamFacts({ bytes: raw[name + "Bytes"], text: raw[name + "Text"], truncated: raw[name + "Truncated"], spillPath: raw[name + "SpillPath"], totalBytes: raw[name + "TotalBytes"], windowOffset: raw[name + "WindowOffset"] });
    }
    const reason = spawnError ? "spawn-error" : (diagnostics.completionCause || cause.reason);
    diagnostics.termination = { reason, cause: diagnostics.completionCause || cause.reason, settledKind: settled?.kind || "no-handle", timedOut: reason === "timeout", aborted: reason === "cancelled" };
    diagnostics.exit = describeExit(outcome, request.exitPlatform);
    const survivorCount = Array.isArray(diagnostics.survivors) ? diagnostics.survivors.length : null;
    const rangeEmpty = diagnostics.cleanup.waitForExit;
    const status = survivorCount > 0 || rangeEmpty === false ? "survivors-detected"
      : handle?.scope === "root-only" && survivorCount === null ? "not-evaluated"
      : !diagnostics.cleanup.terminateCalled ? "not-required"
      : survivorCount === 0 ? "clean" : "not-evaluated";
    diagnostics.orphanCheck = { status, survivorCount, rangeEmpty,
      note: status === "clean" ? "终止后独立观测未发现残留"
        : status === "survivors-detected" ? "命令已结束但受管范围内仍有存活进程：治理未达成"
        : status === "not-evaluated" ? "未提供独立观测端口，无法证明受管范围已清空"
        : "本次未触发终止，不适用" };
    return {
      governanceVersion: GOVERNANCE_VERSION,
      ok: status !== "survivors-detected",
      pid: handle ? handle.pid : null,
      outcome: outcome ? { exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null } : { exitCode: null, signal: null },
      streams, timeoutMs, timerArmed: effective > 0, reason, spawnError, diagnostics
    };
  } finally {
    deadline.dispose();
    if (onAbort) deadline.signal.removeEventListener("abort", onAbort);
    if (handle && typeof handle.release === "function") {
      try { await handle.release(); diagnostics.cleanup.released = true; }
      catch (error) { diagnostics.cleanup.releaseError = errorText(error); }
    }
    diagnostics.timings.totalMs = performance.now() - started;
  }
}
