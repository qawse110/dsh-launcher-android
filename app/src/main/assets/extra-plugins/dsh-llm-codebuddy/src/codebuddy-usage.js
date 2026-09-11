// 用量/余额查询：直接调用 CodeBuddy 个人中心（plans-usage 页面）背后的计费接口。
//
// 那个页面本身是 SPA 空壳（HTML 里只有 <div id="root">），所有数字都由登录后
// 的 XHR 拉取，所以抓 HTML 没有意义 —— 这里直接打它背后的接口：
//   POST /billing/meter/get-user-resource          —— 全部资源包明细（现役）
//   POST /billing/meter/get-user-resource-summary  —— 轻量汇总（现役）
//   POST /billing/meter/get-enterprise-user-usage  —— 企业版额度（需 X-Enterprise-Id）
// 三个接口都接受登录会话里的 accessToken（issuer 与账单域名同一 realm）。
//
// 【关于 get-user-daily-usage / get-user-request-usage】
// 2026-09 实测（从 usercenter 前端产物 download.codebuddy.cn/web/usercenter/**
// /assets/index-*.js 里扒到真实调用点）：
//   POST /billing/meter/get-user-request-usage —— 积分消耗明细（网页「使用明细」表格的数据源）
//     请求体 { startTime: "YYYY-MM-DD HH:mm:ss", endTime: "...", pageNum, pageSize }
//     返回 { total, data: [{ requestId, credit, model, client, requestTime,
//                            input, inputTrunc, agentPurpose }] }
//     这是唯一能落到「单次请求 × 模型 × 客户端 × 积分」的官方数据源。
//   POST /billing/meter/get-user-daily-usage —— 日粒度聚合（前端同样存在此调用点）。
//     2026-09 实测：与 request-usage 完全同款的参数（startTime/endTime/pageNum/
//     pageSize，含/不含 timezone）均返回 10001 invalid params，穷举 140+ 组合无一
//     成功；结构体已探明为 {startTime,endTime,timezone: string, pageNum, pageSize,
//     version: int}。故本模块【不依赖】它，改由 request-usage 在本侧按日聚合
//     （byDay），效果等价且数据源可靠。保留说明以免后人重复踩坑。
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

// ---- 积分消耗明细（get-user-request-usage）----
// 网页「使用明细」表格的同源接口：逐条请求 × 模型 × 客户端 × 积分。
// 服务端 total 有上限（实测 3000 条封顶），pageSize 同样受限，因此按页翻到底。

const REQUEST_USAGE_PAGE_SIZE = 1000;
const REQUEST_USAGE_MAX_PAGES = 10; // 兜底：绝不无限翻页

/** 时间格式 "YYYY-MM-DD HH:mm:ss"（服务端按此格式解析，实测通过）。 */
function formatUsageTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 把明细聚合成 按模型 / 按日 / 按客户端 三张表。 */
function aggregateRequestUsage(rows) {
  const byModel = new Map();
  const byDay = new Map();
  const byClient = new Map();
  const bump = (map, key, row) => {
    const entry = map.get(key) ?? { key, credit: 0, requests: 0, models: new Set() };
    entry.credit += Number(row.credit ?? 0);
    entry.requests += 1;
    if (row.model) entry.models.add(row.model);
    map.set(key, entry);
  };
  for (const row of rows) {
    bump(byModel, row.model ?? "?", row);
    // requestTime 形如 "2026-09-10 07:47:00" → 取日期段
    const day = typeof row.requestTime === "string" ? row.requestTime.slice(0, 10) : "?";
    bump(byDay, day, row);
    bump(byClient, row.client || "(未知客户端)", row);
  }
  const finish = (map, label) =>
    [...map.values()]
      .map((entry) => ({
        [label]: entry.key,
        credit: Math.round(entry.credit * 100) / 100,
        requests: entry.requests,
        models: [...entry.models],
      }))
      .sort((a, b) => b.credit - a.credit || b.requests - a.requests);
  return {
    byModel: finish(byModel, "model"),
    byDay: finish(byDay, "day").sort((a, b) => String(b.day).localeCompare(String(a.day))),
    byClient: finish(byClient, "client"),
  };
}

/**
 * 拉取积分消耗明细（分页到底）并聚合。
 * 返回 { total, fetched, rows, byModel, byDay, byClient, servedAt }。
 * rows 是可控上限内的原始明细（用于 UI 展示最近若干条；含用户输入文本，故只取摘要）。
 */
export async function fetchCodeBuddyRequestUsage(region, session, { days = 30, signal } = {}) {
  const headers = {
    authorization: `Bearer ${session.auth.accessToken}`,
    ...(session.account?.userId ? { "X-User-Id": session.account.userId } : {}),
    ...(session.account?.enterpriseId
      ? { "X-Enterprise-Id": session.account.enterpriseId, "X-Tenant-Id": session.account.enterpriseId }
      : {}),
    ...(session.auth.domain ? { "X-Domain": session.auth.domain } : {}),
  };
  const base = region.billingBaseUrl;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const range = { startTime: formatUsageTime(start), endTime: formatUsageTime(end) };
  const rows = [];
  const seen = new Set(); // requestId 去重：分片/翻页之间可能有重叠
  let reportedTotal = 0;
  let windows = 0;
  let capped = false; // 是否有某个分片触及服务端上限（说明该片仍可能不全）

  // 【关键】服务端 total 硬封顶 3000 条：整月/跨月查询一律只返回 3000，
  // 实测 9 月逐日合计 3900+ 条 > 3000，宽区间必然丢数据。
  // 因此按【自然日】分片拉取：每日条数远低于上限，拼起来才是完整集合。
  for (let offset = days; offset >= 0; offset -= 1) {
    const dayStart = new Date(end.getTime() - offset * 24 * 3600 * 1000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000 - 1000);
    const window = { startTime: formatUsageTime(dayStart), endTime: formatUsageTime(dayEnd) };
    windows += 1;
    for (let page = 1; page <= REQUEST_USAGE_MAX_PAGES; page += 1) {
      const data = await postJson(
        `${base}/billing/meter/get-user-request-usage`,
        { ...window, pageNum: page, pageSize: REQUEST_USAGE_PAGE_SIZE },
        headers,
        signal,
      );
      const pageRows = Array.isArray(data?.data) ? data.data : [];
      const sliceTotal = Number(data?.total ?? 0) || 0;
      reportedTotal = Math.max(reportedTotal, sliceTotal);
      for (const row of pageRows) {
        // 同一天的分页之间理论上不重复，但跨天边界可能重叠，按 requestId 去重。
        const id = row?.requestId;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        rows.push(row);
      }
      if (pageRows.length < REQUEST_USAGE_PAGE_SIZE) break;
      if (page === REQUEST_USAGE_MAX_PAGES) capped = true;
    }
  }
  return {
    ...range,
    // total 是"单个分片的最大值"，不是全区间真实总数（服务端封顶），
    // 真实条数看 fetched。
    reportedTotal,
    fetched: rows.length,
    windows,
    capped,
    // 明细原文（含用户输入）不出网到 UI 之外的任何地方；UI 只展示前若干条摘要。
    rows: rows.slice(0, 200),
    ...aggregateRequestUsage(rows),
    servedAt: new Date().toISOString(),
  };
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
