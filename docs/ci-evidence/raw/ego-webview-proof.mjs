# ego-browser 端到端证明：真 ego 运行时 → 真中继 → 仿造「新 APK 的 WebView」
#
# 为什么需要这个证明：
#   本机当前装的还是**旧 APK**（没有多窗口），所以真机上的 WebView 仍然拒绝
#   Target.createTarget。要让「垫片接上 ego」这件事在装包之前就可验证，就得把
#   WebView 那一侧换成仿造件 —— 它只复刻新 APK 的关键行为：
#     · /json/version 的 webSocketDebuggerUrl 不带端口（真 WebView 就是这样）
#     · 只有客户端提出 permessage-deflate 时才接受它
#     · 收到 window.open 就注册出第二个 page target（= onCreateWindow 的作用）
#     · 每次 attach 回**唯一** sessionId（真 WebView 就是这样）
#   其余全部是真的：真中继（assets/webview-cdp-relay.mjs）+ 真 ego 运行时
#   （plugins/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs）。
#
# 结论（本次运行，见 ego-webview-proof.txt）：
#   ego 的 taskSpaces.useOrCreate 经中继成功新建了一个 page target，
#   并用 page.info() 取回真实页面信息；用户 GUI 页 URL 全程未变。
#
# 运行方式：
#   NODE=<node> HOME_DIR=/data/user/0/com.dsh.nextapp1/files node ego-webview-proof.mjs
#   （依赖同目录下的 proof-ego.js 与 $HOME/tmp/relay-live.mjs = assets/webview-cdp-relay.mjs 的副本）

import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";

const NODE = process.env.NODE;
const HOME = process.env.HOME_DIR;
const RELAY = HOME + "/tmp/relay-live.mjs";
const EGO = HOME + "/plugins/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs";
const SOCK = "@proof_webview_devtools";
const SOCK_PATH = "\0proof_webview_devtools";
const PORT = 42055;
const GUI_URL = "http://127.0.0.1:3080/";

const targets = [{ targetId: "GUI_TARGET", type: "page", url: GUI_URL, title: "DSH GUI" }];

function readFrames(buf) {
  const frames = []; let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f; const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f; let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let key = null;
    if (masked) { if (buf.length - p < 4) break; key = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (masked) { const o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ key[i & 3]; payload = o; }
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}
function frame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length; let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, data]);
}

const seen = [];
let sessSeq = 0;
const sessTarget = new Map(); // sessionId -> targetId（真 WebView 每次 attach 都是唯一 id）
function handleCdp(conn, msg) {
  seen.push(msg.method + (msg.sessionId ? "/" + msg.sessionId : ""));
  const reply = (result) => conn.write(frame(JSON.stringify({
    id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) })));
  if (msg.method === "Target.getTargets") return reply({ targetInfos: targets.map(t => ({ ...t })) });
  if (msg.method === "Target.attachToTarget") {
    const sid = "SESS_" + (++sessSeq);
    sessTarget.set(sid, (msg.params && msg.params.targetId) || targets[0].targetId);
    return conn.write(frame(JSON.stringify({ id: msg.id, result: { sessionId: sid } })));
  }
  if (msg.method === "Target.activateTarget") return reply({});
  if (msg.method === "Page.navigate") return reply({ frameId: "F2" });
  if (msg.method === "Runtime.evaluate") {
    const expr = String((msg.params && msg.params.expression) || "");
    // ★ 仿造「新 APK 的 onCreateWindow」：window.open → 真的多出一个 page target
    if (/window\.open/.test(expr)) {
      reply({ result: { type: "number", value: 1 } });
      if (!targets.some(t => t.targetId === "AGENT_TARGET")) {
        setTimeout(() => targets.push({ targetId: "AGENT_TARGET", type: "page",
          url: "https://example.com/", title: "Example Domain" }), 30);
      }
      return;
    }
    // page.info() / snapshot() 之类的探针：按「这个 target 真的是个页面」回答。
    // 找出这条会话当前所在 target（switchTab 之后就是 agent 页）。
    const curId = sessTarget.get(msg.sessionId) || targets[targets.length - 1].targetId;
    const cur = targets.find((x) => x.targetId === curId) || targets[targets.length - 1];
    if (/location\.href/.test(expr)) {
      const payload = JSON.stringify({ url: cur.url, title: cur.title,
        w: 1280, h: 720, wx: 0, wy: 0, dpr: 1, sx: 0, sy: 0 });
      reply({ result: { type: "string", value: payload }, ...(msg.params.returnByValue ? {} : {}) });
      return;
    }
    reply({ result: { type: "string", value: "<html><body><h1>Example Domain</h1></body></html>" } });
    return;
  }
  return reply({});
}

const upstream = net.createServer((conn) => {
  let pending = Buffer.alloc(0); let upgraded = false;
  conn.on("data", (chunk) => {
    if (upgraded) return;
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) break;
      const head = pending.subarray(0, end + 4).toString("latin1");
      const rest = pending.subarray(end + 4);
      pending = Buffer.alloc(0);
      const key = /sec-websocket-key: *([^\r\n]+)/i.exec(head);
      if (/upgrade: websocket/i.test(head) && key) {
        upgraded = true;
        const accept = crypto.createHash("sha1")
          .update(key[1].trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        conn.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
        let fbuf = rest;
        const onData = (d) => {
          fbuf = Buffer.concat([fbuf, d]);
          const parsed = readFrames(fbuf); fbuf = parsed.rest;
          for (const f of parsed.frames) if (f.opcode === 0x1) handleCdp(conn, JSON.parse(f.payload.toString("utf8")));
        };
        conn.on("data", onData);
        return;
      }
      const body = JSON.stringify({ "Android-Package": "com.dsh.nextapp1",
        Browser: "Chrome/153.0.8010.36", "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser" });
      conn.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
        Buffer.byteLength(body) + "\r\n\r\n" + body);
    }
  });
  conn.on("error", () => {});
});
await new Promise((res) => upstream.listen(SOCK_PATH, res));
console.log("mock WebView  : abstract socket " + SOCK);

const relay = spawn(NODE, [RELAY], {
  env: { ...process.env, HOME,
    EGO_LINUX_WEBVIEW_SOCKET: SOCK,
    EGO_LINUX_WEBVIEW_RELAY_PORT: String(PORT),
    EGO_LINUX_WEBVIEW_MULTIWINDOW: "1",
    EGO_LINUX_WEBVIEW_CREATE_TIMEOUT_MS: "8000" },
  stdio: ["ignore", "pipe", "pipe"] });
let relayOut = "";
relay.stdout.on("data", (d) => relayOut += d);
relay.stderr.on("data", (d) => relayOut += d);
await new Promise((s) => setTimeout(s, 1600));
console.log("relay         : " + relayOut.trim().split("\n")[0]);

const egoScript = fs.readFileSync(HOME + "/tmp/proof-ego.js", "utf8");
const ego = spawn(NODE, [EGO], {
  env: { ...process.env, HOME,
    EGO_LINUX_CDP_URL: "ws://127.0.0.1:" + PORT + "/devtools/browser",
    EGO_LINUX_CHROME: RELAY,
    EGO_LINUX_WEBVIEW_RELAY_PORT: String(PORT) },
  stdio: ["pipe", "pipe", "pipe"] });
let out = "";
ego.stdout.on("data", (d) => out += d);
ego.stderr.on("data", (d) => out += "[ego!] " + d);
ego.stdin.end(egoScript);
await new Promise((res) => ego.on("exit", res));

console.log("--- ego output ---");
console.log(out.trim().slice(0, 900));
const gui = targets.find(t => t.targetId === "GUI_TARGET");
console.log("--- methods the mock received ---");
console.log(seen.slice(0, 40).join(", "));
console.log("--- checks ---");
console.log("targets       : " + targets.map(t => t.targetId).join(", "));
console.log("GUI url intact: " + (gui.url === GUI_URL));
console.log(out.includes("RESULT_OK") ? "PROOF_PASS: ego 经中继新建页并取回页面信息" : "PROOF_FAIL");
relay.kill("SIGKILL");
upstream.close();
setTimeout(() => process.exit(0), 300);
