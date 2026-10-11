#!/usr/bin/env node
/**
 * webview-cdp-relay.test.mjs — 中继的集成测试（零依赖，可在 CI 上跑）。
 *
 * 为什么必须有它：中继是「应用 WebView ⇄ ego-browser」之间唯一的一层，它踩过的坑
 * 全都是**静默**失败（不报错、只是永远超时），光看源码看不出来：
 *
 *   1. WebView 的 /json/version 返回的 webSocketDebuggerUrl **不带端口**
 *      （"ws://127.0.0.1/devtools/browser"）。不改写就永远连不上。
 *   2. WebView 会接受 `permessage-deflate`，之后所有帧都带 RSV1 压缩位。
 *      中继不实现 deflate，一旦协商成功就读不懂自己的回包（实测表现为
 *      Target.createTarget 永远超时）。所以中继必须**剥掉压缩协商**。
 *   3. WebView 的 Target.createTarget 恒返回 "Not supported"，必须在中继层
 *      改写成页面侧 window.open。
 *   4. 真机实测：宿主**未**开多窗口时，对页面 window.open(url,"_blank") 不会失败，
 *      而是把**当前页**导航走（把用户的 dsh GUI 导航成了 about:blank）。
 *      所以「只有用户页时」必须拒绝，除非显式声明宿主已开多窗口。
 *
 * 本测试用一个**仿造的 WebView socket** 复现上面 1/2/3/4 的行为，然后断言中继的
 * 对外表现。它不需要 Android、不需要浏览器，只用到 Node 的抽象 socket（Linux）。
 *
 * 用法：node tools/webview-cdp-relay.test.mjs
 * 退出码：0 = 全通过，1 = 有断言失败。
 */
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const RELAY = new URL("../app/src/main/assets/webview-cdp-relay.mjs", import.meta.url).pathname;
// 环境变量不能带 NUL，用 "@" 前缀表示抽象 socket（见中继里的同名处理）。
const SOCKET = "@webview_devtools_relay_test";
const SOCKET_PATH = "\0webview_devtools_relay_test";
// 端口要真的空闲：硬编码端口会让上一次失败残留的中继占住它，新中继
// EADDRINUSE 直接退出，而客户端连到旧进程 —— 表现为「测试莫名挂死」。
// 本轮真踩过两次，所以这里向内核要一个空闲端口。
async function getFreePort() {
  return await new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}
const RELAY_PORT = await getFreePort();

/** 所有子进程都要登记，任何退出路径都得收掉，否则测试进程会漏。 */
const children = new Set();
function killChildren() {
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch {}
  }
  children.clear();
}
process.on("exit", killChildren);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { killChildren(); process.exit(1); });
}
const GUI_URL = "http://127.0.0.1:3080/";

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    failures += 1;
    console.log("  ✗ " + name + (detail ? "  -> " + detail : ""));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ WS 编解码 */

function encodeFrame(payload, opcode, maskKey) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let b1;
  let ext;
  if (len < 126) { b1 = len; ext = Buffer.alloc(0); }
  else if (len < 65536) { b1 = 126; ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { b1 = 127; ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (maskKey) b1 |= 0x80;
  const head = Buffer.concat([Buffer.from([0x80 | opcode, b1]), ext]);
  if (!maskKey) return Buffer.concat([head, data]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i & 3];
  return Buffer.concat([head, maskKey, masked]);
}

function parseFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv1 = (b0 & 0x40) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let key = null;
    if (masked) { if (buf.length - p < 4) break; key = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (masked) { const o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ key[i & 3]; payload = o; }
    frames.push({ fin, rsv1, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/* --------------------------------------------------- 仿造的 WebView */

/** 记录中继发给上游的每一条 CDP 请求（用来断言拦截生效）。 */
const upstreamMethods = [];
let sawExtensionsOffer = false;
let sawExtensionsAcceptSent = false;

const targets = [
  { targetId: "GUI_TARGET", type: "page", url: GUI_URL, title: "DSH GUI" },
];

function handleCdp(conn, msg) {
  upstreamMethods.push(msg.method);
  const reply = (result) =>
    conn.write(encodeFrame(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }), 0x1, null));

  switch (msg.method) {
    case "Target.getTargets":
      return reply({ targetInfos: targets.map((t) => ({ ...t })) });
    case "Target.attachToTarget":
      return reply({ sessionId: "SESS_1" });
    case "Runtime.evaluate":
      // 仿造「宿主 onCreateWindow 接住了这次 open」：随即多出一个 page target。
      reply({ result: { type: "number", value: 1 } });
      if (!targets.some((t) => t.targetId === "NEW_TARGET")) {
        setTimeout(() => targets.push({
          targetId: "NEW_TARGET", type: "page", url: "https://example.com/", title: "Example",
        }), 40);
      }
      return undefined;
    case "Page.navigate":
      return reply({ frameId: "F1" });
    case "Browser.getVersion":
      return reply({ protocolVersion: "1.3", product: "Chrome/153.0.8010.36" });
    default:
      return reply({});
  }
}

const upstream = net.createServer((conn) => {
  // ⚠️ 必须支持 keep-alive：Node 的 fetch（undici）会在同一 origin 上复用连接池，
  //    WebSocket 升级可能落到一条**已经发过 HTTP 请求**的连接上。早先这里用
  //    conn.once("data")，第二条请求就没人读了 —— 表现为 WS 握手永远不回来，
  //    看上去像中继的 bug，其实是仿造服务不真。
  let pending = Buffer.alloc(0);
  let upgraded = false;
  conn.on("data", (chunk) => {
    if (upgraded) return; // 升级后由下面的帧循环接管
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) break;
      const head = pending.subarray(0, end + 4).toString("latin1");
      const rest = pending.subarray(end + 4);
      pending = Buffer.alloc(0);
      handleRequest(conn, head, rest);
      // 升级请求之后这条连接就归帧循环了
      if (/upgrade: websocket/i.test(head)) { upgraded = true; return; }
      // 响应是同步写出的，所以这里可以继续处理下一条（keep-alive 管线化）。
    }
  });
  conn.on("error", () => {});
});

function handleRequest(conn, head, rest) {

    // 真机行为 2：只有客户端**提出** permessage-deflate 时 WebView 才接受它。
    if (/sec-websocket-extensions:\s*permessage-deflate/i.test(head)) sawExtensionsOffer = true;

    if (head.startsWith("GET /json/version")) {
      // 真机行为 1：webSocketDebuggerUrl 不带端口。
      const body = JSON.stringify({
        "Android-Package": "com.dsh.test",
        Browser: "Chrome/153.0.8010.36",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser",
      });
      conn.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n" +
          "Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body,
      );
      return;
    }
    if (head.startsWith("GET /json/list")) {
      const body = JSON.stringify(targets);
      conn.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n" +
          "Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body,
      );
      return;
    }
    if (/upgrade: websocket/i.test(head)) {
      // 真服务（含 Android WebView）一定会回 Sec-WebSocket-Accept：Node 的
      // WebSocket 客户端会校验它，缺了握手就失败。这里按 RFC 6455 算出来。
      const key = (/sec-websocket-key:\s*(\S+)/i.exec(head) || [])[1] || "";
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      // 真机行为 2：协商成功时会把 accept 回给客户端，并从此压缩所有帧。
      let resp =
        "HTTP/1.1 101 WebSocket Protocol Handshake\r\n" +
        "Upgrade: WebSocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n";
      if (sawExtensionsOffer) {
        sawExtensionsAcceptSent = true;
        resp += "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=15\r\n";
      }
      conn.write(resp + "\r\n");

      let buf = rest;
      const drain = () => {
        const { frames, rest: left } = parseFrames(buf);
        buf = left;
        for (const f of frames) {
          if (f.opcode === 0x1) { try { handleCdp(conn, JSON.parse(f.payload.toString("utf8"))); } catch {} }
        }
      };
      if (buf.length) drain();
      conn.on("data", (d) => { buf = Buffer.concat([buf, d]); drain(); });
      return;
    }
    conn.end();
}

/* --------------------------------------------------------------- 运行 */

function startRelay(extraEnv) {
  const home = mkdtempSync(join(tmpdir(), "relay-home-"));
  const child = spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      HOME: home,
      EGO_LINUX_WEBVIEW_SOCKET: SOCKET,
      EGO_LINUX_WEBVIEW_RELAY_PORT: String(RELAY_PORT),
      EGO_LINUX_WEBVIEW_CREATE_TIMEOUT_MS: "3000",
      RELAY_DEBUG: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  children.add(child);
  return { child, home, output: () => out };
}

async function waitForRelay(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + RELAY_PORT + "/json/version", { signal: AbortSignal.timeout(600) });
      if (r.ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + RELAY_PORT + "/devtools/browser");
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("client ws failed"));
  });
}

function makeCaller(ws) {
  let n = 1;
  const pend = new Map();
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  return (method, params = {}, ms = 12000) => {
    const id = n++;
    return new Promise((r) => {
      const t = setTimeout(() => r({ error: { message: "client timeout" } }), ms);
      pend.set(id, (m) => { clearTimeout(t); r(m); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function main() {
  await new Promise((r) => upstream.listen(SOCKET_PATH, r));

  // ── 阶段一：未声明多窗口 —— 必须拒绝，绝不牺牲用户页 ──────────────────
  console.log("\n[1] 未开启多窗口（默认）：只有用户页时必须拒绝新建");
  let relay = startRelay({});
  if (!(await waitForRelay())) throw new Error("relay did not start: " + relay.output());
  check("relay 启动并响应 /json/version", true);

  const ver = await (await fetch("http://127.0.0.1:" + RELAY_PORT + "/json/version")).json();
  check(
    "/json/version 的 webSocketDebuggerUrl 被改写成带端口",
    ver.webSocketDebuggerUrl === "ws://127.0.0.1:" + RELAY_PORT + "/devtools/browser",
    JSON.stringify(ver.webSocketDebuggerUrl),
  );

  // 断言只看本阶段的流量：两个标志在阶段一开始时归零。
  sawExtensionsOffer = false;
  sawExtensionsAcceptSent = false;
  console.log("  .. connecting client WebSocket");
  let ws;
  try {
    ws = await Promise.race([
      connectClient(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("connectClient timeout")), 8000)),
    ]);
  } catch (e) {
    console.log("  connectClient failed: " + e.message);
    console.log("--- relay output ---\n" + relay.output());
    throw e;
  }
  check("客户端 WebSocket 握手成功", true);
  check("中继剥掉了 permessage-deflate 报价（上游没收到 extensions 请求头）", sawExtensionsOffer === false);
  check("上游因此没有回 accept（帧保持未压缩）", sawExtensionsAcceptSent === false);

  let call = makeCaller(ws);
  let r = await call("Browser.getVersion");
  check("浏览器级调用通（Browser.getVersion）", r.result && /Chrome/.test(r.result.product), JSON.stringify(r).slice(0, 120));

  r = await call("Target.getTargets");
  const pages = (r.result.targetInfos || []).filter((t) => t.type === "page");
  check("能列出 1 个页面（用户 GUI）", pages.length === 1 && pages[0].url === GUI_URL, JSON.stringify(pages));

  const guiTargetId = pages[0].targetId;
  const beforeMethods = upstreamMethods.length;
  r = await call("Target.createTarget", { url: "about:blank" });
  check("未开多窗口时 createTarget 被拒绝（有 error）", !!r.error, JSON.stringify(r).slice(0, 160));
  check(
    "拒绝理由指向多窗口（而不是默默导航用户页）",
    !!r.error && /multi-window|setSupportMultipleWindows/i.test(r.error.message),
    r.error && r.error.message,
  );
  check(
    "createTarget 没有被转发给上游（上游从未收到它）",
    !upstreamMethods.slice(beforeMethods).includes("Target.createTarget"),
    JSON.stringify(upstreamMethods.slice(beforeMethods)),
  );

  // 关键：用户页没有被导航走
  r = await call("Target.getTargets");
  const guiNow = (r.result.targetInfos || []).find((t) => t.targetId === guiTargetId);
  check("用户 GUI 页 URL 未变（没被导航走）", guiNow && guiNow.url === GUI_URL, guiNow && guiNow.url);

  // 本地 PUT /json/new 也应被拒绝而不是砸坏用户页
  const newRes = await fetch("http://127.0.0.1:" + RELAY_PORT + "/json/new?url=about:blank", { method: "PUT" });
  check("PUT /json/new 被本地接住且返回失败（未毁用户页）", newRes.status === 500, String(newRes.status));
  r = await call("Target.getTargets");
  const guiStill = (r.result.targetInfos || []).find((t) => t.targetId === guiTargetId);
  check("PUT /json/new 之后用户 GUI 仍在原处", guiStill && guiStill.url === GUI_URL, guiStill && guiStill.url);

  ws.close();
  relay.child.kill("SIGKILL");
  children.delete(relay.child);

  // ── 阶段二：声明已开多窗口 —— 必须真的造出新页，且用户页不动 ──────────
  console.log("\n[2] 宿主声明已开多窗口：createTarget 必须造出新 page 且不动用户页");
  relay = startRelay({ EGO_LINUX_WEBVIEW_MULTIWINDOW: "1" });
  if (!(await waitForRelay())) throw new Error("relay(2) did not start: " + relay.output());

  ws = await connectClient();
  call = makeCaller(ws);
  const guiBefore = (await call("Target.getTargets")).result.targetInfos.find((t) => t.url === GUI_URL);
  const r2 = await call("Target.createTarget", { url: "https://example.com/" });
  check("createTarget 成功并回了一个 targetId", !!(r2.result && r2.result.targetId), JSON.stringify(r2).slice(0, 180));
  check(
    "拿到的不是用户页的 targetId（是新页）",
    !!(r2.result && r2.result.targetId && r2.result.targetId !== guiBefore.targetId),
    r2.result && r2.result.targetId,
  );

  const after = (await call("Target.getTargets")).result.targetInfos.filter((t) => t.type === "page");
  check("页面数从 1 变成 2", after.length === 2, "n=" + after.length);
  const guiAfter = after.find((t) => t.targetId === guiBefore.targetId);
  check("用户 GUI 页在新建后被保留且 URL 未变", guiAfter && guiAfter.url === GUI_URL, guiAfter && guiAfter.url);

  ws.close();
  relay.child.kill("SIGKILL");
  children.delete(relay.child);
  await sleep(150);
  await new Promise((r) => upstream.close(r));
  rmSync(relay.home, { recursive: true, force: true });

  console.log("\n" + (failures === 0 ? "webview-cdp-relay: 全部通过" : "webview-cdp-relay: " + failures + " 项失败"));
  process.exit(failures === 0 ? 0 : 1);
}

// 看门狗：任何一个阶段卡住都要报出来并落盘，而不是静默挂死（CI 里挂死最难查）。
const WATCHDOG_MS = 45000;
const watchdog = setTimeout(() => {
  console.error("FATAL watchdog: 测试在 " + WATCHDOG_MS + "ms 内没有进展");
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main().catch((e) => {
  console.error("FATAL " + (e && e.stack ? e.stack : e));
  killChildren();
  process.exit(1);
});
