// 会话统计 worker 入口：与 codebuddy-sessions.js 同目录，重导出其同步实现。
// 详见 codebuddy-sessions.js 底部的 worker 调度说明。
import { parentPort } from "node:worker_threads";
import { collectSessionUsage } from "./codebuddy-sessions.js";

parentPort.on("message", ({ id, root }) => {
  try {
    const result = collectSessionUsage(root);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
