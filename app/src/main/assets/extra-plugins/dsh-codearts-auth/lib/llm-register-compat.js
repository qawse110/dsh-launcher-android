/**
 * `ctx.llm` 适配器注册的**重启幂等**包装。
 *
 * ## ⚠ 为什么需要（真实故障，2026-09-30 合并 master 后）
 *
 * 合并当晚 web profile 的插件树激活失败，**整个 Jet Hub RPC 不可用**
 *（所有 provider 面板 404）：
 *
 * ```
 * LlmError: configurable provider "minimax" is already declared
 *   at registerConfigurableProviders (…/dsh-llm/lib/index.js:1937)
 *   at registerMinimaxLlm (lib/minimax-adapter.js:352)
 *   at new apply (lib/index.js:920)
 * ```
 *
 * ## 根因（cordis + dsh-llm 的生命周期交互）
 *
 * `ctx.llm.registerAdapter()`（以及当时的 `registerConfigurableProviders()`）内部都是
 * `this.ctx.effect(…)` —— **effect 挂在 llm 服务的 ctx 上**（`super(ctx,'llm')`
 * 的那个），其生命周期绑定**宿主根 zone**。而插件 apply 里注册的**其它**资源
 * 挂在插件 fiber 上。当宿主在启动过程中**重启插件 fiber**（config/patch 应用
 * 时序），新 fiber 的同步 apply 与旧 fiber 的异步 dispose（cordis 1077 行：
 * `return async () => {…}`）**交错执行**：
 *
 * - 新 apply 逐个注册 provider —— 每个都调 `directory.has()` 检查；
 * - 旧 dispose **异步地**逐个清理 —— 两者在 `directory` 这个 Map 上赛跑。
 *
 * 赛跑的**确定性结果**取决于 Map 的插入/删除顺序与两边步调 —— 实测稳定撞在
 * 序列后段的 `minimax`（它紧邻合并新增的 zcode，注册时间最长，给异步 dispose
 * 留下了追上来的窗口）。既有 10 个 provider 从没撞过，是因为它们的注册序更靠前、
 * dispose 追不上；minimax 是**第 11 个**，恰好越过了临界点。
 *
 * ## 修复语义
 *
 * `an adapter for provider … is already declared` 意味着「**同名的注册已存在**」。
 * 在重启场景下那是**上一轮同一个插件的注册**（同一代码）—— 保留它、跳过本次提交
 * 是**语义等价**的：路由同样指向等价的实现。
 *
 * ⚠ 这**不是**吞错误：非重复类失败照常抛出（配置错等必须暴露）。
 * 也没有用「先查 directory 再注册」——查与注册之间存在同样的竞态窗口，
 * 只有 try/catch 能把检查与提交做成原子。
 *
 * ## ⚠ configurable provider 声明已**刻意停用**（2026-10-01，用户要求）
 *
 * **现象**：「设置 → 模型 → 提供商」里常驻十二行本插件的 provider（codearts /
 * buddy / workbuddy / lobsterai / qoder / qodercn / trae / cline / loomy /
 * raccoon / minimax / zcode），每行都带 API 密钥、baseURL 与模型目录编辑框，
 * 但这些对本插件**没有意义** —— 凭据由 Jet Hub 账号池 + `ctx.credentials` 注入，
 * 模型开关与模型目录也都在 Jet Hub 设置页管理。
 *
 * **机制**（依据 `dsh-client-ui-settings-models` 的产物源码）：
 * - 该页的行**只**来自 `ctx.llm.registerConfigurableProviders()` 声明的目录
 *   （`joinProviderDirectory()`：声明过的进目录行，未声明的存活路由只进模型选择器）；
 * - 「已配置」的判据是 `namespace 存在 && (settingsPath.length === 0 ||
 *   schema.getPath(namespace.value, settingsPath) !== undefined)`（`configured`）；
 *   本插件传的 `settingsPath: []` 使该条件**恒真** —— 于是它们不是「待设置卡片」，
 *   而是十二行常驻的已配置行，永远无法从页面上消失。
 *
 * **代价评估**（均在 DSH 0.2.0-rc.2 的打包产物里逐条核对）：
 * - **模型选择器不受影响**：未声明的存活路由在各选择器中仍然可见（dsh-llm 文档明示）；
 * - **首次运行引导不受影响**：`providerUsable()` 对「没有 settings 地址的活跃路由」
 *   返回 true，故不会因此重新弹出官方 DeepSeek 凭据步骤；
 * - `dsh-api-session-controller` 的 `hasProviderApiKey` 扫的是各 provider profile 的
 *   `apiKeyEnv`，本插件的 namespace 里没有该字段，本就恒为 false。
 *
 * **因此**：各 adapter 的 `registerXxxLlm` 只调 {@link registerAdapterIdempotent} 注册
 * 路由，**不再**声明可配置 provider。**恢复方式**：从 git 历史取回本文件的旧版本
 *（含 `registerConfigurableProvidersIdempotent`），在十个 adapter 的 `registerXxxLlm`
 * 里恢复 `ctx.llm.registerConfigurableProviders([...])` 声明块，并恢复
 * `settingsNamespaceFor()` 的调用 —— 该函数与 `ownEntryId` 仍保留在
 * `settings-compat.ts` 中（当前无调用方）。
 */
/** dsh-llm 对「configurable provider 已存在」抛的 code。**当前仅作防御**保留。 */
const DUPLICATE_DIRECTORY = 'DUPLICATE_DIRECTORY';
/**
 * 判断一个 LlmError 是否为「同名注册已存在」。
 *
 * ⚠ 判据**必须**含错误码 **或** 文案：dsh-llm 对 adapter 重复的抛错
 *（`an adapter for provider "x" is already declared`）用的不是
 * DUPLICATE_DIRECTORY 码，且不同 dsh 版本的码可能微调 —— 文案兜底保证
 * 跨版本行为一致。⚠ 只匹配「already declared / already registered」这类
 * 精确语义，不碰泛词（否则会把真实配置错误吞掉）。
 */
function isDuplicateRegistrationError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    if (code === DUPLICATE_DIRECTORY)
        return true;
    const message = error.message;
    if (typeof message !== 'string')
        return false;
    return /already declared|already registered|is already (?:a|an) adapter/.test(message);
}
/**
 * 幂等版的 `ctx.llm.registerAdapter`。
 *
 * ⚠ 重复场景下的行为：保留现有 adapter 路由（重启竞态，见模块头）。
 * ⚠ 返回 dsh-llm 的 handle（含 `.replace()`）——重复分支没有 handle 可还，
 * 返回 `undefined`；调用方若需要 replace 能力应保存成功路径的返回值。
 */
export function registerAdapterIdempotent(llm, providers, adapter, warn) {
    try {
        return llm.registerAdapter(providers, adapter);
    }
    catch (error) {
        if (!isDuplicateRegistrationError(error))
            throw error;
        warn?.(`[llm-register] adapter for ${providers.map((p) => `"${p}"`).join(', ')} `
            + '已注册（插件 fiber 重启竞态），保留现有路由并跳过本次注册');
        return undefined;
    }
}
//# sourceMappingURL=llm-register-compat.js.map