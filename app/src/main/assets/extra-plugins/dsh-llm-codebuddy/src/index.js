import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { Config, PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
// 命名空间导入（**不能用具名导入**）：dsh 0.1.5 起 @deepseek-ai/dsh-settings 不再
// 导出 installSettingsSection / settingsNamespace，具名导入会在 ESM 链接期直接抛
// "does not provide an export named ..."，使整个插件加载失败并拖垮插件树（web 起不来）。
// 命名空间导入只要求模块可解析，符号缺失留到运行时按能力探测（见 installSection）。
import * as dshSettings from "@deepseek-ai/dsh-settings";
import { createProvider } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import {
  CODEBUDDY_REGIONS,
  activeCodeBuddySession,
  codeBuddySessionId,
  createCodeBuddySessionStore,
  parseCodeBuddySession,
  parseCodeBuddySessions,
  refreshCodeBuddySession,
  serializeCodeBuddySession,
  serializeCodeBuddySessions,
  sessionCacheDeadline,
  sessionNeedsRefresh,
  upsertCodeBuddySession,
} from "./codebuddy-auth.js";
import { installCodeBuddyWeb } from "./codebuddy-web.js";

export { Config };

export const name = "llm-codebuddy";
export const inject = ["llm"];

// settings 命名空间字面量。旧版用 settingsNamespace() 校验后返回原值，新版该函数
// 不再导出（改名 parseSettingsNamespace 且同样未导出）；其校验规则很简单
// （/^[a-z][a-z0-9-]*$/，见新版 dsh-settings 的 parseSettingsNamespace），
// 且新版 ctx.settings.register() 内部会自行校验并抛错，故此处只保留常量。
// ★ 与'多账号会话池/新版 UA'同步时的冲突解法：NS 用常量（远程修复，避免引用
//   已被 0.1.5 删除的 settingsNamespace），USER_AGENT 取本地新版（新特性）。
const NS = "llm-codebuddy";
const USER_AGENT = "workbuddy-ai/5.5.2 workbuddy-ai/5.5.2 CLI/2.137.1";
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVELS = ["off", ...EFFORTS];
const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
};

// CodeBuddy 默认重试策略：不重试 RATE_LIMIT（429）。
// hy4-preview 这类免费 preview 模型按固定窗口限流，窗口内重试必败——DSH 默认
// 会把 429 退避重试 5 次（累计几十秒），让会话看起来「一直报 429」。这里默认
// 让 429 立即失败并报出清晰错误，只对瞬时错误（空响应/服务端/超时/传输）最多
// 重试 2 次；用户仍可在 provider 配置里用 retryPolicy 覆盖。
const CODEBUDDY_RETRY_POLICY = Object.freeze({
  mode: "normal",
  maxRetries: 2,
  retryableCodes: ["EMPTY_RESPONSE", "SERVER", "TIMEOUT", "TRANSPORT"],
  backoff: { initialDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0.1 },
});

function codeBuddyRequestOptions(options) {
  return { ...options, headers: { ...(options?.headers ?? {}), "user-agent": USER_AGENT } };
}

const codeBuddyApi = {
  ...openAICompletionsApi,
  stream: (model, context, options) => openAICompletionsApi.stream(model, context, codeBuddyRequestOptions(options)),
  streamSimple: (model, context, options) => openAICompletionsApi.streamSimple(model, context, codeBuddyRequestOptions(options)),
};

// 内置兜底目录（在线目录不可用时使用）。两个区域共用同一份规格；真实目录以 /v3/config 返回为准。
const MODEL_SPECS = [
  ["hy3", "Hy3", 192000, 64000, true],
  ["glm-5.2", "GLM-5.2", 1000000, 48000, false],
  ["glm-5.1", "GLM-5.1", 200000, 48000, false],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000, 64000, true],
  ["minimax-m3-pay", "MiniMax-M3", 512000, 128000, true],
  ["minimax-m2.7", "MiniMax-M2.7", 200000, 48000, true],
  ["kimi-k3-2", "Kimi-K3", 1000000, 32000, true],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000, 32000, true],
  ["kimi-k2.6", "Kimi-K2.6", 256000, 32000, true],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 50000, true],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 1000000, 50000, true],
];

function fallbackModels(region) {
  return MODEL_SPECS.map(([id, modelName, contextWindow, maxTokens, images]) =>
    codeBuddyModel({ id, name: modelName, contextWindow, maxTokens, images, region }),
  );
}

/** 解析目录 credits 字段为数值倍率。"x0.79 credits" / "x0.00" → 0.79/0；无效 → null。 */
export function parseCreditRate(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/x?([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const rate = Number.parseFloat(match[1]);
  return Number.isFinite(rate) ? rate : null;
}

/** 倍率 → 选择框描述文本（model.description，DSH ModelSelect 渲染在模型名下方）。 */
export function creditDescription(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return undefined;
  if (rate === 0) return "免费";
  return `积分倍率 ×${rate}`;
}

function codeBuddyModel({ id, name: modelName, contextWindow, maxTokens, images, region, reasoning = true, thinkingLevelMap = { off: null }, defaultReasoningEffort, thinkingFormat, creditRate }) {
  const description = creditDescription(creditRate);
  return {
    id,
    name: modelName,
    // 倍率说明随目录透传（dsh-llm 允许可选 string），模型选择框会渲染在名称下方。
    ...(description !== undefined ? { description } : {}),
    api: "openai-completions",
    provider: region.provider,
    baseUrl: region.baseUrl,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    input: images ? ["text", "image"] : ["text"],
    cost: { ...NO_COST },
    contextWindow,
    maxTokens,
    compat: { ...COMPAT, ...(thinkingFormat ? { thinkingFormat } : {}) },
  };
}

function remoteReasoning(raw, fallback) {
  const reasoning = raw.supportsReasoning ?? fallback?.reasoning ?? raw.onlyReasoning === true;
  if (!reasoning) return { reasoning: false };
  const declared = raw.thinkingLevelMap && typeof raw.thinkingLevelMap === "object" ? raw.thinkingLevelMap : undefined;
  const thinkingLevelMap = declared
    ? Object.fromEntries(THINKING_LEVELS.map((level) => [level,
        Object.hasOwn(declared, level) && (typeof declared[level] === "string" || declared[level] === null) ? declared[level] : null]))
    : { ...(fallback?.thinkingLevelMap ?? {}), ...(raw.onlyReasoning === true ? { off: null } : {}) };
  const effort = raw.reasoning?.effort;
  const defaultReasoningEffort = EFFORTS.includes(effort) && thinkingLevelMap[effort] !== null ? effort : undefined;
  return {
    reasoning: true,
    thinkingLevelMap,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof raw.thinkingFormat === "string" ? { thinkingFormat: raw.thinkingFormat } : {}),
  };
}

function configuredReasoning(entry, base) {
  if (entry.reasoningEfforts === false) return { reasoning: false };
  if (!entry.reasoningEfforts || typeof entry.reasoningEfforts !== "object") {
    return base ? {
      reasoning: base.reasoning,
      thinkingLevelMap: base.thinkingLevelMap,
      defaultReasoningEffort: base.defaultReasoningEffort,
      thinkingFormat: base.compat?.thinkingFormat,
    } : { reasoning: false };
  }
  const map = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(entry.reasoningEfforts, level)) map[level] = null;
    else if (!(level === "off" && entry.reasoningEfforts[level] === null)) map[level] = entry.reasoningEfforts[level];
  }
  return { reasoning: true, thinkingLevelMap: map, thinkingFormat: entry.compat?.thinkingFormat };
}

function positiveInteger(...values) {
  return values.find((value) => Number.isSafeInteger(value) && value > 0);
}

function text(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

/** 按给定 id 列表从在线目录里解析模型规格（reasoning/context/maxTokens 全按在线目录）。 */
function modelsFromIds(data, ids, region) {
  const fallbackModelsList = fallbackModels(region);
  const source = Array.isArray(data?.models) ? data.models : [];
  const byId = new Map(source.map((model) => [model?.id, model]));
  return ids.flatMap((id) => {
    const raw = byId.get(id);
    if (!raw) return [];
    const fallback = fallbackModelsList.find((model) => model.id === id);
    const contextWindow = positiveInteger(raw.maxInputTokens, raw.maxAllowedSize, fallback?.contextWindow);
    const maxTokens = positiveInteger(raw.maxOutputTokens, fallback?.maxTokens);
    if (!contextWindow || !maxTokens) return [];
    return [codeBuddyModel({
      id,
      name: text(raw.name, fallback?.name, id),
      contextWindow,
      maxTokens,
      images: raw.supportsImages === true || fallback?.input.includes("image") === true,
      region,
      // 倍率来自目录 credits（"x0.79 credits"）；跨区域补齐的模型同样带自己的倍率。
      creditRate: parseCreditRate(raw.credits),
      ...remoteReasoning(raw, fallback),
    })];
  });
}

function modelsFromConfig(data, region) {
  const agents = Array.isArray(data?.agents) ? data.agents : data?.agent?.agents;
  const cli = Array.isArray(agents) ? agents.find((agent) => agent?.name === "cli") : undefined;
  const allowed = Array.isArray(cli?.models) ? cli.models : [];
  return modelsFromIds(data, allowed, region);
}

function authenticationHeaders(credential) {
  const value = assertUsableApiKey(credential.value, name, credential.ref ?? "CODEBUDDY_API_KEY");
  return credential.kind === "bearer" ? { authorization: `Bearer ${value}` } : { "x-api-key": value };
}

async function fetchCodeBuddyModels(region, credential, signal) {
  let response;
  try {
    response = await fetch(region.configUrl, {
      headers: {
        accept: "application/json",
        ...authenticationHeaders(credential),
        "user-agent": USER_AGENT,
        "x-product": "SaaS",
      },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new LlmError("CodeBuddy 模型列表获取已取消", "ABORTED", { cause: error });
    throw new LlmError("无法连接 CodeBuddy 模型配置接口", "DISCOVERY_FAILED", { cause: error });
  }
  if (!response.ok) throw new LlmError(`CodeBuddy 模型配置接口返回 ${response.status}`, "DISCOVERY_FAILED");
  const body = await response.json();
  if (body?.code !== 0) throw new LlmError(`CodeBuddy 模型配置接口错误：${body?.msg ?? body?.code}`, "DISCOVERY_FAILED");
  // 【历史说明】2026-09-11 曾在此做"跨区域补齐"：把国内版有、国际版 cli 白名单
  // 缺失的模型（hy4-preview-f / deepseek-v4.1-flash / hy3）按国内版规格合并进来。
  // 2026-09-12 起服务端已把这三个模型放进国际版 cli.models 白名单（抓包证实，
  // 且目录里原生标 x0.00 免费），补齐逻辑不再需要，已整体移除。
  return modelsFromConfig(body.data, region);
}

/**
 * CodeBuddy 的 API-Key auth：行为对齐 pi-ai 的 envApiKeyAuth（helpers.js）。
 *
 * 【为什么不用 pi-ai 内置的 DeepSeek auth helper】（上游 167e8fc 同款修复）
 * 旧实现是 `builtins.get("deepseek")?.auth`，有三个问题：
 *   1. 新版 pi-ai 的 auth resolver 要求接收 signal 参数，而旧版 DSH 适配器
 *      调用时不传 —— 跨版本升级会直接报错；
 *   2. 硬依赖 pi-ai 内置 provider 目录里存在 "deepseek"，一旦上游调整目录，
 *      插件会在加载期抛 "auth helper is unavailable" 而整体挂掉；
 *   3. DeepSeek helper 的 env 兜底读的是 DEEPSEEK_API_KEY 等变量，跟
 *      CodeBuddy 的凭据体系对不上。
 *
 * 【resolve 的三段式语义】（与 envApiKeyAuth 完全一致，只是 envVars 换成
 * CodeBuddy 自己的）：
 *   1. pi-ai credential store 里存了 api_key → 直接用；
 *   2. 没存 → 按 envVars 逐个读环境变量兜底（CodeBuddy API Key 模式的
 *      正常入口：CODEBUDDY_API_KEY / CODEBUDDY_INTL_API_KEY）；
 *   3. 都没有 → undefined（pi-ai 会报 "Provider is not configured"）。
 *
 * 令牌登录模式不经这条链：DSH 适配器（本插件）的 resolveApiKey 直接从
 * DSH credentials 服务里取登录会话 accessToken 并注入请求头，pi-ai 的
 * credential store 里不会、也不需要存 CodeBuddy 凭据。因此 token 模式下
 * 若有代码路径只调 pi-ai 的 getAuth（如部分 catalog 预取），会落到第 3 段
 * —— 这与上游 envApiKeyAuth 的行为一致，属预期。
 *
 * 注意 pi-ai 调用 resolve 的实参形如 { ctx, credential }（见
 * resolveProviderAuth → resolveApiKey），env 兜底必须走 ctx.env 而非
 * process.env：authContext 可能被 overrides.env 覆盖。
 */
function codeBuddyApiKeyAuth(displayName, envVars) {
  return {
    name: `${displayName} API Key`,
    login: async (interaction) => {
      const signal = interaction?.signal;
      signal?.throwIfAborted?.();
      const key = await interaction.prompt({ type: "secret", message: `Enter ${displayName} API Key` });
      signal?.throwIfAborted?.();
      return { type: "api_key", key };
    },
    resolve: async ({ ctx, credential, signal } = {}) => {
      signal?.throwIfAborted?.();
      if (credential?.key) {
        return {
          auth: { apiKey: credential.key },
          ...(credential.env ? { env: credential.env } : {}),
          source: "stored credential",
        };
      }
      for (const envVar of envVars) {
        const value = ctx?.env ? await ctx.env(envVar) : process.env[envVar];
        if (value) return { auth: { apiKey: value }, source: envVar };
      }
      return undefined;
    },
  };
}

function codeBuddyProvider(region, models, apiKeyAuth) {
  return createProvider({
    id: region.provider,
    name: region.displayName,
    baseUrl: region.baseUrl,
    // 【必须包成 { apiKey } 】pi-ai 的 resolveProviderAuth 以 provider.auth.apiKey
    // 为入口：`overrides.apiKey !== undefined && provider.auth.apiKey` 才走请求级
    // 覆盖分支，ambient 兜底同样读 provider.auth.apiKey.resolve。若把 ApiKeyAuth
    // 裸传给 auth，则 auth.apiKey === undefined → getAuth 恒为 undefined →
    // 每次请求都抛 "Provider is not configured"（2026-09-11 实修：上一轮改造
    // 裸传导致的回归；上游 167e8fc 的写法正是包了一层的 auth: { apiKey: … }）。
    auth: { apiKey: apiKeyAuth },
    models,
    api: codeBuddyApi,
  });
}

function resolvedProfile(provider, source, piProvider, configuredMaxTokens = new Map()) {
  const apiKeyEnv = source.apiKeyEnv === undefined ? undefined : credentialRef(source.apiKeyEnv);
  return {
    ...source,
    headers: runtimeHeaders(source.headers),
    provider,
    displayName: source.displayName ?? piProvider.name ?? provider,
    // dsh-llm-pi-ai 在目录解析时会为每个精确模型读取这个 map。本插件没有
    // 逐模型的校验失败项，但仍须提供空 map 以满足共享适配器 API
    // （上游 29ff497 修复；旧版本 pi-ai 不读该字段，补上对旧版无副作用）。
    modelErrors: new Map(),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(source.retryPolicy ?? CODEBUDDY_RETRY_POLICY, `${name}: provider "${provider}" retryPolicy`),
    configuredMaxTokens,
    piProvider,
  };
}

// 目录合成：在线目录（base）+ 配置声明（entries）。
//
// 语义要点：
//   - 配置里声明的 id 若在线目录也有 → 用配置规格覆盖该条（并把在线目录的
//     reasoning 信息作为兜底基线，避免覆盖时丢掉思考等级）。
//   - 配置里声明的 id 在线目录没有（如国际版的 hy4-preview / deepseek-v4.1-flash，
//     端点可用但不在 cli.models 白名单里）→ 追加到列表末尾。
//   - 空 entries 时原样返回在线目录。
//
// 历史坑（已修）：旧实现是 entries 非空就只返回 entries，等于"配置即全量"，
// 会把在线目录里的模型全部丢掉；且追加模型的 reasoning 基线为 undefined，
// 导致思考等级直接没了（reasoning: false）。
function selectCodeBuddyModels(region, base, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return base;
  const byId = new Map(base.map((model) => [model.id, model]));
  const declared = entries.map((entry) => {
    const model = byId.get(entry.id);
    const reasoning = configuredReasoning(entry, model);
    return codeBuddyModel({
      id: entry.id,
      name: entry.name ?? model?.name ?? entry.id,
      contextWindow: entry.contextWindow ?? model?.contextWindow ?? 262144,
      maxTokens: entry.maxTokens ?? model?.maxTokens ?? 32768,
      images: entry.input?.includes("image") ?? model?.input.includes("image") ?? false,
      region,
      // 配置可显式覆盖倍率（creditRate 数值）；否则保留在线目录的。
      creditRate: parseCreditRate(entry.creditRate) ?? model?.creditRate ?? parseCreditRate(entry.credits),
      ...reasoning,
    });
  });
  // 在线目录里未被配置声明的模型追加在后（保持服务端顺序）。
  const declaredIds = new Set(declared.map((model) => model.id));
  return [...declared, ...base.filter((model) => !declaredIds.has(model.id))];
}

// 共存模式：本插件只负责 CodeBuddy 两个 Provider（中国区 + 国际版），
// 不接管内置 llm-pi-ai 适配器，也不重复注册其内置 Provider（deepseek 等）。
// CodeBuddy 的配置存于独立命名空间 llm-codebuddy，避免与 llm-pi-ai 冲突。
function ownsProvider(provider) {
  return Object.hasOwn(CODEBUDDY_REGIONS, provider);
}

function runtimeHeaders(headers) {
  return { ...(headers ?? {}) };
}

function codeBuddySource(config, source, provider) {
  const region = CODEBUDDY_REGIONS[provider] ?? CODEBUDDY_REGIONS["codebuddy-cn"];
  return Object.hasOwn(config?.providers ?? {}, provider) ? source : { ...source, apiKeyEnv: source.apiKeyEnv ?? region.apiKeyEnv };
}

export const __testing = Object.freeze({
  authenticationHeaders,
  codeBuddyApiKeyAuth,
  codeBuddyRequestOptions,
  codeBuddySource,
  creditDescription,
  parseCreditRate,
  modelsFromConfig,
  modelsFromIds,
  ownsProvider,
  runtimeHeaders,
  selectCodeBuddyModels,
  regions: CODEBUDDY_REGIONS,
});

export function apply(ctx, config) {
  installCodeBuddyWeb(ctx);
  let current = () => config;
  // auth 已下沉到 regionProfile：每个区域一份（env 兜底读自己的 apiKeyEnv，
  // 见 codeBuddyApiKeyAuth 注释），不再共用、也不依赖 pi-ai 内置 provider 目录。

  const states = new Map();
  for (const region of Object.values(CODEBUDDY_REGIONS)) {
    states.set(region.provider, {
      region,
      remoteModels: undefined,
      generation: 0,
      memoRaw: undefined,
      memoGeneration: -1,
      memoized: undefined,
      loginSession: undefined,
      loginSessions: new Map(),
      activeAccountId: undefined,
      loginSessionPromise: undefined,
    });
  }

  // 共存模式：不注入默认 Provider。目录条目（见 directoryEntries）始终保留，
  // 使两个 CodeBuddy Provider 在「添加提供方」下拉框里始终可选；但只有用户
  // 真正添加过（配置里存在条目）才注册适配器路由——删除配置后模型选择器里
  // 不再出现该 Provider，需要时可从下拉框重新添加。
  const effectiveConfig = () => current() ?? {};

  const regionProfile = (state) => {
    if (state.memoRaw === current() && state.memoGeneration === state.generation && state.memoized) return state.memoized;
    const { region } = state;
    const source = effectiveConfig().providers[region.provider];
    const sourceWithAuth = codeBuddySource(current(), source, region.provider);
    const models = selectCodeBuddyModels(region, state.remoteModels ?? fallbackModels(region), source.models);
    const configured = new Map((source.models ?? []).flatMap((model) =>
      Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? [[model.id, model.maxTokens]] : [],
    ));
    const result = resolvedProfile(region.provider, {
      ...sourceWithAuth,
      displayName: region.displayName,
    }, codeBuddyProvider(region, models, codeBuddyApiKeyAuth(region.displayName, [region.apiKeyEnv])), configured);
    state.memoRaw = current();
    state.memoGeneration = state.generation;
    state.memoized = result;
    return result;
  };

  const profiles = () => {
    const result = new Map();
    for (const [provider, source] of Object.entries(effectiveConfig().providers)) {
      if (!Object.hasOwn(CODEBUDDY_REGIONS, provider)) continue;
      result.set(provider, regionProfile(states.get(provider)));
    }
    return result;
  };

  const resolveLoginSession = async (state, accountId) => {
    const cacheKey = accountId ?? "active";
    const cached = state.loginSessions?.get(cacheKey);
    if (cached?.expiresAt > Date.now()) return cached;
    state.loginSessionPromise ??= (async () => {
      const { region } = state;
      const credentials = ctx.get("credentials");
      const env = launchEnvironmentOf(ctx);
      const sessionsRef = credentialRef(region.sessionsRef);
      // 读侧兼容三代格式：本区域多账号 store → 本区域旧单账号 → 旧的单账号 ref
      //（旧 ref 只在中国区历史上存在过；国际版一直用自己的 ref）。
      let store;
      const sessionsStored = await credentials?.resolve(sessionsRef);
      const sessionsValue = sessionsStored?.value ?? env.get(sessionsRef)?.value;
      if (sessionsValue) {
        store = parseCodeBuddySessions(sessionsValue);
      } else {
        const sessionRef = credentialRef(region.sessionRef);
        const legacyStored = await credentials?.resolve(sessionRef);
        const legacyValue = legacyStored?.value ?? env.get(sessionRef)?.value;
        if (!legacyValue) throw new Error("未找到 CodeBuddy 登录凭据");
        const legacy = parseCodeBuddySession(legacyValue);
        store = createCodeBuddySessionStore([legacy], codeBuddySessionId(legacy));
      }
      // accountId 指定且存在 → 用它（web 用量路由按账号查询用）；
      // 否则用 store.activeId。多账号的会话缓存按账号各存一份。
      const active = (typeof accountId === "string" && accountId ? store.sessions.find((entry) => entry.id === accountId) : undefined)
        ?? activeCodeBuddySession(store);
      if (!active) throw new Error("未找到 CodeBuddy 登录账号");
      let session = active;
      if (sessionNeedsRefresh(session)) {
        session = await refreshCodeBuddySession(session, undefined, region.authBaseUrl);
        // 刷新结果回写 store（保持列表与 active 指针），并同步旧单账号 ref
        // 作为兼容指针——旧版本插件/CLI 读它也能拿到 active 账号。
        const nextStore = upsertCodeBuddySession({ ...store, activeId: active.id }, session);
        await credentials?.set(sessionsRef, serializeCodeBuddySessions(nextStore));
        await credentials?.set(credentialRef(region.sessionRef), serializeCodeBuddySession(session));
        state.activeAccountId = nextStore.activeId;
      } else {
        state.activeAccountId = active.id;
      }
      return { ...session, sessionId: active.id, expiresAt: sessionCacheDeadline(session) };
    })().finally(() => {
      state.loginSessionPromise = undefined;
    });
    const resolved = await state.loginSessionPromise;
    state.loginSessions ??= new Map();
    state.loginSessions.set(cacheKey, resolved);
    if (cacheKey === "active") state.loginSession = resolved;
    return resolved;
  };

  const resolveCredential = async (provider, profile) => {
    const ref = profile.apiKeyEnv;
    if (!ref && Object.hasOwn(CODEBUDDY_REGIONS, provider)) {
      const state = states.get(provider);
      let session;
      try {
        session = await resolveLoginSession(state);
      } catch (error) {
        throw new LlmError(`${name}: 未找到可用的 CodeBuddy 登录令牌，请运行 dsh-llm-codebuddy ${provider === "codebuddy-intl" ? "login-intl" : "login"}`, "MISSING_CREDENTIAL", { cause: error });
      }
      profile.headers ??= {};
      if (session.account.userId) profile.headers["X-User-Id"] = session.account.userId;
      if (session.account.enterpriseId) {
        profile.headers["X-Enterprise-Id"] = session.account.enterpriseId;
        profile.headers["X-Tenant-Id"] = session.account.enterpriseId;
      }
      if (session.auth.domain) profile.headers["X-Domain"] = session.auth.domain;
      return { value: assertUsableApiKey(session.auth.accessToken, name, "CodeBuddy login session"), kind: "bearer", sessionId: session.sessionId };
    }
    if (!ref) return { value: undefined, kind: "none" };
    const stored = await ctx.get("credentials")?.resolve(ref);
    const value = stored?.value ?? launchEnvironmentOf(ctx).get(ref)?.value;
    if (value) return { value: assertUsableApiKey(value, name, ref), kind: "api-key", ref };
    throw new LlmError(`${name}: Provider "${provider}" 缺少 API Key，请在 WebUI 的模型设置中填写`, "MISSING_CREDENTIAL");
  };

  const resolveApiKey = async (provider, profile) => (await resolveCredential(provider, profile)).value;

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get("attachments"),
  });
  const resolveModel = adapter.resolveModel.bind(adapter);
  adapter.resolveModel = async (provider, model, signal) => {
    const resolved = await resolveModel(provider, model, signal);
    if (!Object.hasOwn(CODEBUDDY_REGIONS, provider)) return resolved;
    const source = profiles().get(provider)?.piProvider.getModels().find((entry) => entry.id === model);
    // 倍率描述同样要在这里补（精确模型信息也会被 dsh-llm-pi-ai 丢弃，见 listModels 处说明）。
    const withDescription = source?.description && !resolved.description
      ? { ...resolved, description: source.description }
      : resolved;
    if (!withDescription.reasoning) return withDescription;
    const effort = source?.defaultReasoningEffort;
    if (!effort || !withDescription.reasoning.efforts.some((entry) => entry.id === effort)) return withDescription;
    return { ...withDescription, reasoning: { ...withDescription.reasoning, defaultEffort: effort } };
  };
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = async (provider) => {
    if (Object.hasOwn(CODEBUDDY_REGIONS, provider)) {
      const state = states.get(provider);
      if (!state.remoteModels) {
        state.refreshPromise ??= (async () => {
          try {
            const profile = profiles().get(provider);
            const credential = await resolveCredential(provider, profile);
            state.remoteModels = await fetchCodeBuddyModels(state.region, credential);
            state.generation += 1;
          } catch {
            // Keep the built-in catalog available while the key or network is absent.
          } finally {
            state.refreshPromise = undefined;
          }
        })();
        await state.refreshPromise;
      }
    }
    const entries = await listModels(provider);
    if (!Object.hasOwn(CODEBUDDY_REGIONS, provider)) return entries;
    // 【为什么要在这一层补 description】dsh-llm-pi-ai 的 listModels 只映射
    // provider/id/name/inputModalities 四个字段，会把我们挂在模型上的
    // description（积分倍率文案）丢掉；而 dsh-llm 的目录校验与前端
    // ModelSelect 都支持并渲染 model.description（输入框下方的模型选择框
    // 就在模型名下方显示这行小字）。所以在这里按 id 合并回去。
    const byId = new Map((profiles().get(provider)?.piProvider.getModels() ?? []).map((model) => [model.id, model]));
    return entries.map((entry) => {
      const source = byId.get(entry.id);
      if (!source?.description || entry.description) return entry;
      return { ...entry, description: source.description };
    });
  };

  const directoryEntries = () => [
    ...Object.values(CODEBUDDY_REGIONS).map((region) => ({
      provider: region.provider,
      displayName: region.displayName,
      settingsNs: NS,
      settingsPath: ["providers", region.provider],
      declared: false,
    })),
  ];

  let directory = ctx.llm.registerConfigurableProviders(directoryEntries());
  // 两个 Provider 都没配置时不能注册空路由（内置 llm-pi-ai 对空路由同样是延后注册），
  // 这里延迟到首次出现路由时再创建注册句柄。
  let registration;
  const syncRegistration = () => {
    const routes = [...profiles().keys()];
    if (!registration) {
      if (routes.length === 0) return;
      registration = ctx.llm.registerAdapter(routes, adapter);
      return;
    }
    registration.replace(routes);
  };
  syncRegistration();

  ctx.llm.registerModelDiscovery(NS, async (request) => {
    if (Object.hasOwn(CODEBUDDY_REGIONS, request.provider)) {
      const region = CODEBUDDY_REGIONS[request.provider];
      const state = states.get(request.provider);
      // 未配置（或刚删除）的 Provider 仍可从目录条目发起发现，此时回退到区域默认
      // 凭据引用，避免命中 undefined profile 导致 TypeError。
      const profile = profiles().get(request.provider) ?? { apiKeyEnv: region.apiKeyEnv };
      const credential = request.apiKey
        ? { value: request.apiKey, kind: "api-key", ref: region.apiKeyEnv }
        : await resolveCredential(request.provider, profile);
      state.remoteModels = await fetchCodeBuddyModels(region, credential, request.signal);
      state.generation += 1;
      return state.remoteModels.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
    }
    throw new LlmError(`没有 Provider "${request.provider ?? ""}" 的模型目录`, "DISCOVERY_FAILED");
  });

  // 共存模式：CodeBuddy 配置存于独立命名空间 llm-codebuddy（不复用 llm-pi-ai，
  // 避免与内置适配器竞争同一命名空间）。目录条目恒定注册，使两个 Provider 始终
  // 可从 WebUI「添加提供方」下拉框选取；适配器路由只覆盖用户实际添加过的 Provider。
  installCodeBuddySettings(ctx, Config, config ?? { providers: {} }, {
    setSource(source) {
      current = source;
    },
    onChange() {
      for (const state of states.values()) state.memoRaw = undefined;
      syncRegistration();
      directory.replace(directoryEntries());
    },
  });
}

/**
 * 注册 llm-codebuddy 设置命名空间，兼容 dsh 0.1.1 / 0.1.5 两代 settings API。
 *
 * 为什么需要兼容层：0.1.5 移除了模块级 `installSettingsSection`，而**具名导入在
 * ESM 链接期就会抛错**（"does not provide an export named ..."），会让插件加载失败
 * 并拖垮整棵插件树（真机现象：dsh web 起不来）。故改用命名空间导入 + 运行时探测，
 * 缺失时按能力回退，避免把版本号写死。
 *
 * 两代语义等价（已逐行比对上游实现）：
 *   0.1.1 `installSettingsSection(ctx, ns, schema, entry, hooks)`
 *         内部即 `ctx.inject(["settings"], sctx => sctx.settings.register(...))`
 *   0.1.5 `ctx.settings.installSection(ctx, ns, schema, entry, hooks)`
 *         官方插件 dsh-agent-default-model 即用此形式，函数体与旧版逐行一致。
 *
 * @param ctx - 插件上下文。
 * @param schema - 该命名空间的 schemastery schema。
 * @param entry - 组合基线值（用户文档之下的一层）。
 * @param hooks - setSource / onChange 回调，语义同上游 installSection。
 */
function installCodeBuddySettings(ctx, schema, entry, hooks) {
  const legacy = dshSettings.installSettingsSection;
  if (typeof legacy === "function") {
    // 0.1.1 路径：模块级函数自身会 ctx.inject(["settings"], …)，无需外层 inject
    legacy(ctx, NS, schema, entry, hooks);
    return;
  }
  // 0.1.5 路径：能力在 settings 服务上，需先声明对 settings 服务的依赖
  ctx.inject(["settings"], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined || typeof settings.installSection !== "function") {
      throw new Error(
        "llm-codebuddy: 当前 dsh 的 settings 服务不提供 installSection，" +
          "无法注册设置命名空间（0.1.1 与 0.1.5 两种 API 均不可用）"
      );
    }
    settings.installSection(ctx, NS, schema, entry, hooks);
  });
}
