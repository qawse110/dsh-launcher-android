import { isGatewayEnabled, isGatewayHostFromEnv, WILDCARD_GATEWAY_HOST } from './config.js';
import { CLOSE_DRAIN_ACTIVE_MS } from './server.js';
/** 期望状态（来自持久化）。`true` = 希望网关在运行。 */
let desiredEnabled = true;
/**
 * 期望状态（来自持久化）：「允许局域网访问」开关。
 *
 * `true` = 希望网关绑 `0.0.0.0`（局域网可达）；`false` = 只绑回环/env 配置的
 * 本机地址。默认 `false`：老用户升级后行为不变。⚠️ 与 `desiredEnabled` 同一
 * 取向——它只是**期望**，实际收敛见 {@link applyGatewayDesiredState}；env 显式
 * 给了 `DSH_OPENAI_GATEWAY_HOST` 时它不生效（env 优先，见 config.ts）。
 */
let desiredAllowLan = false;
/** 由 `mountOpenAiGateway` 注册，用于按需创建网关实例。 */
let factory;
/** 当前正在运行的实例；`undefined` 表示未在监听。 */
let running;
/**
 * 正在 `start()` 中的实例（已创建、尚未监听成功）。
 *
 * ⚠️ 存在的理由（Issue #11 审计）：`running` 只在 start **成功后**才赋值（那是
 * 正确的语义），但 `disposeGatewayRuntime()` 必须也能关掉「正在启动中」的那个 ——
 * 否则热重载/卸载在启动窗口内发生时，`dispose` 看到 `running === undefined`
 * 就跳过关闭，而实例随后 listen 成功 ⇒ **端口被一个没人持有的 server 占住**
 * （实测：下一条用例的「不应在监听」断言假红，且生产里表现为重启后 EADDRINUSE）。
 */
let starting;
/**
 * 最近一次创建出来的实例所持有的密钥。
 *
 * 网关**关闭后**仍要能读到 key —— 用户恰恰可能在停用状态下复制 key 去配
 * 外部客户端。只读 `running?.apiKey` 会在关闭的那一刻开始返回 `null`，
 * 于是「关掉网关再去看 key」变成拿不到。
 */
let lastApiKey = null;
/**
 * 最近一次收敛的失败原因（见 {@link gatewayLastError}）。
 *
 * ⚠️ 与 `running` **分开存**：`running === undefined` 有「主动关闭」与「启动
 * 失败」两种成因，而面板必须能区分 —— 前者不是错误，后者要显示可操作的提示。
 */
let lastError = null;
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
/** 读取「允许局域网访问」的期望状态。 */
export function gatewayDesiredAllowLan() {
    return desiredAllowLan;
}
/** 记录「允许局域网访问」的期望状态（**不**重建实例，由收敛完成换绑）。 */
export function setGatewayDesiredAllowLan(allowLan) {
    desiredAllowLan = allowLan;
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
 * 关掉一个实例，**永不抛出**。
 *
 * ⚠️ 存在的理由（Issue #11 审计发现）：原实现直接 `await gateway.close()`。
 * 一旦它抛错（例如 server 从未成功 listen 时 `close()` 会回 Error、或底层
 * 在途连接已损坏），异常会**冒到 `applyGatewayDesiredState` 的调用方** —— 而
 * 那个调用方是设置页的 RPC handler，于是「关网关」变成一次失败操作，且后续的
 * 重建被整段跳过。这与本模块「收敛链绝不向 UI 抛错」的契约直接冲突。
 *
 * 关闭失败**不代表实例还活着**：调用方在调用前就已经把 `running` 复位了，
 * 所以这里只需把失败降级成一条日志（含实例身份，便于排查是哪一个）。
 *
 * @param drainActiveMs 给在途请求的排水窗口（见 `OpenAiGateway.close` 的语义表）。
 *   缺省 `0` = 立刻中断 —— **用户主动关网关**的预期语义。
 */
async function closeQuietly(gateway, reason, drainActiveMs = 0) {
    try {
        await gateway.close({ drainActiveMs });
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[openai-gateway] 关闭实例失败（${reason}）：${detail}`);
    }
}
/**
 * 把实际运行状态收敛到期望状态。
 *
 * 幂等：已是目标状态时什么都不做，因此 RPC 与插件启动路径都能放心调用。
 * 启动失败（端口冲突等）只记日志并把 `running` 复位，**不抛**——调用方是
 * 设置页的同步 handler，抛错会变成用户可见的报错弹窗，而网关失败本来就不该
 * 影响 Jet Hub 其它功能。
 *
 * ⚠️ **host 也是期望状态的一部分**（v7，2026-10-20）：「允许局域网访问」开关
 * 翻转会改变监听地址，而 `listen()` 的绑定地址在创建时定格——改绑只能**关闭
 * 旧实例再重建**。收敛判据必须与工厂**同源**（`isGatewayHostFromEnv` 参与
 * 计算）：env 显式给了 host 时开关不生效，期望通配恒为 `false`，此时若拿
 * `desiredAllowLan` 裸比较，会因「重建后仍绑 env 地址」而**永远失配、反复重建**。
 *
 * ⚠️ **本函数必须可重入**（Issue #11 审计发现）：用户连点开关时两次收敛会重叠，
 * 而原实现是「读 `running` → 置 `undefined` → `await close()` → 重建」，两次
 * 调用会各自持有一个旧实例、各自重建，实测事件序列为
 * `close#1:begin → start#2 → close#1:end → start#3`（**start 2 次、close 只
 * 完成 1 次**）⇒ 第一个实例被永久泄漏。修法是把整个收敛体串行化。
 */
export async function applyGatewayDesiredState() {
    // ⚠️ 空闲时必须**同步进入** `convergeOnce()`（不额外让出 microtask tick）：
    // 既有接线用例用「让出 10 个 microtask」等待启动链完成，多一跳就会让
    // `isGatewayRunning()` 在断言点上仍是 false（实测 5 条既有用例假红）。
    // 忙碌时才排队 —— 那正是需要等待的语义。
    const previous = convergenceQueue;
    // ⚠️⚠️ 排队等待**必须带超时**（对抗审计发现的 P1，第二轮）：上一版只在看门狗
    // 到点时把 `convergenceQueue` 置空，但**已经排在前者后面的那些调用**仍然挂在
    // `previous.then(...)` 上 —— 而 `previous` 可能是一个永不 resolve 的 Promise。
    // 实测：看门狗触发后 `applyGatewayDesiredState()` 确实「完成」了，但
    // `factoryCalls` 仍是 1、`running` 仍是 false ⇒ **收敛体压根没执行**，
    // 只是不再无限等待而已 —— 用户点开关依旧无效。
    //
    // 修法：排队时与「看门狗超时」竞速 —— 超时就**放弃等待、自己收敛**
    // （读的是当前期望态，不重放别人的快照），保证「用户再点一次」永远有效。
    const run = previous === undefined
        ? convergeOnce()
        : Promise.race([
            previous.then(() => convergeOnce()),
            new Promise((resolve) => {
                const timer = setTimeout(() => {
                    console.error(`[openai-gateway] 上一次状态收敛超过 ${CONVERGENCE_WATCHDOG_MS}ms 未完成，`
                        + '本次开关操作不再等待它，直接按当前期望态收敛');
                    void convergeOnce().then(resolve, resolve);
                }, CONVERGENCE_WATCHDOG_MS);
                timer.unref?.();
                // 前者正常完成时清掉定时器（避免多打一条日志）。
                void previous.then(() => clearTimeout(timer), () => clearTimeout(timer));
            }),
        ]);
    // ⚠️ 清理必须**挂在 `run` 自己的链上**（而不是另起一条 `tracked.then()` 再回写）：
    // 后者会把「队尾复位」推迟一个 microtask，而「让出 N 个 microtask」的等待者
    // 可能正好落在中间 —— 实测表现为下一轮收敛看到 `previous = BUSY` 而**排队等
    // 一个早已完成的 Promise**：收敛体压根没执行（工厂零调用、`logs` 为空、
    // `running` 恒 false），且没有任何错误可查。这是 5 条既有接线用例假红的真因。
    //
    // ⚠️ 复位必须**按身份判**：若期间已有后来者把自己的尾指针写进来，说明还有
    // 收敛在排队，此时清空会让后来者失去串行保护（并发泄漏复发）。
    const clear = () => { if (convergenceQueue === tail)
        convergenceQueue = undefined; };
    const tail = run.then(clear, clear);
    convergenceQueue = tail;
    // ⚠️⚠️ **看门狗**（对抗审计发现的 P1）：串行化的代价是「一次永不完成的收敛会
    // 永久卡死队列」，而卡死后**没有任何自愈路径** —— `disposeGatewayRuntime` 只挂在
    // 插件卸载上，生产路径里没人调。实测：close 不返回 ⇒ 用户反复点开关也永远
    // `running: false`，且无错误可查。那比原 bug 更糟（原 bug 至少 120s 后自愈）。
    //
    // 判据刻意用**时间**而不是「等上一个完成」：收敛体内部每一步都已有自己的上限
    // （`close()` 有 CLOSE_GRACE_MS + CLOSE_DRAIN_MS），所以正常收敛远快于此阈值；
    // 超时只可能来自我们没料到的悬挂。到点就**主动放弃队尾**，让后续调用不再排队。
    // ⚠️ 不清 `running`/`factory`：那是收敛体的职责，看门狗只解队列，不猜状态。
    const watchdog = setTimeout(() => {
        if (convergenceQueue === tail) {
            convergenceQueue = undefined;
            console.error(`[openai-gateway] 一次状态收敛超过 ${CONVERGENCE_WATCHDOG_MS}ms 仍未完成，已放弃排队等待`
                + '（后续开关操作不再被它阻塞；若网关状态异常请重启 DSH）');
        }
    }, CONVERGENCE_WATCHDOG_MS);
    // ⚠️ `unref`：不能让这个定时器把宿主进程钉住（DSH 是长驻服务，但测试/CLI 会退出）。
    watchdog.unref?.();
    void run.then(() => clearTimeout(watchdog), () => clearTimeout(watchdog));
    return run;
}
/**
 * 单次收敛的看门狗上限。
 *
 * 取值 15s：收敛体的最坏情况是「关旧实例 + 起新实例」——`close()` 自带
 * 250ms（宽限）+ 1000ms（确认关闭）上限，`start()` 是本地 `listen`（毫秒级）。
 * 15 秒给了 10 倍余量，又远短于用户能忍受的「点了没反应」窗口。
 */
const CONVERGENCE_WATCHDOG_MS = 15_000;
/**
 * 收敛队列的尾指针；`undefined` = 当前空闲。
 *
 * ⚠️ 用 `undefined` 而不是 `Promise.resolve()` 表示空闲，是为了让空闲路径**同步**
 * 进入收敛体（见 {@link applyGatewayDesiredState} 的时序说明）。
 */
let convergenceQueue;
/** 收敛**一次**；调用方已保证串行（见 {@link applyGatewayDesiredState}）。 */
async function convergeOnce() {
    const shouldRun = isGatewayEnabled(process.env) && desiredEnabled;
    if (!shouldRun) {
        if (running === undefined) {
            // 主动关闭/被 env 停用**不是**错误：清掉上一轮的失败痕迹，
            // 否则面板会把「用户自己关掉的」显示成「启动失败」。
            lastError = null;
            return;
        }
        const gateway = running;
        running = undefined;
        await closeQuietly(gateway, '停用网关');
        lastError = null;
        return;
    }
    // 期望通配 = 开关打开 **且** env 没有显式给 host（与工厂的配置解析同一条件）。
    const desiredWildcard = desiredAllowLan && !isGatewayHostFromEnv(process.env);
    const runningWildcard = running?.address()?.host === WILDCARD_GATEWAY_HOST;
    if (running !== undefined && runningWildcard === desiredWildcard) {
        lastError = null;
        return;
    }
    // 需要（重）建：换绑必须重建（`listen()` 的地址在创建时定格）。
    //
    // ⚠️⚠️ 换绑**不能**走「先 await close() 再起新实例」（Gitee issue IKQODR 缺陷 2）：
    // 那样叠加出两个用户可见后果 —— ① 在途流被 `close()` 当场 abort（实测一轮 6 帧
    // 的流只收到 3 帧）；② 空窗期下游全被拒（实测 `ECONNREFUSED`）。
    //
    // 改成「先交端口 → 新实例接管 → 旧实例后台排水」：
    // - `detachListen()` 同步停 accept 并释放端口（实测 Node 24 之后同端口可立即
    //   `listen()`，已建立连接不受影响）⇒ 空窗期缩到近乎为零；
    // - 排水**不阻塞**换绑：`void` 出去，新实例立刻能起。旧实例多活一会儿没有任何
    //   用户可见成本（端口已交出、新连接已由新实例接管）。
    // ⚠️ `replaced` 标记「本轮是换绑」：换绑失败需要重试（见下面 start 的 catch）。
    let replaced;
    if (running !== undefined) {
        const stale = running;
        running = undefined;
        replaced = stale;
        // ⚠️ `detachListen` 是**同步**的，且必须在起新实例**之前**调用（否则端口还被
        // 旧实例占着 ⇒ 新实例 `listen` 撞 EADDRINUSE）。
        try {
            stale.detachListen();
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`[openai-gateway] 交出监听端口失败（换绑重建）：${detail}`);
        }
        // 后台排水：给在途请求跑完的窗口（`CLOSE_DRAIN_ACTIVE_MS`），不 await。
        void stale.close({ drainActiveMs: CLOSE_DRAIN_ACTIVE_MS }).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`[openai-gateway] 旧实例排水失败（换绑重建）：${detail}`);
        });
    }
    if (factory === undefined) {
        // 装配异常：没有工厂就永远起不来，必须让面板看见（Issue #11 建议 ②）。
        lastError = { kind: 'factory-missing', reason: '插件未注册网关实例工厂', at: Date.now() };
        console.error(`[openai-gateway] 网关期望运行但没有可用的实例工厂：${lastError.reason}`);
        return;
    }
    // ⚠️ `factory()` 必须自己兜一层（对抗审计 P2-2）：注释原先写「仍兜一层」，
    // 但**代码里没有 try/catch** —— 实测 factory 抛错时异常直接逃出本函数，
    // 冒到 RPC handler，且 `lastError` 保持 null、runtime 零日志。
    // 工厂按契约不该抛，但契约靠的是调用方自觉；单例模块级代码不能赌。
    let gateway;
    try {
        gateway = factory();
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        lastError = { kind: 'start-failed', reason: `网关实例创建失败：${detail}`, at: Date.now() };
        console.error(`[openai-gateway] 网关实例工厂抛出异常：${detail}`);
        return;
    }
    if (gateway === undefined) {
        lastError = { kind: 'start-failed', reason: '网关实例创建失败（配置或密钥初始化异常）', at: Date.now() };
        console.error(`[openai-gateway] 网关期望运行但实例创建失败：${lastError.reason}`);
        return;
    }
    // ⚠️⚠️ `running` 必须**在 start() 成功之后**才赋值（对抗审计 P0-2）。
    //
    // 原实现在 `await gateway.start()` **之前**就 `running = gateway`，而
    // `isGatewayRunning()` / `gatewayAddress()` 都读它 ⇒ 一旦 `start()` 挂住
    // （实测：`close()` 抢先、或底层 listen 不回调），面板会渲染
    // 「运行中 + API 请求地址：http://127.0.0.1:8326/v1」—— **声称可用而实际没监听**，
    // 用户拿着一个连不上的 URL 去排查，比「显示未运行」糟糕得多。
    //
    // 语义对齐：`running` 表示「**在监听**」，不是「已创建实例」。
    //
    // ⚠️ 但「正在启动中」的实例也必须被登记（`starting`）：否则 `disposeGatewayRuntime()`
    // 在启动窗口内被调用时会看到 `running === undefined` 而**跳过关闭** ⇒ 那个实例
    // 继续 listen（实测：热重载后端口仍被占，下一条用例的「不应在监听」断言假红）。
    starting = gateway;
    let failure;
    try {
        await gateway.start();
        running = gateway;
    }
    catch (error) {
        running = undefined;
        failure = error;
        // ⚠️⚠️ **换绑失败必须重试一次**（Gitee IKQODR 缺陷 2 的修复引入的新失败模式，
        // 自查实测）：换绑的第一步 `detachListen()` 已经把**旧实例的端口交出去了**，
        // 此时若新实例 `start()` 失败（端口被外部进程抢、或内核尚未回收），网关就
        // **完全没有监听**，而旧实例还在后台排水、不会自动恢复 —— 这比修复前更糟
        // （修复前旧实例至少还在监听）。
        //
        // 实测复现：`g1.detachListen()` → 外部占端口 → `g2.start()` 抛
        // `listen EADDRINUSE` ⇒ 端口此刻 `EADDRINUSE`（既不是 g1 也不是 g2 在服务）。
        //
        // 为什么重试有意义：`detachListen()` 是**同步**释放端口的，但内核回收有
        // 极短延迟；第一次失败往往就是这个窗口。重试一次（换新实例、新 socket）
        // 能把「换绑后无监听」压到近乎不可能。仍失败则如实记 `lastError`。
        if (replaced !== undefined) {
            // ⚠️ `factory()` 在这里**也要**包 try/catch（对抗审计 P2-2）：主路径已经显式
            // 守卫了同一风险（注释写着「工厂按契约不该抛，但契约靠的是调用方自觉；
            // 单例模块级代码不能赌」），**重试这一发漏了**。实测：factory 第三次调用抛错
            // ⇒ 异常**逃出 `applyGatewayDesiredState()`**，而 `lastError = null`、
            // `running = false` ⇒ 面板把「启动失败」显示成「用户主动关闭」，
            // 且 `jet-hub-rpc.ts` 的 `await applyGatewayDesiredState()` 变成一次失败操作。
            let retry;
            try {
                retry = factory();
            }
            catch (retryFactoryError) {
                const detail = retryFactoryError instanceof Error ? retryFactoryError.message : String(retryFactoryError);
                failure = retryFactoryError;
                console.error(`[openai-gateway] 换绑重试时实例工厂抛出异常：${detail}`);
            }
            if (retry !== undefined) {
                starting = retry;
                try {
                    await retry.start();
                    running = retry;
                    failure = undefined;
                    console.warn('[openai-gateway] 换绑后首次启动失败，重试成功');
                }
                catch (retryError) {
                    failure = retryError;
                    // 重试也失败 ⇒ 如实上报（下面统一记 lastError）
                }
                finally {
                    starting = undefined;
                }
            }
        }
    }
    finally {
        starting = undefined;
    }
    // ⚠️ 终态必须留痕（Issue #11 的建议 ②）：`shouldRun` 为真却没能监听，这是
    // **用户需要知道**的失败 —— 原实现把异常吞成 `running = undefined`，于是
    // 「网关静默消失」在日志里完全不可见，下游全部 connection refused 却被误读成
    // API-key 问题。用 error 级（而不是 info/warn）：它意味着功能不可用。
    if (running === undefined) {
        const detail = failure === undefined
            ? '未知原因'
            : (failure instanceof Error ? failure.message : String(failure));
        lastError = { kind: 'start-failed', reason: detail, at: Date.now() };
        console.error(`[openai-gateway] 网关期望运行但未能监听：${detail}`);
    }
    else {
        lastError = null;
    }
}
/**
 * 最近一次收敛留下的「期望运行但未监听」原因（`null` = 无异常）。
 *
 * ⚠️ 与 `isGatewayRunning()` 配对使用：`running === false` 且本值为 `null`
 * 表示「用户/env 主动关闭」，非 `null` 才是异常 —— 面板据此区分两种「没在跑」。
 */
export function gatewayLastError() {
    return lastError;
}
/** 插件卸载时调用：停掉网关并清空工厂，避免热重载后残留旧实例的引用。 */
export async function disposeGatewayRuntime() {
    // ⚠️ **必须先把收敛队列复位**（Issue #11）：本函数可能在一个收敛体还在飞的时候
    // 被调用（热重载、或测试里 `afterEach` 紧接 `mount` 的异步链）。若不清队列，
    // 下一次 `applyGatewayDesiredState()` 会看到 `convergenceQueue !== undefined`
    // 而去 `await` 一个**已无人推进/早已完成**的尾指针，于是收敛体压根不执行：
    // 工厂零调用、`running` 恒 false、**且没有任何错误可查**（实测正是 5 条既有
    // 接线用例假红的真因 —— 表现为「第二轮 mount 完全不生效」）。
    // 卸载语义下把队列视作空闲是安全的：实例都已销毁，残留的排队没有意义。
    // ⚠️⚠️ 顺序至关重要（对抗审计 P0-1）：`factory` 必须在 `await` **之前**清掉。
    //
    // 生产调用点是 `void disposeGatewayRuntime()`（`index.ts` 的 `ctx.effect`），
    // 不 await。而 `closeQuietly()` 里的真实 `close()` 有 250ms 宽限窗口 ——
    // 若 `factory` 留到 await 之后才清，这个窗口内任何一次收敛都会看到
    // 「`factory` 还在、`running` 已被置 undefined」⇒ 它调 `factory()` 新建实例 ⇒
    // 与尚未释放的端口撞 `EADDRINUSE`；而 dispose 的尾巴随后又把 `factory` 抹掉
    // ⇒ 此后**所有**收敛都报 `factory-missing`，**网关永久不可用**，面板那句
    // 「插件未注册网关实例工厂」对用户完全不可操作（实测复现）。
    // ⇒ 先把「不再接受新建」做完，再去做耗时的关闭。
    factory = undefined;
    convergenceQueue = undefined;
    const disposeStartedAt = Date.now();
    // ⚠️ 同时处理「正在启动中」的实例（见 `starting` 的理由）：它可能已经 listen
    // 成功但还没被赋给 `running`，漏掉就会留下一个占着端口、无人能关的 server。
    const toClose = [running, starting].filter((g) => g !== undefined);
    running = undefined;
    starting = undefined;
    for (const gateway of toClose) {
        // ⚠️ 这里不能抛（Issue #11）：本函数由 `ctx.effect` 的清理回调调用，
        // 抛错会变成一条无主的 unhandledRejection，而卸载流程必须走完（下面还要
        // 清密钥，否则热重载后新实例会沿用旧配置）。
        //
        // ⚠️ 卸载给在途请求**排水窗口**（Gitee issue IKQODR 缺陷 2）：插件重载时
        // 用户并没有要求中断任何请求。但这里**不能**真的等满 `CLOSE_DRAIN_ACTIVE_MS`
        // （10 分钟）—— 卸载是同步契约，等那么久会让 `ctx.effect` 的清理回调挂死。
        // 折中：先交端口（不砍请求），排水交给后台、不 await。
        try {
            gateway.detachListen();
        }
        catch { /* 已 detach，忽略 */ }
        void gateway.close({ drainActiveMs: CLOSE_DRAIN_ACTIVE_MS }).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`[openai-gateway] 卸载排水失败：${detail}`);
        });
    }
    // 密钥一并清掉：热重载后的新实例会重新解析，避免旧密钥被新配置继续使用。
    lastApiKey = null;
    // ⚠️ 失败痕迹要清（实测会跨测试/跨热重载残留）：`lastError` 描述的是
    // 「**这一次**收敛为什么没起来」，实例都销毁了它就不再成立 —— 留着会让下一次
    // 成功启动的面板仍然显示上一轮的「启动失败」原因。
    //
    // ⚠️ 但**不能无条件清**（对抗审计 P1-2）：dispose 在飞期间新一轮收敛可能真的
    // 失败了（实测日志有 `EADDRINUSE`），而这里的尾巴会把那条**真实**原因清成
    // null ⇒ 面板显示「网关已关闭」，真因丢失。判据：只有「本轮 dispose 开始**之前**
    // 就存在的旧痕迹」才清 —— 用时间戳，比比较对象引用更稳（新一轮可能写入同形对象）。
    // ⚠️ 判据必须是 `<=` 而不是 `<`：`Date.now()` 只有毫秒精度，而「失败发生」与
    // 「dispose 开始」经常落在**同一毫秒**内（实测：start 失败后立刻 dispose ⇒
    // `at === disposeStartedAt` ⇒ `<` 判 false ⇒ 旧痕迹没被清，跨热重载残留复发）。
    // 语义上「dispose 开始之前**或同时**发生的失败」都属于旧痕迹。
    if (lastError !== null && lastError.at <= disposeStartedAt)
        lastError = null;
}
//# sourceMappingURL=runtime.js.map