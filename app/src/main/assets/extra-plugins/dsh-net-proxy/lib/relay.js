// lib/relay.js — 本地回环 HTTP 代理中继（127.0.0.1 随机端口）
//
// 用途（两个）：
//   1) 可观测性：harness 的 web_fetch 走 @deepseek-ai/dsh-http-proxy 的 undici
//      ProxyAgent，流量完全不经过插件代码。把 harness 层的代理指向本中继后，
//      web_fetch 的每条请求都过插件之手：CONNECT 隧道记录目标与双向字节（TLS
//      内容加密不可见，如实标注）；明文 http 记录完整请求行/头/响应与体预览。
//   2) 协议桥接：dsh-http-proxy 只接受 http: 代理 URL。中继把 CONNECT/明文请求
//      桥接到真正的上游代理（HTTP 或 SOCKS5），使 SOCKS5 配置也能覆盖 web_fetch。
//
// 安全与语义边界：
//   - 只监听 127.0.0.1，插件停用/卸载即关闭；与用户自建回环代理同级（无鉴权）。
//   - 响应一律以 Connection: close 收尾（每个请求一条客户端连接，实现简单且
//     undici 会正确服从），上游侧按 CL/chunked/EOF 精确切分后透传。
//   - 纯字节转发不改写业务头（除连接管理与代理鉴权外），不缓存、不落盘。
import net from "node:net";
import { ByteStream, connectProxy, httpConnect, socksConnect } from "./proxy/conn.js";
import { ProxyError } from "./proxy/errors.js";
import { MAX_HEADERS } from "./proxy/http11.js";

const MAX_RELAY_BODY = 1024 * 1024; // 明文转发时缓冲的请求体上限（1MB；web_fetch 请求体都很小，超限拒发防内存被大请求拖垮）
const HEAD_IDLE_MS = 30000;              // 头读取阶段空闲超时（隧道建立后不再限时）

function writeSimple(sock, code, text) {
  const reason = { 400: "Bad Request", 502: "Bad Gateway", 507: "Proxy Disabled" }[code] || "Error";
  try { sock.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  void text;
}

function headerLines(h) {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n";
}

function stripHop(h) {
  const out = { ...h };
  delete out["proxy-connection"];
  delete out["proxy-authorization"];
  delete out["keep-alive"];
  out["connection"] = "close";
  return out;
}

/** 双向转发并计数（onBytes 口径：from → to 方向的字节数）。 */
function pipeCount(from, to, onBytes) {
  from.on("data", (c) => {
    if (onBytes) onBytes(c.length);
    if (!to.write(c)) from.pause();
  });
  to.on("drain", () => from.resume());
  const kill = () => { try { from.destroy(); } catch {} try { to.destroy(); } catch {} };
  from.once("end", () => { try { to.end(); } catch {} });
  from.once("error", kill);
  to.once("error", kill);
  from.once("close", kill);
  to.once("close", kill);
}

/**
 * 创建本地中继。
 * @param opts.log      流量日志器（可选；createTrafficLog 实例）
 * @param opts.getProxy 每条连接实时取当前生效代理（toProxy 形状或 null=停用）
 * @param opts.timeoutMs 上游握手/连接超时
 */
export function createRelay({ log, getProxy, timeoutMs = 60000, report } = {}) {
  let server = null;
  let listening = false;
  let port = null;
  const conns = new Set();

  const isSocks = (p) => p && (p.protocol === "socks5" || p.protocol === "socks");
  const tunnelVia = (p, host, portNum) =>
    isSocks(p) ? socksConnect(p, host, portNum, null, timeoutMs) : httpConnect(p, host, portNum, null, timeoutMs);

  // ── CONNECT 隧道（https 目标；TLS 内容不可见，只记目标与字节数）──
  async function handleConnect(csock, firstLine, stream, headTimer) {
    const m = /^CONNECT\s+([^\s]+)\s+HTTP\/\d/i.exec(firstLine);
    const target = m ? m[1] : "";
    const entry = log ? log.begin({ kind: "relay-tunnel", method: "CONNECT", url: `connect://${target}` }) : null;
    try {
      let up = Buffer.byteLength(firstLine, "latin1") + 2;
      for (let n = 0; ; n++) {
        if (n > MAX_HEADERS) throw ProxyError("EHEADER", "too many CONNECT request headers");
        const line = await stream.readLine();
        up += line.length + 2;
        if (line === "") break;
      }
      if (headTimer) clearTimeout(headTimer); // 头阶段结束：隧道可长期静默，不再限时
      const ci = target.lastIndexOf(":");
      if (!target || ci === -1) throw ProxyError("EPROTO", `bad CONNECT target: ${target}`);
      const host = target.slice(0, ci).replace(/^\[|\]$/g, "");
      const portNum = Number(target.slice(ci + 1));
      const p = getProxy();
      if (!p) { writeSimple(csock, 507); if (entry) entry.finalize(new Error("proxy disabled")); return; }
      if (entry) entry.addUp(up);
      let upstream;
      try {
        upstream = await tunnelVia(p, host, portNum);
      } catch (e) {
        writeSimple(csock, 502);
        if (entry) entry.finalize(e);
        return;
      }
      const ok = "HTTP/1.1 200 Connection established\r\n\r\n";
      csock.write(ok);
      if (entry) {
        entry.addDown(Buffer.byteLength(ok));
        entry.setResponse(200);
        entry.setRequestPreview(Buffer.from(`<TLS 隧道 ${target}：内容加密，仅计流量>`));
      }
      pipeCount(csock, upstream, (n) => entry && entry.addUp(n));
      pipeCount(upstream, csock, (n) => entry && entry.addDown(n));
      // 任一侧关闭 → 收尾（双向都已 pipeCount，close 事件互毁）
      const done = () => { if (entry) entry.finalize(); };
      csock.once("close", done);
      upstream.once("close", done);
    } catch (e) {
      writeSimple(csock, 502);
      if (entry) entry.finalize(e);
    }
  }

  // ── 明文 http（absolute-form）：完整记录请求/响应与体预览 ──
  async function handleHttp(csock, firstLine, stream, headTimer) {
    const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/\d/i.exec(firstLine);
    const method = m ? m[1].toUpperCase() : "GET";
    const rawUrl = m ? m[2] : "";
    const entry = log ? log.begin({ kind: "relay-http", method, url: rawUrl }) : null;
    let up2 = null;
    // 客户端提前断开 → 摧毁上游，让本协程从任何 await 点立刻醒来收尾
    //（否则 writeChunk 的 await drain 永不兑现，上游连接与日志 live 记录双双泄漏）。
    // 须定义在 try 外：catch 分支也要用它解绑监听器。
    let gone = false;
    const onGone = () => { gone = true; try { up2.destroy(); } catch {} };
    try {
      if (!m || !/^[a-z]+:\/\//i.test(rawUrl)) throw ProxyError("EPROTO", `relay expects absolute-form request, got: ${firstLine.slice(0, 120)}`);
      const u = new URL(rawUrl);
      const headers = {};
      let up = Buffer.byteLength(firstLine, "latin1") + 2;
      for (let n = 0; ; n++) {
        if (n > MAX_HEADERS) throw ProxyError("EHEADER", "too many request headers");
        const line = await stream.readLine();
        up += line.length + 2;
        if (line === "") break;
        const ci = line.indexOf(":");
        if (ci !== -1) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
      }
      if (headTimer) clearTimeout(headTimer); // 头阶段结束
      // 请求体：CL 或 chunked；缓冲上限 MAX_RELAY_BODY（web_fetch 的请求体都很小）
      let reqBody = null;
      const te = (headers["transfer-encoding"] || "").toLowerCase();
      const cl = Number(headers["content-length"]);
      if (te.includes("chunked")) {
        const parts = [];
        let total = 0;
        for (;;) {
          const sizeLine = await stream.readLine();
          const size = parseInt(sizeLine.trim().split(";")[0], 16);
          if (!Number.isFinite(size) || size < 0) throw ProxyError("ECHUNK", "bad chunk size");
          if (size === 0) { for (;;) { const t = await stream.readLine(); if (t === "") break; } break; }
          total += size;
          if (total > MAX_RELAY_BODY) throw ProxyError("EBODY", "relay request body too large");
          const chunk = await stream.readExactly(size);
          parts.push(chunk);
          await stream.readLine();
          if (entry) entry.addUp(size + size.toString(16).length + 4);
        }
        reqBody = Buffer.concat(parts);
      } else if (Number.isFinite(cl) && cl > 0) {
        if (cl > MAX_RELAY_BODY) throw ProxyError("EBODY", "relay request body too large");
        reqBody = await stream.readExactly(cl);
        if (entry) entry.addUp(cl);
      }
      if (entry) {
        entry.addUp(up);
        if (reqBody) entry.setRequestPreview(reqBody);
      }
      const p = getProxy();
      if (!p) { writeSimple(csock, 507); if (entry) entry.finalize(new Error("proxy disabled")); return; }
      const portNum = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
      let reqHead;
      if (isSocks(p)) {
        // 经 SOCKS5 隧道直连目标：请求行改写为 origin-form，剥代理相关头
        up2 = await socksConnect(p, u.hostname.replace(/^\[|\]$/g, ""), portNum, null, timeoutMs);
        reqHead = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n` + headerLines(stripHop({ ...headers, host: headers.host || u.host })) + "\r\n";
      } else {
        // 经 HTTP 代理：absolute-form 原样保留，补凭据与 close 语义
        up2 = await connectProxy(p, null, timeoutMs);
        const h2 = stripHop(headers);
        if (p.username || p.password) h2["proxy-authorization"] = "Basic " + Buffer.from(`${p.username || ""}:${p.password || ""}`).toString("base64");
        if (!h2["host"]) h2["host"] = u.host;
        reqHead = `${firstLine}\r\n` + headerLines(h2) + "\r\n";
      }
      up2.write(reqHead);
      if (entry) entry.addUp(Buffer.byteLength(reqHead, "latin1"));
      if (reqBody) { up2.write(reqBody); if (entry) entry.addUp(reqBody.length); }

      // 读上游响应（状态行+头），原样透传给客户端（Connection: close 语义）
      const rs = new ByteStream(up2);
      const statusLine = await rs.readLine();
      const sm = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
      const status = sm ? Number(sm[1]) : 0;
      const rhdrs = {};
      for (let n = 0; ; n++) {
        if (n > MAX_HEADERS) throw ProxyError("EHEADER", "too many response headers");
        const line = await rs.readLine();
        if (line === "") break;
        const ci = line.indexOf(":");
        if (ci !== -1) rhdrs[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
      }
      const outHead = `${statusLine}\r\n` + headerLines(stripHop(rhdrs));
      csock.write(outHead);
      // 下行头口径：我方实际写出的头字节数（重写后可能与上游略有出入，按实际计）
      if (entry) {
        entry.addDown(Buffer.byteLength(outHead, "latin1"));
        entry.setResponse(status || 502);
      }

      // 响应体：按上游的 CL/chunked/EOF 定界透传，逐块计数与预览
      const rte = (rhdrs["transfer-encoding"] || "").toLowerCase();
      const rcl = Number(rhdrs["content-length"]);
      csock.once("close", onGone);
      csock.once("error", onGone);
      const writeChunk = async (buf) => {
        if (gone) throw ProxyError("ECLIENT_GONE", "client closed during response");
        if (entry) entry.addDown(buf.length);
        if (!csock.write(buf)) {
          // 背压等待：客户端断开时 socket destroy 不发 drain，须与 close/error 竞速兜底，
          // 否则本协程与日志条目永久挂起（live 记录泄漏 → 2000 条熔断）。
          await new Promise((res) => {
            const done = () => { csock.removeListener("close", done); csock.removeListener("error", done); res(); };
            csock.once("close", done);
            csock.once("error", done);
            csock.once("drain", done);
          });
        }
      };
      if (rte.includes("chunked")) {
        for (;;) {
          const sizeLine = await rs.readLine();
          const size = parseInt(sizeLine.trim().split(";")[0], 16);
          if (!Number.isFinite(size) || size < 0) throw ProxyError("ECHUNK", "bad response chunk size");
          if (size === 0) {
            await writeChunk(Buffer.from("0\r\n\r\n", "latin1"));
            for (;;) { const t = await rs.readLine(); if (t === "") break; }
            break;
          }
          const chunk = await rs.readExactly(size);
          await rs.readLine();
          const frame = Buffer.concat([
            Buffer.from(size.toString(16) + "\r\n", "latin1"), chunk, Buffer.from("\r\n", "latin1"),
          ]);
          if (entry) entry.addPlain(chunk);
          await writeChunk(frame);
        }
      } else if (Number.isFinite(rcl) && rcl > 0) {
        let rem = rcl;
        let first = true;
        while (rem > 0) {
          const d = await rs.nextData();
          if (d === null) throw ProxyError("ERESP_END", `upstream body ended early (${rem} bytes missing)`);
          const take = d.length > rem ? d.subarray(0, rem) : d;
          if (first && entry) { entry.addPlain(take); first = false; }
          rem -= take.length;
          await writeChunk(take);
        }
      } else {
        // EOF 定界（HTTP/1.0 或无 CL 无 TE）：读到上游关流
        let first = true;
        for (;;) {
          const d = await rs.nextData();
          if (d === null) break;
          if (first && entry) { entry.addPlain(d); first = false; }
          await writeChunk(d);
        }
      }
      if (entry) entry.finalize();
      csock.removeListener("close", onGone);
      csock.removeListener("error", onGone);
      try { csock.end(); } catch {}
      try { up2.destroy(); } catch {}
    } catch (e) {
      csock.removeListener("close", onGone);
      csock.removeListener("error", onGone);
      writeSimple(csock, 502);
      if (entry) entry.finalize(e);
      try { if (up2) up2.destroy(); } catch {}
    }
  }

  function onConnection(csock) {
    conns.add(csock);
    csock.once("close", () => conns.delete(csock));
    csock.on("error", () => {});
    // allowHalfOpen（见 start()）：客户端半关闭后我方仍可回写响应。
    // 头阶段定时器：ByteStream 的 idle 定时器在 detach 时清不掉（reset 闭包
    // 无法移除），会误杀长静默隧道，故不用 idleMs，改为自己管理头阶段超时。
    const stream = new ByteStream(csock);
    const headTimer = setTimeout(() => { try { csock.destroy(); } catch {} }, HEAD_IDLE_MS);
    (async () => {
      let firstLine;
      try {
        firstLine = await stream.readLine();
      } catch {
        clearTimeout(headTimer);
        try { csock.destroy(); } catch {}
        return;
      }
      stream.detach(); // 头读取阶段之后 socket 监听交还（隧道/响应体阶段不再限空闲）
      if (/^CONNECT\s/i.test(firstLine)) await handleConnect(csock, firstLine, stream, headTimer);
      else await handleHttp(csock, firstLine, stream, headTimer);
    })().catch(() => { clearTimeout(headTimer); });
  }

  return {
    async start() {
      if (listening) return { port };
      // allowHalfOpen: true —— 客户端半关闭（FIN）后我方仍需回写完整响应，
      // 默认 false 会在收到 FIN 时自动 end 我方可写端，导致响应写不出去。
      server = net.createServer({ allowHalfOpen: true }, onConnection);
      server.on("error", () => {});
      // server 意外关闭时同步 listening 标志：否则 status() 报僵尸「listening=true」，
      // relayWatch（只信 status 标志）永不自愈，env 指向死端口（实例症状：插件目录
      // "fetch failed, tried through http://127.0.0.1:<死端口>"，实测发生过）。
      server.once("close", () => { if (server) listening = false; });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      }).catch((e) => { server = null; throw e; });
      port = server.address().port;
      listening = true;
      if (report) report(`本地中继已启动 127.0.0.1:${port}`);
      return { port };
    },
    stop() {
      const had = listening;
      const oldPort = port;
      listening = false;
      port = null;
      for (const c of conns) { try { c.destroy(); } catch {} }
      conns.clear();
      if (server) { try { server.close(); } catch {} }
      server = null;
      if (report && had) report(`本地中继已停止（原 :${oldPort}）`);
    },
    status() {
      // 以真实 socket 为准：内存标志可能与实际脱节（close 竞态），状态必须可自愈
      const alive = Boolean(server && server.listening);
      if (listening !== alive) listening = alive;
      if (!alive) port = null;
      return { listening: alive, port, connections: conns.size };
    },
  };
}
