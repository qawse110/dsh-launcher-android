// lib/proxy/conn.js — 代理底层连接：TCP 连接代理 → HTTP CONNECT / SOCKS5 隧道；单数据泵 ByteStream
import net from "node:net";
import { ProxyError, abortError } from "./errors.js";
import { parseStatusLine } from "./parse.js";

export const MAX_HEADER_LINE = 64 * 1024; // 单行头上限

/** 连接到代理（可取消）。 */
export function connectProxy(proxy, signal) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    sock.setNoDelay(true);
    const onAbort = () => { try { sock.destroy(); } catch {} reject(abortError()); };
    if (signal) {
      if (signal.aborted) { sock.destroy(); return reject(abortError()); }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = (err, val) => { if (signal) signal.removeEventListener("abort", onAbort); err ? reject(err) : resolve(val); };
    sock.once("connect", () => done(null, sock));
    sock.once("error", (e) => done(ProxyError("ECONNECT_PROXY", `proxy connect ${proxy.host}:${proxy.port} failed: ${e.message}`, e)));
  });
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return "";
  return "Proxy-Authorization: Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64") + "\r\n";
}

/** HTTP 代理 CONNECT 隧道（HTTPS 目标）。成功返回 raw socket。 */
export function httpConnect(proxy, targetHost, targetPort, signal) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connectProxy(proxy, signal); } catch (e) { return reject(e); }
    const host = `${targetHost}:${targetPort}`;
    const stream = new ByteStream(sock);
    sock.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${proxyAuthHeader(proxy)}\r\n`);
    try {
      const statusLine = await stream.readLine();
      stream.detach();
      const status = parseStatusLine(statusLine);
      if (status === 200) resolve(sock);
      else { sock.destroy(); reject(ProxyError("ECONNECT_TARGET", `CONNECT to ${host} via proxy failed: HTTP ${status}`)); }
    } catch (e) {
      stream.detach();
      sock.destroy();
      reject(e);
    }
  });
}

/** SOCKS5：协商（支持 RFC1929 用户名/密码）+ CONNECT。成功返回 raw socket。 */
export function socksConnect(proxy, targetHost, targetPort, signal) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connectProxy(proxy, signal); } catch (e) { return reject(e); }
    const fail = (msg) => { sock.destroy(); reject(ProxyError("ECONNECT_TARGET", msg)); };
    try {
      const stream = new ByteStream(sock);
      // 方法协商：0x00 no-auth（若无凭据）/ 0x02 user/pass（若有凭据）
      const wantAuth = !!(proxy.username || proxy.password);
      sock.write(Buffer.from([0x05, 0x01, wantAuth ? 0x02 : 0x00]));
      const verMethod = await stream.readExactly(2);
      if (verMethod[0] !== 0x05) { stream.detach(); return fail(`SOCKS5: bad version ${verMethod[0]}`); }
      if (verMethod[1] === 0x02) {
        const user = Buffer.from(proxy.username || "", "utf8");
        const pass = Buffer.from(proxy.password || "", "utf8");
        sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const authResp = await stream.readExactly(2);
        if (authResp[0] !== 0x01 || authResp[1] !== 0x00) { stream.detach(); return fail(`SOCKS5: auth failed (code ${authResp[1]})`); }
      } else if (verMethod[1] !== 0x00) {
        stream.detach();
        return fail(`SOCKS5: server requires auth (method ${verMethod[1]})`);
      }
      // CONNECT：域名 → ATYP=0x03（IP 目标 → 0x01/0x04），为稳妥统一用域名形式
      const hostBuf = Buffer.from(targetHost, "utf8");
      const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      sock.write(req);
      const head = await stream.readExactly(4);
      if (head[1] !== 0x00) { stream.detach(); return fail(`SOCKS5: connect to ${targetHost}:${targetPort} failed, code ${head[1]}`); }
      // 吃掉 BND.ADDR
      const atyp = head[3];
      const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1;
      await stream.readExactly(alen + 2);
      stream.detach();
      resolve(sock);
    } catch (e) {
      sock.destroy();
      reject(e);
    }
  });
}

/**
 * 单数据泵 ByteStream：socket 只挂一套 data/end/error 监听，数据进队列，
 * 用 pull 式解析（不足则挂起）。避免多监听器互相消费丢数据；合并计算推延，
 * 减少 O(n²) 反复 concat。
 */
export class ByteStream {
  constructor(sock, idleMs = 0) {
    this.sock = sock;
    this.q = []; // 待消费 chunk 队列
    this.len = 0;
    this.waiters = [];
    this.ended = false;
    this.error = null;
    this._idleTimer = null;
    // 保存处理器引用，供 detach() 在把 socket 交给 TLS 前移除
    this._onData = (c) => this._push(c);
    this._onEnd = () => { this.ended = true; this._flush(); };
    this._onErr = (e) => { this.error = e; this.ended = true; this._flush(); };
    this._onIdleClear = null;
    sock.on("data", this._onData);
    sock.on("end", this._onEnd);
    sock.on("error", this._onErr);
    if (idleMs > 0) {
      const onIdle = () => { try { sock.destroy(); } catch {} this.error = ProxyError("ETIMEOUT", "proxiedFetch: response idle timeout"); this.ended = true; this._flush(); };
      const reset = () => { if (this._idleTimer) clearTimeout(this._idleTimer); this._idleTimer = setTimeout(onIdle, idleMs); };
      this._onIdleClear = () => { if (this._idleTimer) clearTimeout(this._idleTimer); };
      reset();
      sock.on("data", reset);
      sock.on("end", this._onIdleClear);
      sock.on("close", this._onIdleClear);
    }
  }
  // 把 socket「交还」给 TLS 等接管前调用：移除本流挂上的全部监听。
  detach() {
    const s = this.sock;
    s.removeListener("data", this._onData);
    s.removeListener("end", this._onEnd);
    s.removeListener("error", this._onErr);
    if (this._onIdleClear) {
      s.removeListener("data", this._onIdleClear); // 若已绑过（idleMs>0 时绑定的是同名 reset，实则不同闭包）
      s.removeListener("end", this._onIdleClear);
      s.removeListener("close", this._onIdleClear);
    }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }
  _push(c) { this.q.push(c); this.len += c.length; this._flush(); }
  _flush() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  // 从队列头部精确切出 need 字节（need=null 取全部）。多余的部分留在队列，供下次读取。
  _take(need) {
    if (this.len === 0) return Buffer.alloc(0);
    const needN = need == null ? this.len : need;
    const parts = [];
    let have = 0, i = 0, done = false;
    for (; i < this.q.length; i++) {
      const c = this.q[i];
      const want = needN - have;
      if (c.length > want) {
        // 该块超出 need：取 want，剩余放回队列
        parts.push(c.subarray(0, want));
        const rest = c.subarray(want);
        this.q = [rest, ...this.q.slice(i + 1)];
        this.len -= want;
        return Buffer.concat(parts);
      }
      parts.push(c);
      have += c.length;
      if (have >= needN) { i++; done = true; break; }
    }
    this.q = this.q.slice(done ? i : this.q.length);
    this.len -= have;
    return Buffer.concat(parts);
  }
  _pull(need, cb) {
    if (this.len >= need) cb(null, this._take(need));
    else if (this.ended) cb(this.error || ProxyError("ERESP_END", "socket ended early"), null);
    else this.waiters.push(() => this._pull(need, cb));
  }
  readExactly(need) {
    return new Promise((res, rej) => this._pull(need, (e, b) => (e ? rej(e) : res(b))));
  }
  // 读一行（到 CRLF），带最大长度限制。换行之后多读的数据放回队列，
  // 保证后续 nextData/readExactly 不丢失 body。
  async readLine() {
    let scan = Buffer.alloc(0);
    for (;;) {
      if (this.len > 0) {
        const take = this._take(this.len);
        scan = scan.length ? Buffer.concat([scan, take]) : take;
      }
      const idx = scan.indexOf("\r\n");
      if (idx !== -1) {
        const out = scan.subarray(0, idx);
        const rest = scan.subarray(idx + 2);
        if (rest.length > 0) this._prepend(rest);
        return out.toString("latin1");
      }
      if (scan.length > MAX_HEADER_LINE) throw ProxyError("EHEADER", "response header line too long");
      if (this.ended) throw (this.error || ProxyError("ERESP_END", "socket ended"));
      await new Promise((r) => this.waiters.push(r));
    }
  }
  _prepend(buf) {
    if (buf && buf.length) { this.q.unshift(buf); this.len += buf.length; }
  }
  // 下一块数据（若有多块合并成一块返回）；结束返回 null。
  _nextBlock(cb) {
    if (this.len > 0) { const out = this._take(this.len); return cb(null, out); }
    if (this.ended) return cb(this.error || null, null);
    this.waiters.push(() => this._nextBlock(cb));
  }
  nextData() { return new Promise((res, rej) => this._nextBlock((e, b) => (e ? rej(e) : res(b)))); }
}
