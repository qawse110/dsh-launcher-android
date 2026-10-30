
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

const NODE = process.env.NODE;
const HOME = process.env.HOME_DIR;
const RELAY = HOME + "/tmp/relay-live.mjs";
const EGO = HOME + "/plugins/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs";
const PORT = 42077;
const GUI_URL = "http://127.0.0.1:3080/";

function cdp(port, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, method, params: params || {} });
    const req = http.request({ host: "127.0.0.1", port, path: "/json/protocol", method: "GET" }, () => {});
    req.on("error", reject); req.end();
  });
}
// 直接用 /json/list 读 target 列表（中继本地接住，最轻量）
function listTargets(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/json/list", method: "GET" }, (res) => {
      let b = ""; res.on("data", (d) => b += d); res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null)); req.end();
  });
}

const relay = spawn(NODE, [RELAY], {
  env: { ...process.env, HOME, EGO_LINUX_WEBVIEW_RELAY_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"] });
relay.stdout.on("data", () => {});
await new Promise((s) => setTimeout(s, 1500));

const samples = [];
let stop = false;
const sampler = (async () => {
  while (!stop) {
    const t = await listTargets(PORT);
    const pages = Array.isArray(t) ? t.filter((x) => x.type === "page") : [];
    samples.push({ at: Date.now(), pages: pages.map((p) => ({ id: p.id, url: p.url, title: p.title })) });
    await new Promise((s) => setTimeout(s, 80));
  }
})();

// 触发一次 useOrCreate（会走 openTarget → pickOpener 拒绝，或 window.open）
const egoScript =
  'try { await taskSpaces.useOrCreate({ name: "disc", url: "https://example.com/" });' +
  ' console.log("OUTCOME success"); } catch (e) {' +
  ' console.log("OUTCOME refusal " + String((e && e.message) || e).slice(0,120)); }\n';
const _fs = await import("node:fs");
_fs.writeFileSync(HOME + "/tmp/disc-ego.js", egoScript);

const ego = spawn(NODE, [EGO], {
  env: { ...process.env, HOME,
    EGO_LINUX_CDP_URL: "ws://127.0.0.1:" + PORT + "/devtools/browser",
    EGO_LINUX_CHROME: RELAY, EGO_LINUX_WEBVIEW_RELAY_PORT: String(PORT) },
  stdio: ["pipe", "pipe", "pipe"] });
let out = "";
ego.stdout.on("data", (d) => out += d);
ego.stderr.on("data", (d) => out += "[ego!] " + d);
ego.stdin.end(egoScript);
await new Promise((res) => ego.on("exit", res));
await new Promise((s) => setTimeout(s, 400));
stop = true; await sampler;

console.log("ego: " + out.trim().split("\n").find((l) => l.startsWith("OUTCOME")));
console.log("samples: " + samples.length + " (约每 80ms 一次)");
// 找任何一条「GUI 页 url 不是原 url」的采样
let anomalies = [];
let guiId = null;
let sawAgentPage = false;
for (const s of samples) {
  for (const p of s.pages) {
    if (p.url && p.url.includes(":3080")) guiId = p.id;
  }
}
for (const s of samples) {
  for (const p of s.pages) {
    if (guiId && p.id === guiId && p.url !== GUI_URL) anomalies.push(s.at + " " + p.url);
  }
}
const final = samples[samples.length - 1];
console.log("GUI target id   : " + guiId);
console.log("final targets   : " + JSON.stringify(final.pages.map(p => p.url)));
console.log("anomalous states: " + (anomalies.length ? anomalies.join(" | ") : "NONE"));
console.log(anomalies.length ? "VERDICT: GUI 曾被导航走（先损伤后还原）" : "VERDICT: GUI 全程未被导航（判别通过）");
relay.kill("SIGKILL");
process.exit(0);
