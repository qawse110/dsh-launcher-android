import { isGatewayEnabled } from './config.js';
import { resolveJetHubHome } from '../jet-hub-store.js';
import { applyGatewayDesiredState, disposeGatewayRuntime, registerGatewayFactory, setGatewayDesiredEnabled, } from './runtime.js';
import { createOpenAiGateway } from './server.js';
/**
 * 桥接宿主的附件服务，供网关把客户端的 base64 图片落成 DSH 附件。
 *
 * 与 `src/index.ts` 的 `makeReadImage`（读方向）同款思路：用 `ctx.get` 而非
 * `inject` —— 附件服务缺失时**插件与网关的文本能力都不该受影响**，只是收到
 * 图片时报「未装载附件服务」。
 *
 * ⚠️ `saveImage` 的形状 `{ data, mediaType }` 来自临时探针的实测（`attachmentId`
 * 是 `sha256:` 内容寻址，媒体类型会被服务端按字节校验）。见 `images.ts` 文件头。
 */
function makeGatewayAttachmentBridge(ctx) {
    const attachments = ctx.get('attachments');
    if (attachments?.saveImage === undefined)
        return undefined;
    return { saveImage: (input) => attachments.saveImage(input) };
}
/**
 * 启动对外兼容网关，并把关闭动作绑定到插件生命周期。
 *
 * ⚠️ **本函数绝不能抛异常**。它由 `src/index.ts` 的 `apply()` 直接调用，
 * 任何抛错都会让整个 `codearts-auth` 插件加载失败 —— 12 个 provider 的
 * 登录、积分、模型目录全部不可用。网关只是旁路功能，失败只应降级为一条日志。
 *
 * ⚠️ 必须**同时**保护创建（同步）与收敛（异步）：工厂闭包体内的
 * `createOpenAiGateway()` 会同步执行 `resolveGatewayConfig()`（端口 env 非法即抛）
 * 与 `loadOrCreateApiKey()`（home 不可写即抛），只 catch 异步部分接不住 ——
 * 这正是初版只给 `gateway.start()` 加 catch 时留下的缺陷。
 */
export function mountOpenAiGateway(ctx, pool) {
    const logger = {
        info: (message) => ctx.logger?.info?.(message),
        warn: (message) => ctx.logger?.warn?.(message),
        error: (message) => ctx.logger?.error?.(message),
    };
    const describe = (error) => (error instanceof Error ? error.message : String(error));
    try {
        // 设置页里的开关是**期望状态**：缺键 / 读取失败一律按启用（老用户行为不变），
        // 真正的判定（含 env 的更高优先级）在 runtime 里做。
        setGatewayDesiredEnabled(pool?.gatewayEnabled() !== false);
        registerGatewayFactory(() => {
            // 工厂在**收敛时**才被调用（可能是设置页在运行期触发的启动），
            // 故同步异常必须在这里就地消化 —— 见 `GatewayFactory` 的契约。
            try {
                return createOpenAiGateway({
                    ctx,
                    llm: ctx.llm,
                    // 图片入站：把客户端的 base64 图片落成 DSH 附件。缺失时网关仍可正常
                    // 提供文本能力，收到图片时明确报「未装载附件服务」而非静默丢图。
                    attachments: makeGatewayAttachmentBridge(ctx),
                    home: resolveJetHubHome(ctx),
                    logger,
                });
            }
            catch (error) {
                logger.error(`[openai-gateway] 初始化失败，本机网关未启动：${describe(error)}`);
                return undefined;
            }
        });
    }
    catch (error) {
        // 配置非法或 key 无法持久化：网关不可用，但插件其余功能必须照常工作。
        logger.error(`[openai-gateway] 初始化失败，本机网关未启动：${describe(error)}`);
        return;
    }
    // 端口冲突等启动期失败由 runtime 内部消化（不抛），不阻断 Desktop 其它功能。
    if (!isGatewayEnabled(process.env)) {
        // 显式停用也要留痕：否则用户设了 env 却看不到任何提示，只能靠猜。
        // 仍继续挂载 runtime —— 设置页需要据此显示「被 env 阻止」而不是「开关坏了」。
        logger.info('[openai-gateway] DSH_OPENAI_GATEWAY_ENABLED 已停用本机网关');
    }
    void applyGatewayDesiredState().catch((error) => {
        logger.error(`[openai-gateway] 启动异常：${describe(error)}`);
    });
    ctx.effect(() => () => {
        void disposeGatewayRuntime();
    }, 'openai-gateway');
}
//# sourceMappingURL=index.js.map