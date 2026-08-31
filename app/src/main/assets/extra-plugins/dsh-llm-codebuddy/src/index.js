import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { Config, PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createProvider } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CODEBUDDY_REGIONS,
  parseCodeBuddySession,
  refreshCodeBuddySession,
  serializeCodeBuddySession,
  sessionCacheDeadline,
  sessionNeedsRefresh,
} from "./codebuddy-auth.js";
import { installCodeBuddyWeb } from "./codebuddy-web.js";

export { Config };

export const name = "llm-codebuddy";
export const inject = ["llm"];

const NS = settingsNamespace("llm-codebuddy");
const USER_AGENT = "CLI/unknown CodeBuddy/2.137.1";
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

function codeBuddyModel({ id, name: modelName, contextWindow, maxTokens, images, region, reasoning = true, thinkingLevelMap = { off: null }, defaultReasoningEffort, thinkingFormat }) {
  return {
    id,
    name: modelName,
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

function modelsFromConfig(data, region) {
  const fallbackModelsList = fallbackModels(region);
  const agents = Array.isArray(data?.agents) ? data.agents : data?.agent?.agents;
  const cli = Array.isArray(agents) ? agents.find((agent) => agent?.name === "cli") : undefined;
  const allowed = Array.isArray(cli?.models) ? cli.models : [];
  const source = Array.isArray(data?.models) ? data.models : [];
  const byId = new Map(source.map((model) => [model?.id, model]));
  return allowed.flatMap((id) => {
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
      ...remoteReasoning(raw, fallback),
    })];
  });
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
  const models = modelsFromConfig(body.data, region);
  if (models.length === 0) throw new LlmError("CodeBuddy 没有返回 CLI 可用模型", "DISCOVERY_FAILED");
  return models;
}

function codeBuddyProvider(region, models, auth) {
  return createProvider({
    id: region.provider,
    name: region.displayName,
    baseUrl: region.baseUrl,
    auth,
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
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(source.retryPolicy, `${name}: provider "${provider}" retryPolicy`),
    configuredMaxTokens,
    piProvider,
  };
}

function selectCodeBuddyModels(region, base, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return base;
  const byId = new Map(base.map((model) => [model.id, model]));
  return entries.map((entry) => {
    const model = byId.get(entry.id);
    const reasoning = configuredReasoning(entry, model);
    return codeBuddyModel({
      id: entry.id,
      name: entry.name ?? model?.name ?? entry.id,
      contextWindow: entry.contextWindow ?? model?.contextWindow ?? 262144,
      maxTokens: entry.maxTokens ?? model?.maxTokens ?? 32768,
      images: entry.input?.includes("image") ?? model?.input.includes("image") ?? false,
      region,
      ...reasoning,
    });
  });
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
  codeBuddyRequestOptions,
  codeBuddySource,
  modelsFromConfig,
  ownsProvider,
  runtimeHeaders,
  selectCodeBuddyModels,
  regions: CODEBUDDY_REGIONS,
});

export function apply(ctx, config) {
  installCodeBuddyWeb(ctx);
  let current = () => config;
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  const apiKeyAuth = builtins.get("deepseek")?.auth;
  if (!apiKeyAuth) throw new Error(`${name}: pi-ai DeepSeek auth helper is unavailable`);

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
    }, codeBuddyProvider(region, models, apiKeyAuth), configured);
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

  const resolveLoginSession = async (state) => {
    if (state.loginSession?.expiresAt > Date.now()) return state.loginSession;
    state.loginSessionPromise ??= (async () => {
      const { region } = state;
      const credentials = ctx.get("credentials");
      const ref = credentialRef(region.sessionRef);
      const stored = await credentials?.resolve(ref);
      const value = stored?.value ?? launchEnvironmentOf(ctx).get(ref)?.value;
      if (!value) throw new Error("未找到 CodeBuddy 登录凭据");
      let session = parseCodeBuddySession(value);
      if (sessionNeedsRefresh(session)) {
        session = await refreshCodeBuddySession(session, undefined, region.authBaseUrl);
        await credentials?.set(ref, serializeCodeBuddySession(session));
      }
      return { ...session, expiresAt: sessionCacheDeadline(session) };
    })().finally(() => {
      state.loginSessionPromise = undefined;
    });
    state.loginSession = await state.loginSessionPromise;
    return state.loginSession;
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
      return { value: assertUsableApiKey(session.auth.accessToken, name, "CodeBuddy login session"), kind: "bearer" };
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
    if (!Object.hasOwn(CODEBUDDY_REGIONS, provider) || !resolved.reasoning) return resolved;
    const configured = profiles().get(provider)?.piProvider.getModels().find((entry) => entry.id === model);
    const effort = configured?.defaultReasoningEffort;
    if (!effort || !resolved.reasoning.efforts.some((entry) => entry.id === effort)) return resolved;
    return { ...resolved, reasoning: { ...resolved.reasoning, defaultEffort: effort } };
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
    return listModels(provider);
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
  installSettingsSection(ctx, NS, Config, config ?? { providers: {} }, {
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
