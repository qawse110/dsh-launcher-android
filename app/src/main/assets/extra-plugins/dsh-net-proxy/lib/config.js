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
    protocol: "http",
    host: "127.0.0.1",
    port: 7890,
    username: "",
    password: "",
    noProxy: ["127.0.0.1", "localhost", "::1"],
  };
}

export function loadConfig(file = configPath()) {
  try {
    if (fs.existsSync(file)) {
      let raw = fs.readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥离 UTF-8 BOM
      const parsed = JSON.parse(raw);
      return { ...defaults(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
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

function toCfg(value) {
  return { ...defaults(), ...(value && typeof value === "object" ? value : {}) };
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
