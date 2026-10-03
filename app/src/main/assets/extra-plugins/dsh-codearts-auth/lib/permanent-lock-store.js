/**
 * 「锁定永久积分」开关表的**独立**持久化文档。
 *
 * ## 为什么不与账号池同放一份 state.json（真实风险，用户 2026-09-29 定案）
 *
 * `$DSH_HOME/jet-hub/state.json` 是 **dsh home 级、全局共享**的：同机上多个
 * profile 用的是同一个 home，于是一台机器上的 `desktop` 与 `web` / `tui` /
 * `headless` 读到的是**同一份**账号池文档。
 *
 * 而本插件的存储是**整体替换**语义（`store.save(全量 state)`）。于是：
 *
 * | 步骤 | 发生什么 |
 * |---|---|
 * | 1 | desktop 侧（新代码）写入 `permanentLocks: { buddy: true }` |
 * | 2 | 用户在 web 侧（**旧代码，不认识该字段**）触发任意一次整体写入：加删账号、改模型开关、命中限流标记 |
 * | 3 | 旧代码全量重写 state.json，只带它认识的键 ⇒ `permanentLocks` **被抹掉** |
 * | 4 | desktop 侧读回 ⇒ CodeBuddy / WorkBuddy **静默解锁** |
 *
 * ⚠️ 后果不是显示问题，而是**行为**问题：解锁后选号继续消耗永久积分，
 * 而积分烧掉**不可撤回**。这与本文件反复记录的那类缺陷（"整体写入漏带字段
 * 就会被静默抹掉"）同源，区别只是这次漏带的一方是**另一条工作区里我们无法
 * 修改的旧版本代码**（用户刻意把 desktop 与 web 分成两个互不影响的工作区）。
 *
 * ⇒ 结论：**把锁定表拆到本文件这份独立文档**，旧代码从不读写它，两个工作区
 * 因此在这一点上真正互不干扰。
 *
 * ## 与旧版 state.json 的兼容（单向迁移，只认"文件不存在"）
 *
 * 该字段早先住在 state.json 的 `loomyPermanentLocked` 里，老用户磁盘上只有它。
 * 故本文档**不存在**时读老字段（保住升级前的状态）；一旦本文档存在，它就是
 * **唯一权威**，不再回看老字段 —— 否则用户在 desktop 里解锁 Loomy 后，会被
 * 老字段里那个陈旧的 `true` 重新拉回锁定态（写侧同时同步老字段，见 AccountPool）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizePermanentLocks } from './jet-hub-store.js';
import { resolveJetHubHome } from './jet-hub-store.js';
/** 独立文档的文件名（与 state.json 同目录）。 */
export const PERMANENT_LOCKS_FILE = 'permanent-locks.json';
/** 仅内存后端：无法定位 dsh home 时的显式降级（与 MemoryStore 同策）。 */
class MemoryLockStore {
    kind = 'memory';
    locks = {};
    written = false;
    load() {
        return { exists: this.written, locks: { ...this.locks } };
    }
    async save(locks) {
        this.locks = { ...locks };
        this.written = true;
    }
}
/** 文件后端：`$DSH_HOME/jet-hub/permanent-locks.json`（原子写：tmp + rename）。 */
class FileLockStore {
    path;
    logger;
    kind = 'file';
    constructor(path, logger) {
        this.path = path;
        this.logger = logger;
    }
    load() {
        try {
            if (!existsSync(this.path))
                return { exists: false, locks: {} };
            const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
            return { exists: true, locks: sanitizePermanentLocks(locksFieldOf(parsed)) };
        }
        catch (error) {
            // 损坏时按「文档存在但空表」处理：**不**回落到老的 state.json 字段 ——
            // 那条路径会把用户已解除的锁定重新打开（保守方向在这里是反的）。
            this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，按未锁定处理: ${String(error)}`);
            return { exists: true, locks: {} };
        }
    }
    async save(locks) {
        mkdirSync(join(this.path, '..'), { recursive: true });
        const tmp = `${this.path}.tmp`;
        // 带 schema 标记：与本仓库其它状态文档同惯例，便于将来演进时判别。
        writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, locks }, null, 2), 'utf-8');
        renameSync(tmp, this.path);
    }
}
const SCHEMA = 'dsh-codearts-auth/permanent-locks/v1';
/**
 * 取出文档里的锁定表字段，同时兼容**裸表**形态。
 *
 * 裸表（顶层直接 `{ buddy: true }`）不是本实现写出的形态，但状态文档可能被
 * 手工编辑过；认它比把它当空表更安全（后者会让用户的锁定凭空消失）。
 */
function locksFieldOf(parsed) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return parsed;
    const record = parsed;
    if (record.locks !== undefined)
        return record.locks;
    // 顶层含已知 provider 键或为空对象时视为裸表
    if (record.schema === undefined)
        return record;
    return {};
}
/**
 * 创建锁定表后端。
 *
 * home 的解析与账号池**同一个函数**（`resolveJetHubHome`），保证两份文档
 * 永远落在同一目录 —— 否则会出现「账号池在 A 处、锁定表在 B 处」的分裂。
 */
export function createPermanentLockStore(ctx) {
    const home = resolveJetHubHome(ctx);
    if (home === undefined) {
        ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，永久积分锁定开关仅存在于内存中');
        return new MemoryLockStore();
    }
    return new FileLockStore(join(home, 'jet-hub', PERMANENT_LOCKS_FILE), ctx.logger);
}
//# sourceMappingURL=permanent-lock-store.js.map