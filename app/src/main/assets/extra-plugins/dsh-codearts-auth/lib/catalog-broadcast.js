/**
 * 目录变更广播的**唯一**实现（issue IKJVTF）。
 *
 * ## 为什么需要它
 *
 * DSH 客户端 `dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把
 * `modelCatalog` 响应缓存进一个 `status === 'ready'` 即**短路返回**的 store，
 * 只在四个宿主事件上 `refresh()`：`llm/adapters-updated` /
 * `settings/document-updated` / `credentials/record-updated` /
 * `credentials/reference-updated`。
 *
 * 于是「**远端模型目录刚刚落地**」这件事必须显式广播 —— 冷启动首拉失败时
 * 客户端会把**兜底表**缓存成 ready，此后远端目录真的拿到也**没有任何事件**
 * 通知它重读 ⇒ 永久分叉：Jet Hub 设置页（走插件 RPC，每次实时）显示 5 个模型，
 * 对话框选择器（走 DSH `buildModelCatalog` → `ctx.llm.listModels()`）只剩 2 个。
 * 修复前十个适配器的 `ensureRemoteModels` 全是 **0 处广播**。
 *
 * ## 三条语义
 *
 * 1. **同 tick 合并**：一次目录落地会牵动多个 provider / 多个调用点，
 *    逐个 emit 会让客户端刷新 N 次。同一 `ctx` 在本次派发完成前只排一次。
 * 2. **`queueMicrotask` 派发，不同步 emit**：`llm/adapters-updated` 的监听器
 *    会再次走 `buildModelCatalog` → `listModels` → 可能又触发一次目录落地。
 *    同步 emit 会把这条链变成**重入**（在闸门的 `run` 里再进 `run`）。
 *    排到 microtask 后，闸门的 `inFlight` 已能正确合并这类重入。
 * 3. **派发期间保持合并标记**：`pending` 在 `emit` **之后**才清 —— 否则
 *    emit 期间的重入会被当成「新的一轮」再排一次，形成广播风暴。
 *    emit 返回后才清，使「异步落地的新一轮」仍能正常广播。
 *
 * ⚠️ 广播失败**只记日志**：目录已经落地了，因通知失败而抛错会让调用方
 * （`listModels` 的宿主路径）以为目录加载失败。与 `jet-hub-rpc.ts` 里
 * 「通知失败不能反噬已经落盘的开关」是同一条约定。
 */
/**
 * 已排程待派发的 ctx 集合（同 tick 合并用）。
 *
 * 用 `WeakSet` 而非 `Set`：ctx 是长生命周期对象，且插件可能被卸载重建 ——
 * 不持有强引用，卸载后条目自然回收，不会把旧 ctx 永久留在集合里。
 */
const pending = new WeakSet();
/**
 * 广播「模型目录可能已变化」。
 *
 * 幂等：同一 `ctx` 在本次派发完成前重复调用只排一次。
 */
export function broadcastCatalogChanged(ctx) {
    if (pending.has(ctx))
        return;
    pending.add(ctx);
    queueMicrotask(() => {
        try {
            ctx.emit('llm/adapters-updated');
        }
        catch (error) {
            ctx.logger?.warn?.(`[jet-hub] 广播模型目录变更事件失败：${String(error)}`);
        }
        finally {
            // ⚠️ **必须在 emit 之后清**（不是之前）：emit 同步触发的监听器会重入
            // `listModels` → 可能再次调到这里，那时若标记已清就会再排一个 microtask，
            // 每次派发都翻一倍 —— 广播风暴。emit 期间保持标记即把这类重入合并掉。
            // 异步落地的新一轮（emit 返回之后才拿到目录）不受影响，照常广播。
            pending.delete(ctx);
        }
    });
}
//# sourceMappingURL=catalog-broadcast.js.map