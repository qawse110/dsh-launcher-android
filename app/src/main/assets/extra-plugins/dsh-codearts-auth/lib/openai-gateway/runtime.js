import { isGatewayEnabled } from './config.js';
/** 期望状态（来自持久化）。`true` = 希望网关在运行。 */
let desiredEnabled = true;
/** 由 `mountOpenAiGateway` 注册，用于按需创建网关实例。 */
let factory;
/** 当前正在运行的实例；`undefined` 表示未在监听。 */
let running;
/**
 * 最近一次创建出来的实例所持有的密钥。
 *
 * 网关**关闭后**仍要能读到 key —— 用户恰恰可能在停用状态下复制 key 去配
 * 外部客户端。只读 `running?.apiKey` 会在关闭的那一刻开始返回 `null`，
 * 于是「关掉网关再去看 key」变成拿不到。
 */
let lastApiKey = null;
/**
 * 注册网关实例工厂（由 `mountOpenAiGateway` 调用，只应注册一次）。
 *
 * 这里顺手把实例的密钥记到 {@link lastApiKey}：工厂是唯一会创建实例的地方，
 * 在这里捕获就保证「设置页读到的 key」与「网关在用的 key」**必然**同源 ——
 * 多开一条读密钥的通道就有可能读到不一致的那份，症状是复制出去一律 401。
 */
export function registerGatewayFactory(create) {
    factory = () => {
        const gateway = create();
        if (gateway !== undefined)
            lastApiKey = gateway.apiKey;
        return gateway;
    };
}
/** 读取用户选择的期望状态。 */
export function gatewayDesiredEnabled() {
    return desiredEnabled;
}
/** 记录用户选择的期望状态（**不**启停，由 {@link applyGatewayDesiredState} 收敛）。 */
export function setGatewayDesiredEnabled(enabled) {
    desiredEnabled = enabled;
}
/** 网关当前是否真的在监听端口。 */
export function isGatewayRunning() {
    return running !== undefined;
}
/** 网关当前实际监听的地址；未运行时返回 `undefined`（设置页据此显示端口）。 */
export function gatewayAddress() {
    return running?.address();
}
/**
 * 网关正在使用的密钥来源（值 + 文件路径 + 是否来自环境变量）。
 *
 * 密钥在 `createOpenAiGateway()` 时就已解析，因此**网关未运行时也能返回** ——
 * 用户恰恰需要在停用状态下就能复制 key 去配外部客户端。
 *
 * ⚠️ 拿不到时返回 `null`（网关被 env 停用、初始化失败、或还没创建实例），
 * 由调用方决定如何提示；**不要**在这里造一个占位 key，那会让用户复制到一个
 * 永远 401 的串。
 */
export function gatewayApiKey() {
    return running?.apiKey ?? lastApiKey;
}
/**
 * 把实际运行状态收敛到期望状态。
 *
 * 幂等：已是目标状态时什么都不做，因此 RPC 与插件启动路径都能放心调用。
 * 启动失败（端口冲突等）只记日志并把 `running` 复位，**不抛**——调用方是
 * 设置页的同步 handler，抛错会变成用户可见的报错弹窗，而网关失败本来就不该
 * 影响 Jet Hub 其它功能。
 */
export async function applyGatewayDesiredState() {
    const shouldRun = isGatewayEnabled(process.env) && desiredEnabled;
    if (shouldRun) {
        if (running !== undefined || factory === undefined)
            return;
        // 工厂按契约不抛，但仍兜一层：单例模块级的代码不能因为调用方的疏漏
        // 把异常带进设置页的同步 handler。
        const gateway = factory();
        if (gateway === undefined)
            return;
        running = gateway;
        try {
            await gateway.start();
        }
        catch {
            running = undefined;
        }
        return;
    }
    if (running === undefined)
        return;
    const gateway = running;
    running = undefined;
    await gateway.close();
}
/** 插件卸载时调用：停掉网关并清空工厂，避免热重载后残留旧实例的引用。 */
export async function disposeGatewayRuntime() {
    if (running !== undefined) {
        const gateway = running;
        running = undefined;
        await gateway.close();
    }
    factory = undefined;
    // 密钥一并清掉：热重载后的新实例会重新解析，避免旧密钥被新配置继续使用。
    lastApiKey = null;
}
//# sourceMappingURL=runtime.js.map