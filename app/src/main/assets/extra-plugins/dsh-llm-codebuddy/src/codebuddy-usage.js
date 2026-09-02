// 用量/余额查询：直接调用 CodeBuddy 个人中心（plans-usage 页面）背后的计费接口。
//
// 那个页面本身是 SPA 空壳（HTML 里只有 <div id="root">），所有数字都由登录后
// 的 XHR 拉取，所以抓 HTML 没有意义 —— 这里直接打它背后的接口：
//   POST /billing/meter/get-user-resource          —— 全部资源包明细
//   POST /billing/meter/get-user-resource-summary  —— 轻量汇总
//   POST /billing/meter/get-user-daily-usage       —— 每日用量明细
// 三个接口都接受登录会话里的 accessToken（issuer 与账单域名同一 realm）。
//
// 只读。刻意不实现 claim-gift / claim-compensation 等写操作：那是动账户资产。

import { REQUEST_HEADERS } from "./codebuddy-auth.js";

const TIMEOUT_MS = 15_000;

// 接口里的金额/额度都是字符串（"490.54000002"），需要安全转数字再展示。
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimNumber(value) {
  return Math.round(value * 100) / 100;
}

async function postJson(url, body, headers, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...REQUEST_HEADERS, ...headers },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted || controller.signal.aborted) {
      throw new Error("CodeBuddy 用量查询已取消");
    }
    throw new Error("无法连接 CodeBuddy 用量接口", { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`CodeBuddy 用量接口返回 ${response.status}`);
  }
  if (payload?.code !== 0) {
    throw new Error(`CodeBuddy 用量接口错误：${payload?.msg ?? payload?.message ?? payload?.code}`);
  }
  return payload.data;
}

/** 汇总各资源包的周期额度。precise 字段精度更高（"490.54000002"），优先取用。 */
function summarizePackages(data) {
  const packages = Array.isArray(data?.Packages) ? data.Packages : [];
  const items = packages.map((entry) => {
    const remaining = toNumber(entry.CycleRemainCapacity ?? entry.CycleRemainCapacityPrecise);
    const total = toNumber(entry.CycleTotalCapacity ?? entry.CycleTotalCapacityPrecise);
    const used = toNumber(entry.CycleUsedCapacity ?? entry.CycleUsedCapacityPrecise);
    const frozen = toNumber(entry.CycleFrozenCapacity ?? entry.CycleFrozenCapacityPrecise);
    return {
      packageCode: entry.PackageCode ?? "",
      remaining: trimNumber(remaining),
      total: trimNumber(total),
      // 接口不直接给 used 时，用 total - remaining 兜底（浮点误差已被 trimNumber 收敛）。
      used: trimNumber(used || Math.max(0, total - remaining)),
      frozen: trimNumber(frozen),
      unit: entry.CapacityUnit ?? "credits",
    };
  });
  const sum = (pick) => trimNumber(items.reduce((acc, item) => acc + pick(item), 0));
  return {
    items,
    remaining: sum((item) => item.remaining),
    total: sum((item) => item.total),
    used: sum((item) => item.used),
    frozen: sum((item) => item.frozen),
    isPaidUser: data?.IsPaidUser === true,
    isProtectedPriceUser: data?.IsProtectedPriceUser === true,
    subscriptionPackageCode: data?.SubscriptionPackageCode ?? "",
  };
}

/** 资源包明细：含周期边界、包名、订阅状态，供设置页表格展示。 */
function normalizeAccounts(data) {
  const accounts = data?.Response?.Data?.Accounts;
  if (!Array.isArray(accounts)) return [];
  return accounts.map((entry) => {
    const remaining = toNumber(entry.CycleCapacityRemainPrecise ?? entry.CycleCapacityRemain);
    const total = toNumber(entry.CycleCapacitySizePrecise ?? entry.CycleCapacitySize);
    const used = toNumber(entry.CycleCapacityUsedPrecise ?? entry.CycleCapacityUsed);
    return {
      name: entry.PackageName ?? entry.PackageCode ?? "未命名资源包",
      packageCode: entry.PackageCode ?? "",
      remaining: trimNumber(remaining),
      total: trimNumber(total),
      used: trimNumber(used || Math.max(0, total - remaining)),
      unit: entry.CapacityUnit ?? "credits",
      cycleStart: entry.CycleStartTime ?? "",
      cycleEnd: entry.CycleEndTime ?? "",
      status: Number(entry.Status ?? 0),
      autoRenew: entry.AutoRenewFlag === 1,
      resourceId: entry.ResourceId ?? "",
    };
  });
}

/**
 * 查询某个区域的用量。session 为已解析（且已按需续期）的登录会话，
 * 由调用方传入 —— 本模块不碰凭据存储。
 */
export async function fetchCodeBuddyUsage(region, session, signal) {
  const headers = {
    authorization: `Bearer ${session.auth.accessToken}`,
    ...(session.account?.userId ? { "X-User-Id": session.account.userId } : {}),
    ...(session.account?.enterpriseId
      ? { "X-Enterprise-Id": session.account.enterpriseId, "X-Tenant-Id": session.account.enterpriseId }
      : {}),
    ...(session.auth.domain ? { "X-Domain": session.auth.domain } : {}),
  };
  const base = region.billingBaseUrl;
  const [summary, resource] = await Promise.all([
    postJson(`${base}/billing/meter/get-user-resource-summary`, {}, headers, signal).catch(() => undefined),
    postJson(`${base}/billing/meter/get-user-resource`, {}, headers, signal).catch(() => undefined),
  ]);
  if (!summary && !resource) throw new Error("CodeBuddy 用量接口没有返回数据");
  const accounts = normalizeAccounts(resource);
  const totals = summary
    ? summarizePackages(summary)
    : {
        items: accounts.map((account) => ({ ...account })),
        remaining: trimNumber(accounts.reduce((acc, item) => acc + item.remaining, 0)),
        total: trimNumber(accounts.reduce((acc, item) => acc + item.total, 0)),
        used: trimNumber(accounts.reduce((acc, item) => acc + item.used, 0)),
        frozen: 0,
        isPaidUser: false,
        isProtectedPriceUser: false,
        subscriptionPackageCode: "",
      };
  // 明细表优先用 get-user-resource（带包名与周期），汇总数字优先用 summary。
  const detail = accounts.length > 0 ? accounts : totals.items;
  return {
    ...totals,
    packages: detail,
    servedAt: new Date().toISOString(),
  };
}

const HY4_MODEL_ID = "hy4-preview";

/**
 * 探测 hy4-preview 的免费「用量 / 限流窗口」状态。
 *
 * hy4-preview 是免费（x0.00）的 preview 推理模型，按固定窗口做频率限制：
 * 窗口内用量触顶后，任何请求都会返回 HTTP 429 + 业务码 6000，body.msg 里写明
 * 重置时间（"…将在 2026-09-02 17:55:20 UTC+8 重置…"），且不带 Retry-After 头。
 * 因此这里用一次最小请求（model=hy4-preview + max_tokens=1）探测：
 *   - 200            → 当前可用（不消费响应体，直接释放连接）
 *   - 429 / code6000 → 限流中，解析 msg 里的重置时间（UTC+8，转成绝对时间）
 *   - 其它（400 等）  → 原样报告（如模型未授权 / 该区域无此模型）
 * 探测本身不扣额度（x0.00），但会占一丁点窗口配额，所以在用量页加载或点
 * 「刷新」时才调用（不放在常驻轮询里）。
 */
export async function probeCodeBuddyHy4(region, session, signal) {
  const headers = {
    authorization: `Bearer ${session.auth.accessToken}`,
    ...(session.account?.userId ? { "X-User-Id": session.account.userId } : {}),
    ...(session.account?.enterpriseId
      ? { "X-Enterprise-Id": session.account.enterpriseId, "X-Tenant-Id": session.account.enterpriseId }
      : {}),
    ...(session.auth.domain ? { "X-Domain": session.auth.domain } : {}),
  };
  // 探测走一次最小请求；网络层偶发抖动时重试一次再报错（429/400 等业务响应不算抖动，直接返回）。
  let response;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      response = await fetch(`${region.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...REQUEST_HEADERS, ...headers },
        body: JSON.stringify({
          model: HY4_MODEL_ID,
          // 国际版要求首条消息是 system prompt（否则 400/11128），中国区对两种都兼容；
          // 统一带 system 首条，保证两个区域都能探测。
          messages: [
            { role: "system", content: "ping" },
            { role: "user", content: "ping" },
          ],
          stream: true,
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      break;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || controller.signal.aborted) {
        throw new Error("hy4-preview 用量探测已取消");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  if (!response) throw new Error("无法连接 CodeBuddy 模型接口", { cause: lastError });

  if (response.ok) {
    // 200 = 可用；不消费流内容，直接释放连接。
    response.body?.cancel().catch(() => {});
    return {
      model: HY4_MODEL_ID,
      available: true,
      limited: false,
      resetAt: null,
      httpStatus: response.status,
      servedAt: new Date().toISOString(),
    };
  }

  const payload = await response.json().catch(() => undefined);
  const code = payload?.code ?? response.status;
  const msg = payload?.msg ?? payload?.message ?? "";
  const limited = response.status === 429 || code === 6000;
  // 重置时间优先取 body.msg 里的 "2026-09-02 17:55:20"；body 缺失（纯 429）时
  // 兜底解析 Retry-After 头（秒数或 HTTP-date），拿不到就只报「限流中」。
  const resetMatch = typeof msg === "string" ? msg.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/) : null;
  let resetAt = resetMatch ? parseResetTime(resetMatch[1]) : null;
  let resetRaw = resetMatch?.[1] ?? "";
  if (!resetAt) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0 && seconds < 24 * 3600) {
        resetAt = new Date(Date.now() + seconds * 1000).toISOString();
        resetRaw = `${seconds}s`;
      } else {
        const parsed = Date.parse(retryAfter);
        if (Number.isFinite(parsed)) {
          resetAt = new Date(parsed).toISOString();
          resetRaw = retryAfter;
        }
      }
    }
  }
  return {
    model: HY4_MODEL_ID,
    available: false,
    limited,
    resetAt,
    resetRaw,
    httpStatus: response.status,
    code,
    message: msg || (limited ? "服务端限流（未返回重置时间）" : `HTTP ${response.status}`),
    servedAt: new Date().toISOString(),
  };
}

/** 把服务端 msg 里的 "2026-09-02 17:55:20"（UTC+8 本地时间）转成绝对时间 ISO。 */
function parseResetTime(raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(raw).trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
