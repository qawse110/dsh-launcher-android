// lib/config.js — 配置读写与投影（无 webSocket/apply 依赖）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function configPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "net-proxy.json");
}

export function defaults() {
  return {
    enabled: false,
    followSystem: false,
    protocol: "http",
    host: "127.0.0.1",
    port: 7890,
    username: "",
    password: "",
    noProxy: ["127.0.0.1", "localhost", "::1"],
    logEnabled: true,
    logPreviewBytes: 512,
  };
}

export function loadConfig(file = configPath()) {
  try {
    if (fs.existsSync(file)) {
      let raw = fs.readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥离 UTF-8 BOM
      const parsed = JSON.parse(raw);
      const merged = { ...defaults(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
      try {
        return toCfg(merged); // 读路径同样过校验：坏端口/协议在加载期拦截并回退默认，不留到每条请求才报错
      } catch (err) {
        console.error(`[net-proxy] 配置校验失败，已回退默认值（请检查 ${file}）: ${(err && err.message) || err}`);
        return defaults();
      }
    }
  } catch (err) {
    console.error(`[net-proxy] 读取配置失败 ${file}:`, err && err.message);
  }
  return defaults();
}

export function writeConfig(cfg, file = configPath()) {
  const merged = { ...defaults(), ...(cfg && typeof cfg === "object" ? cfg : {}) };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return merged;
}

const VALID_PROTOCOLS = ["http", "socks5", "socks"];

function toCfg(value) {
  const merged = { ...defaults(), ...(value && typeof value === "object" ? value : {}) };
  // 写入前校验关键数值：脏配置（port/protocol）此前会静默落盘，到连接时才报错
  const port = Number(merged.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`net-proxy: invalid port: ${JSON.stringify(merged.port)}`);
  }
  const protocol = String(merged.protocol || "").toLowerCase();
  if (!VALID_PROTOCOLS.includes(protocol)) {
    throw new Error(`net-proxy: invalid protocol: ${JSON.stringify(merged.protocol)}`);
  }
  const logPreviewBytes = Number(merged.logPreviewBytes);
  if (!Number.isInteger(logPreviewBytes) || logPreviewBytes < 0 || logPreviewBytes > 8192) {
    throw new Error(`net-proxy: invalid logPreviewBytes: ${JSON.stringify(merged.logPreviewBytes)}`);
  }
  return { ...merged, port, protocol, logEnabled: Boolean(merged.logEnabled), logPreviewBytes };
}

function toProxy(cfg) {
  return {
    protocol: cfg.protocol || "http",
    host: cfg.host || "127.0.0.1",
    port: cfg.port || 7890,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    noProxy: Array.isArray(cfg.noProxy) && cfg.noProxy.length ? cfg.noProxy : ["127.0.0.1", "localhost", "::1"],
  };
}

export { toCfg, toProxy };
