// Test port based on the host's Win32 Job Object primitives.
// 与上一版的关键差别：终止靠作业句柄（Job），不靠 taskkill /T 的父链遍历——
// 实测 MSYS 的 fork 会让 sleep.exe 脱离父链，taskkill /T 杀不掉它。
import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { devNull } from "node:os";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// ── 位置无关地找宿主的 Win32 Job 原语（0.7.4 修）────────────────────────
// ⚠ 这里以前写的是**作者本机的绝对路径**：
//     file:///C:/Users/<打包者>/AppData/Roaming/npm/.../dsh-win32-process/lib/index.js
//   而且是**顶层 await import** ⇒ 别人机器上该 import 直接抛 ⇒ 本模块加载失败 ⇒
//   index.js 的 load('pg-jobport.mjs') 落到 catch ⇒ **每次调用都回「插件运行时模块加载失败」**。
//   工具在工具表里、却完全跑不动——外部用户反馈的"硬编码路径导致不可用"就是这一处。
// 现在改成：多种候选位置依次尝试；**全失败也不抛**，改为降级到 taskkill 路径（见文件底部），
// 保证任何机器上至少能用。
function candidateRoots() {
  const out = [];
  const push = (v) => { if (v && typeof v === "string" && !out.includes(v)) out.push(v); };
  push(process.env.DSH_CHECKOUT);
  if (process.env.APPDATA) push(join(process.env.APPDATA, "npm"));
  // 从宿主入口脚本推导：argv[1] 通常形如 <root>/node_modules/@deepseek-ai/dsh/...
  const argv1 = process.argv && process.argv[1];
  if (argv1) {
    const m = /^(.*)[\\/]node_modules[\\/]@deepseek-ai[\\/]/.exec(argv1);
    if (m) push(m[1]);
  }
  try { push(join(dirname(process.execPath), "node_modules")); } catch { /* ignore */ }
  return out;
}

const REL_WIN32 = join("node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-win32-process", "lib", "index.js");

async function loadWin32() {
  const tried = [];
  try {
    const mod = await import("@deepseek-ai/dsh-win32-process");
    return { mod, via: "bare", tried };
  } catch (e) {
    tried.push("bare:" + String((e && e.code) || (e && e.message) || e).slice(0, 60));
  }
  for (const root of candidateRoots()) {
    try {
      const mod = await import(pathToFileURL(join(root, REL_WIN32)).href);
      return { mod, via: root, tried };
    } catch (e) {
      tried.push(root + ":" + String((e && e.code) || "").slice(0, 24));
    }
  }
  return { mod: null, via: null, tried };
}

const found = await loadWin32();
/** 兼容旧引用：拿不到时为 null，只有 win32 版实现会用到。 */
const win32 = found.mod;
/** 排障/自测开关：置 1 强制走降级路径（验证"没有 win32 原语时仍可用"）。 */
const forceFallback = process.env.DSH_BASH_FORCE_FALLBACK === "1";
/** win32 Job 原语；**拿不到时为 null**（此时走降级实现，而不是让模块挂掉）。 */
export const jobApi = (!forceFallback && found.mod) ? found.mod.loadWin32ProcessBindings() : null;
export const jobPortMode = jobApi ? "win32-job" : "fallback-taskkill";
export const jobPortDiagnostics = { via: found.via, tried: found.tried };
if (found.mod) {
  try { found.mod.probeCurrentTokenJobSupport(jobApi); } catch { /* 诊断用，失败不影响可用性 */ }
}

/** 独立扫描：按命令行特征找进程，与父链无关。 */
export function sweepByCommandLine(marker) {
  const ps = "Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*" + marker + "*') -and ($_.Name -like 'sleep*' -or $_.Name -like 'bash*') } | ForEach-Object { '{\"pid\":' + $_.ProcessId + ',\"ppid\":' + $_.ParentProcessId + ',\"name\":\"' + $_.Name + '\",\"created\":\"' + $_.CreationDate + '\"}' }";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000 });
  const text = (r.stdout || "").trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function createJobPort(options) {
  return jobApi ? createWin32JobPort(options) : createFallbackJobPort(options);
}

function pathFactory(cwd, makePaths) {
  const id = randomUUID();
  let counter = 0;
  return () => {
    const n = ++counter;
    const paths = makePaths ? makePaths(n) : { stdout: join(cwd || process.cwd(), "stdout"), stderr: join(cwd || process.cwd(), "stderr") };
    return { stdout: paths.stdout + "." + id + "." + n + ".stdout", stderr: paths.stderr + "." + id + "." + n + ".stderr" };
  };
}

function withDescriptors(files, action) {
  const fds = [];
  try {
    for (const [file, mode] of files) fds.push(openSync(file, mode));
    return action(fds);
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

export function readOutputWindow(file, maxBytes = 4096) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("output limit must be a nonnegative safe integer");
  return withDescriptors([[file, "r"]], ([fd]) => {
    const totalBytes = fstatSync(fd).size;
    const desired = Math.max(0, totalBytes - limit);
    const start = Math.max(0, desired - 3);
    const buffer = Buffer.alloc(totalBytes - start);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, start + count);
      if (!n) break;
      count += n;
    }
    const data = buffer.subarray(0, count);
    let offset = desired - start;
    // Only trim a boundary continuation if the preceding bytes prove a valid
    // codepoint crossing the cut. Genuine malformed bytes remain diagnostic.
    if (desired > 0 && (data[offset] & 0xc0) === 0x80) {
      for (let i = Math.max(0, offset - 3); i < offset; i += 1) {
        const lead = data[i];
        const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (!length || i + length <= offset || i + length > data.length) continue;
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(i, i + length));
          offset = i + length;
          break;
        } catch { /* preserve invalid bytes */ }
      }
    }
    return { bytes: data.subarray(offset), totalBytes, truncated: desired > 0, spillPath: file, windowOffset: start + offset };
  });
}

function outputReader(paths, request) {
  return () => {
    const out = {};
    for (const name of ["stdout", "stderr"]) {
      const window = readOutputWindow(paths[name], request[name + "MaxBytes"] ?? request.stdoutMaxBytes ?? 4096);
      out[name + "Bytes"] = window.bytes;
      out[name + "Truncated"] = window.truncated;
      out[name + "SpillPath"] = window.spillPath;
      out[name + "TotalBytes"] = window.totalBytes;
      out[name + "WindowOffset"] = window.windowOffset;
    }
    return out;
  };
}

// This fallback cannot prove that detached descendants have exited.
export function createFallbackJobPort({ cwd, makePaths, spawn = nodeSpawn, platform = process.platform, killTimeoutMs = 3000 } = {}) {
  const nextPaths = pathFactory(cwd, makePaths);
  return {
    graceMs: 3000,
    async spawn(request) {
      const paths = nextPaths();
      const child = withDescriptors([[paths.stdout, "wx"], [paths.stderr, "wx"]], ([stdout, stderr]) => spawn(request.command, request.args || [], {
        cwd: request.cwd || cwd, env: { ...process.env, ...(request.env || {}) },
        stdio: ["ignore", stdout, stderr], windowsHide: true
      }));
      let exited = false;
      let released = false;
      let termination;
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const onExit = (code, signal) => { exited = true; resolveDone({ exitCode: typeof code === "number" ? code : undefined, signal: signal || null }); };
      const onError = (error) => { exited = true; resolveDone({ exitCode: undefined, signal: null, error: String(error?.message || error) }); };
      child.once("exit", onExit);
      child.once("error", onError);
      return {
        pid: child.pid, done, scope: "root-only",
        terminate() {
          if (termination) return termination;
          termination = (async () => {
            if (platform === "win32" && Number.isInteger(child.pid) && !exited) {
              await new Promise((resolve, reject) => {
                let killer;
                let timer;
                const finish = (error) => {
                  clearTimeout(timer);
                  if (error) reject(error); else resolve();
                };
                try {
                  killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
                  killer.once("error", finish);
                  killer.once("exit", (code) => finish(code === 0 ? null : new Error("taskkill exit " + code)));
                  timer = setTimeout(() => {
                    try { killer.kill("SIGKILL"); } catch { /* owned helper only */ }
                    killer.unref?.();
                    finish(new Error("taskkill timed out"));
                  }, killTimeoutMs);
                } catch (error) { finish(error); }
              }).finally(() => { if (!exited) child.kill("SIGKILL"); });
            } else if (!exited) child.kill("SIGKILL");
          })();
          return termination;
        },
        async waitForExit(ms) {
          const until = Date.now() + Math.max(0, Number(ms));
          while (!exited && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(40, until - Date.now())));
          return exited;
        },
        release() {
          if (released) return;
          released = true;
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
          // A still-running owned process remains diagnosable but cannot keep
          // the caller's event loop alive after a failed bounded cleanup.
          child.unref?.();
        },
        output: outputReader(paths, request)
      };
    }
  };
}

export function createWin32JobPort({ cwd, makePaths, bindings = win32, api = jobApi } = {}) {
  const nextPaths = pathFactory(cwd, makePaths);
  return {
    async spawn(request) {
      const paths = nextPaths();
      const spawned = withDescriptors([[devNull, "r"], [paths.stdout, "wx"], [paths.stderr, "wx"]], ([stdin, stdout, stderr]) => bindings.spawnCurrentTokenJobProcess(api, {
        command: request.command, applicationName: request.command, args: request.args || [],
        cwd: request.cwd || cwd, env: { ...process.env, ...(request.env || {}) },
        stdio: { stdin, stdout, stderr }
      }));
      let released = false;
      let timer;
      let finishDone;
      const done = new Promise((resolve, reject) => {
        finishDone = resolve;
        const poll = () => {
          if (released) return;
          try {
            const code = bindings.pollProcessExit(api, spawned.process);
            if (code !== undefined) return resolve({ exitCode: code, signal: null });
            timer = setTimeout(poll, 40);
          } catch (error) { reject(error); }
        };
        poll();
      });
      // Attach immediately: a native poll error may arrive before governance
      // receives the handle and installs its own rejection handler.
      done.catch(() => {});
      return {
        pid: spawned.pid, job: spawned.job, done, scope: "job",
        terminate() { bindings.terminateJob(api, spawned.job, 1); },
        async waitForExit(ms) {
          const until = Date.now() + Math.max(0, Number(ms));
          for (;;) {
            if (bindings.isJobEmpty(api, spawned.job)) return true;
            if (Date.now() >= until) return false;
            await new Promise((resolve) => setTimeout(resolve, Math.min(40, until - Date.now())));
          }
        },
        jobEmpty() { return bindings.isJobEmpty(api, spawned.job); },
        release() {
          if (released) return;
          released = true;
          clearTimeout(timer);
          finishDone({ exitCode: undefined, signal: null });
          const errors = [];
          for (const [handle, label] of [[spawned.process, "governed-process"], [spawned.job, "governed-job"]]) {
            try { bindings.closeHandleChecked(api, handle, label); } catch (error) { errors.push(error); }
          }
          if (errors.length) throw new AggregateError(errors, "failed to release governed handles");
        },
        output: outputReader(paths, request)
      };
    }
  };
}
