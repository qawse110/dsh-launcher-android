/**
 * Token 账本**每日聚合**的持久化文档（第 2 期）。
 *
 * ## 形态与取舍
 *
 * - **只落日聚合，不落明细**：明细（每笔请求一行）在 UI 已有内存版（500 条，
 *   重启即丢是**既定行为**）；持久化要回答的是「本周/这个月用了多少」，
 *   天然粒度就是**日**。日聚合把每笔请求摊平成「UTC+8 日 × 渠道 × provider ×
 *   账号 × 模型」一格，写入量与请求量解耦（同一格只加数，不增行）。
 * - **独立文档**（`token-ledger.json`），不进 state.json —— 理由与
 *   `permanent-lock-store.ts` 完全同源：state.json 被**另一条工作区的旧代码**
 *   整体重写时会静默抹掉它不认识的键。
 * - **节流落盘**（1 秒防抖）：记账不在推理关键路径同步写盘；落盘前 flush 文件，
 *   插件正常 dispose 也会立即刷盘。进程异常崩溃最多丢最近 1 秒的计数。
 * - **跨进程互斥增量合并写**：同一账本路径通过原子创建锁目录串行化
 *   read-merge-rename；锁占用时 flush 延后重试，过期且进程退出的锁会被回收。
 *
 * ## 已知限制：「外部删除某日键 + 该日之后又有增量」⇒ 本次运行内读数偏高
 *
 * `flush()` 只写**增量**，而增量的基线是**本实例内存里的值**。若盘上某日键被
 * 外部删除（手工编辑 / 另一工作区的旧版本整体覆盖 / 从备份恢复），而该日随后
 * **又产生了新的真增量**，则只写该增量、不写被删掉的那部分：
 *
 * ```
 * 昨日记 20 落盘 → 外部删掉昨日 → 昨日又产生增量 5 → flush
 * 运行中（内存 / UI）昨日 = 25
 * 重启后（盘上）    昨日 = 5     ← 被外部删掉的 20 不会回来
 * ```
 *
 * ⚠️ **这是有意的取舍，不是缺陷**：盘上那一格是被**外部权威地删除**的，把它
 * 「复活」等于无视用户的删除意图（本仓库 `permanent-lock-store.ts` 的迁移判据
 * 「文档存在则它是唯一权威」是同款思路）。代价是**本次运行内**的读数会高于
 * 重启后的读数 —— 触发前提是外部干预；无外部删除时两者恒等。
 *
 * ⚠️ 与上一节**不同源**：那条是两进程同时写，本条是外部删除后本地继续写。
 *
 * ## 日界
 *
 * UTC+8（各渠道每日额度的结算时区），见 `utc8DayKey`。**保留天数**
 * {@link TOKEN_LEDGER_DAYS}：默认 90 天，更早的日桶在落盘时淘汰 ——
 * 用户「看看历史」的诉求远小于无限增长的文件。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveJetHubHome } from './jet-hub-store.js';
import { isValidTokenLedgerDayKey, mergeDayEntry, parseDayBucketKey, TPS_HISTOGRAM_BINS, } from './token-ledger.js';
/** 独立文档的文件名（与 state.json 同目录）。 */
export const TOKEN_LEDGER_FILE = 'token-ledger.json';
/** 日聚合保留天数（落盘时淘汰更早的日键）。 */
export const TOKEN_LEDGER_DAYS = 90;
/** 落盘节流窗口（毫秒）。 */
export const TOKEN_LEDGER_FLUSH_MS = 1_000;
const SCHEMA = 'dsh-codearts-auth/token-ledger/v2';
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_ABANDON_MS = 5 * 60_000;
/** 锁竞争告警的限流间隔（见 `warnLockContention`）。 */
const LOCK_WARN_INTERVAL_MS = 5 * 60_000;
/** 从本地文件读数时拒绝负数、NaN 和无穷值；计数类字段再截为整数。 */
function storedNumber(value, integer = true) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0)
        return 0;
    return integer ? Math.trunc(number) : number;
}
/**
 * ⚠️ 桶键合法性**唯一判据**是 `token-ledger.ts` 的 {@link parseDayBucketKey} ——
 * 本文件**不得**再写第二份校验。
 *
 * 真实缺陷：这里曾另写一份 `isValidBucketKey`（额外要求 `model` 非空），与读取侧
 * 分叉。写入侧允许 `model: ''`（既有语义，见 `token-ledger-wiring.spec.ts` 的
 * 「model 缺失/垃圾值记空串不抛错」），而那份加严的校验会把这类**已经写进盘**的桶
 * 判为非法 ⇒ 重启后该日用量静默消失。两个方向都会复发：加严让已有数据读不回，
 * 放宽让脏键进入聚合。
 */
function readTpsHistogram(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return {};
    const histogram = {};
    for (const [key, rawCount] of Object.entries(value)) {
        const bin = Number(key);
        const count = storedNumber(rawCount);
        if (Number.isInteger(bin) && bin >= 0 && bin < TPS_HISTOGRAM_BINS && count > 0) {
            histogram[String(bin)] = count;
        }
    }
    return histogram;
}
/** 淘汰过老日键后的浅拷贝（不改调用方的表）。 */
function pruneDays(days) {
    const cutoff = Date.now() + 8 * 60 * 60 * 1000 - TOKEN_LEDGER_DAYS * 24 * 60 * 60 * 1000;
    const pruned = new Map();
    for (const [day, buckets] of days) {
        // 日键 `YYYY-MM-DD` 的 UTC+8 当日 24:00 ≈ 该日 00:00 + 1 天；用日首 +8h 对齐比较即可。
        const dayStartUtc8 = Date.parse(`${day}T00:00:00Z`) - 8 * 60 * 60 * 1000;
        if (Number.isFinite(dayStartUtc8) && dayStartUtc8 < cutoff)
            continue;
        pruned.set(day, buckets);
    }
    return pruned;
}
/** 内存后端：无法定位 home 时的显式降级（与 MemoryStore 同策）。 */
class MemoryLedgerStore {
    days = new Map();
    load() {
        return this.days;
    }
    append(entry) {
        mergeDayEntry(this.days, entry);
    }
    deleteDay(day) {
        return this.days.delete(day);
    }
    flush() {
        // 内存后端无盘可落。
    }
}
/** 文件后端：`$DSH_HOME/jet-hub/token-ledger.json`（原子写 + 节流）。 */
class FileLedgerStore {
    path;
    logger;
    days = new Map();
    /**
     * **已落盘基线**：上次成功写盘时各桶的快照。
     *
     * `flush()` 只把「相对本基线新增的增量」合并进**盘上当前内容**（见 flush 的
     * 注释）。基线在每次成功写盘后前移。
     */
    written = new Map();
    /** 防抖计时器（Node 返回值带 unref，浏览器/测试环境可能没有）。 */
    timer;
    /** 节流窗口内又发生了写入时，flush 后需要再排一次。 */
    dirty = false;
    constructor(path, logger) {
        this.path = path;
        this.logger = logger;
        // ⚠️ **构造时读一次盘**（`days` 与 `written` 同时初始化）。
        //
        // 缺陷（复审实测）：原先从不读盘 ⇒ 新进程的 `days` 是空表，首次 `flush()`
        // 用**空表整体覆盖**文档 ⇒ 每次重启 DSH 历史日聚合归零（与 README 的
        // 「重启保留 90 天」相反）。构造时读盘让内存成为盘上数据的**超集**。
        //
        // ⚠️ 但**光靠这一点不够**（审计发现，已原样复现）：内存是超集只在**单实例**
        // 下成立。两个实例并存时（fiber 重启交错、或同机多 profile 共享 home），
        // 各自的内存视图独立，整体覆盖会互相抹掉。故 `flush()` 必须是**增量合并写**。
        this.days = this.readFile();
        this.written = cloneDays(this.days);
    }
    /**
     * 从磁盘读日聚合（构造 / flush / deleteDay 用）。
     *
     * 读到损坏文档时把原件 rename 成 `.corrupt-*` 留档（可人工恢复），并返回空表。
     * ⚠️ `deleteDay` 与 `flush` 共用它，**不再**有「只读检查」式的旁路参数 ——
     * 那样会让「检查」带破坏性副作用（历史教训见 `deleteDay` 的长注释）。
     */
    readFile() {
        const out = new Map();
        try {
            if (!existsSync(this.path))
                return out;
            const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('账本根节点不是对象');
            }
            const record = parsed;
            if (typeof record.days !== 'object' || record.days === null || Array.isArray(record.days)) {
                throw new Error('账本缺少有效的 days 对象');
            }
            for (const [day, rawBuckets] of Object.entries(record.days)) {
                if (!isValidTokenLedgerDayKey(day))
                    continue;
                if (typeof rawBuckets !== 'object' || rawBuckets === null || Array.isArray(rawBuckets))
                    continue;
                const bucketList = rawBuckets;
                const target = new Map();
                for (const [key, rawBucket] of Object.entries(bucketList)) {
                    if (parseDayBucketKey(key) === undefined || typeof rawBucket !== 'object' || rawBucket === null || Array.isArray(rawBucket))
                        continue;
                    const b = rawBucket;
                    // 数值字段统一校验（手工编辑/旧版本的脏数据不致命，也不能让负值污染汇总）。
                    target.set(key, {
                        requests: storedNumber(b.requests),
                        reportedRequests: storedNumber(b.reportedRequests),
                        inputTokens: storedNumber(b.inputTokens),
                        outputTokens: storedNumber(b.outputTokens),
                        cacheReadTokens: storedNumber(b.cacheReadTokens),
                        cacheWriteTokens: storedNumber(b.cacheWriteTokens),
                        reasoningTokens: storedNumber(b.reasoningTokens),
                        errors: storedNumber(b.errors),
                        // Σ/份数（第 3 期均值）：旧文档没这些键 → 0（等价于无样本）。
                        ttftSumMs: storedNumber(b.ttftSumMs),
                        ttftCount: storedNumber(b.ttftCount),
                        tpsSum: storedNumber(b.tpsSum, false),
                        tpsCount: storedNumber(b.tpsCount),
                        tpsHistogram: readTpsHistogram(b.tpsHistogram),
                    });
                }
                out.set(day, target);
            }
        }
        catch (error) {
            // 保留损坏原件，避免后续正常 flush 用空表覆盖，统计问题不阻断启动。
            const backupStamp = Date.now();
            let backupPath = `${this.path}.corrupt-${backupStamp}`;
            for (let suffix = 1; existsSync(backupPath); suffix++)
                backupPath = `${this.path}.corrupt-${backupStamp}-${suffix}`;
            try {
                if (existsSync(this.path))
                    renameSync(this.path, backupPath);
            }
            catch (backupError) {
                this.logger?.warn(`[jet-hub] 账本损坏且备份失败 ${this.path}: ${String(backupError)}`);
            }
            // ⚠️ 归因澄清：搬走损坏文件后主文件不存在，而 `flush()` **只写增量**（这是本文件
            // 一直以来的行为，见 `flush()` 的长注释）⇒ 盘上只留本次增量。这不是新的数据
            // 损失路径（`0779fe8` 同样如此），且**不能**用「全量重建」来救（会覆盖用户
            // 有意删除的文件，见同一处注释）。保护下限是「原件留档 `.corrupt-*`」。
            this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，已尝试保留损坏文件 ${backupPath}: ${String(error)}`);
            return new Map();
        }
        return out;
    }
    /** 纯内存读（不碰磁盘）—— 见接口注释。 */
    load() {
        return this.days;
    }
    /** 锁竞争告警的限流时间戳（同一实例最多每 {@link LOCK_WARN_INTERVAL_MS} 一条）。 */
    lastLockWarnMs = 0;
    /**
     * 记录一次「取不到写锁」。**限流**：`flush` 由节流器每 1 秒重试一轮，若每轮都打
     * 一条 warn 会把日志淹没（与 codearts 真终态「同一 ref 只告警一次」同款取舍）。
     * 首次立即告警（用户最需要的那一刻），其后每 5 分钟最多一条。
     */
    warnLockContention() {
        const now = Date.now();
        if (now - this.lastLockWarnMs < LOCK_WARN_INTERVAL_MS)
            return;
        this.lastLockWarnMs = now;
        this.logger?.warn(`[jet-hub] Token 账本写锁被占用，本实例本次落盘延后重试（内存统计不受影响）: ${this.path}.lock`);
    }
    append(entry) {
        mergeDayEntry(this.days, entry);
        this.scheduleFlush();
    }
    /** 跨进程互斥；竞争时由节流器稍后重试，不阻塞推理请求。 */
    acquireWriteLock() {
        const lockPath = `${this.path}.lock`;
        const nonce = randomUUID();
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                mkdirSync(lockPath);
                try {
                    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }), 'utf-8');
                }
                catch (error) {
                    rmSync(lockPath, { recursive: true, force: true });
                    throw error;
                }
                return () => {
                    try {
                        const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf-8'));
                        if (owner.nonce === nonce)
                            rmSync(lockPath, { recursive: true, force: true });
                    }
                    catch {
                        // 锁已被清理或文件系统异常，不影响已完成的写入。
                    }
                };
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                if (!this.reclaimStaleLock(lockPath))
                    return undefined;
            }
        }
        return undefined;
    }
    /** 仅回收超时且持有进程已退出的锁；隔离目录用 rename 原子摘离旧锁。 */
    reclaimStaleLock(lockPath) {
        try {
            const stat = statSync(lockPath);
            if (Date.now() - stat.mtimeMs < LEDGER_LOCK_STALE_MS)
                return false;
            let owner = {};
            try {
                owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf-8'));
            }
            catch {
                // owner 文件缺失/损坏时只按过期目录处理。
            }
            const pid = Number(owner.pid);
            const lockAgeMs = Date.now() - stat.mtimeMs;
            if (Number.isInteger(pid) && pid > 0) {
                try {
                    process.kill(pid, 0);
                    return false;
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        return false;
                }
            }
            else if (lockAgeMs < LEDGER_LOCK_ABANDON_MS) {
                // owner 文件尚未写完/已损坏时，留更长宽限期，避免夺走刚创建的锁。
                return false;
            }
            const stalePath = `${lockPath}.stale-${randomUUID()}`;
            renameSync(lockPath, stalePath);
            const movedStat = statSync(stalePath);
            let movedOwner = {};
            try {
                movedOwner = JSON.parse(readFileSync(join(stalePath, 'owner.json'), 'utf-8'));
            }
            catch {
                // 缺少 owner 记录的过期锁可以清理。
            }
            if (Date.now() - movedStat.mtimeMs < LEDGER_LOCK_STALE_MS || movedOwner.nonce !== owner.nonce) {
                try {
                    renameSync(stalePath, lockPath);
                }
                catch { /* 若有新锁占位，不覆盖它。 */ }
                return false;
            }
            rmSync(stalePath, { recursive: true, force: true });
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return true;
            return false;
        }
    }
    /**
     * 删除单日历史。
     *
     * 语义：**只摘掉目标日**，其他日期在内存与磁盘上都原样保留。
     * - 内存：原地 `this.days.delete(day)`（见方法末尾的长注释，**不要**从 `merged` 重建）；
     * - 磁盘：以「盘上最新文档」为底，并入本实例增量，然后只移除目标日。
     *
     * ⚠️ 曾经在这里加过一个 `baselineIntact()` 守卫（判据「`written` 的桶是否都还在
     * 盘上」），意图是防「盘上文档缺桶时重建内存会丢数据」。但两轮复审红队各自实测
     * 证明该守卫**自身引入了四个更常见的问题**（保留期淘汰导致正常删除被永久拒绝、
     * 双实例下永久不可用、两次读盘之间的 TOCTOU、拒绝路径仍会搬走损坏文件）。
     * ⇒ 守卫已删除，改用「只删目标日」这一结构性写法，四个问题同时消失。
     * 完整论证记录在方法末尾的注释里（改这个方法前**必读**）。
     */
    deleteDay(day) {
        if (!this.days.has(day))
            return false;
        mkdirSync(join(this.path, '..'), { recursive: true });
        const releaseLock = this.acquireWriteLock();
        if (releaseLock === undefined)
            throw new Error('Token 历史文件正被另一个进程更新，请稍后重试');
        try {
            // ── 接管落盘（取消待执行的节流 flush，本次自己写） ──
            if (this.timer !== undefined) {
                clearTimeout(this.timer);
                this.timer = undefined;
            }
            this.dirty = false;
            mkdirSync(join(this.path, '..'), { recursive: true });
            const merged = this.readFile();
            // 把本实例相对基线的增量（**目标日除外**）并进盘上内容。
            for (const [pendingDay, buckets] of this.days) {
                if (pendingDay === day)
                    continue;
                const base = this.written.get(pendingDay);
                let target = merged.get(pendingDay);
                for (const [key, bucket] of buckets) {
                    const delta = subtractBucket(bucket, base?.get(key));
                    if (delta === undefined)
                        continue;
                    if (target === undefined) {
                        target = new Map();
                        merged.set(pendingDay, target);
                    }
                    const existing = target.get(key);
                    target.set(key, existing === undefined ? delta : addBucket(existing, delta));
                }
            }
            // 即使磁盘上该日已被外部删除，也要落下其他日期的待写增量。
            merged.delete(day);
            try {
                // 删除操作只改目标日，不借机淘汰其他日期。
                this.writeDays(merged, false);
            }
            catch (error) {
                this.scheduleFlush();
                throw error;
            }
            /**
             * ⚠️⚠️ **内存只删目标日，绝不从 `merged` 重建**（关键不变式，勿改回 `clear()`）。
             *
             * 这里曾经写的是 `this.days.clear()` + 按 `merged` 逐日重建，那正是**原始缺陷的
             * 根因**：`merged` 的来源是「盘上文档 + 增量」，而盘上文档可能**缺**很多本实例
             * 内存里有的日（损坏被搬走之后只写过增量 / 被另一个实例删过 / 超过保留期被
             * prune）。一旦用它重建内存，那些日就**从内存里也消失** —— 用户看到的是
             * 「我删了一天，别的日期的历史也没了」，且重启后不可恢复。
             *
             * `this.days.delete(day)` 只在原地摘掉目标日：
             * - 同一 Map 对象被原地修改 ⇒ 历史读取器（`load()` 的调用方）立刻看不到该日；
             * - 其他日期**原样留在内存**，不受盘上文档缺不缺它们影响；
             * - `merged` 是从**完整盘上文档**起步、只删目标日得到的，故写盘也**只减少目标日**，
             *   绝不会连带抹掉盘上其他日期。
             *
             * ## 为什么因此**不需要**守卫（曾经加过的 `baselineIntact()` 已删除）
             *
             * 那个守卫判据是「`written` 的每个桶都还在盘上」。它想防的正是上面的
             * `clear()`+重建危害，但两轮复审红队各自实测证明它**自身引入了四个更常见的问题**：
             *
             * 1. **保留期淘汰误报**（阻塞级）：`writeDays` 会 prune 掉 >90 天的日，
             *    而 `written` 前移写的是未 prune 的内存全量 ⇒ 基线恒虚高 ⇒
             *    **用户正常点「删除某日」被永久拒绝**，且只能重启恢复。触发无需任何外部干预。
             * 2. **双实例下永久不可用**：另一个实例合法删掉某日后，本实例 `written` 仍含该日
             *    ⇒ 恒判不一致 ⇒ 删除功能失效到重启（同机多 profile 共享 home 是本仓库
             *    明载的真实部署形态）。
             * 3. **两次读盘之间的 TOCTOU**：守卫读一次、拼装又读一次，窗口内不设防，
             *    可让目标日之外的数据在内存与磁盘同时消失。
             * 4. **拒绝路径仍有破坏性副作用**：拼装那次读默认会把损坏文件搬走 ⇒
             *    用户看到「拒绝删除」，主文件却已不在原位（与注释声称相反）。
             *
             * 而「只删目标日」这个写法让上述四个问题**同时不存在**：不再有守卫 ⇒ 无 1/2；
             * 只读一次盘 ⇒ 无 3；损坏文件由 `readFile` 统一留档（与 `flush` 同策、可人工恢复）
             * ⇒ 无「拒绝但被搬走」的矛盾。
             *
             * ⚠️ `written` 仍取**内存全量**（不 prune）：幽灵日规则依赖「`written` 含该日 ⇒
             * 其增量为 0 ⇒ 不把外部删除的日键写回盘」。若改成 prune 过的版本，被淘汰的日会
             * 每轮以「全量增量」重新进入 `merged`（再被 prune 丢弃），白白触发整份重写。
             *
             * ## ⚠️ 已知反向副作用：删除**不 prune**，可能把超期老日写进盘
             *
             * 上面那次 `writeDays(merged, false)` 刻意带 `applyRetention = false`（「不借机
             * 淘汰其他日期」，避免用户只是想删一天却连带清掉别的）。代价是：**若本实例尚未
             * flush 过**，`merged` 里可能含 >90 天的老日（`pruneDays` 只在 `writeDays` 的
             * 默认路径生效）⇒ 这些本该被保留期淘汰的日会被这次删除**写进盘**，直到下一次
             * `flush` 才清掉（实测：`afterDelete = ["2026-07-02"]` → `afterFlush = ["2026-10-10"]`）。
             * 影响很小（老日在下次 flush 后消失，且它们本来就在内存里），故**有意保留**；
             * 记在这里是为了别把它当成 bug 去「修」成 prune —— 那会与上面那条取舍冲突。
             */
            this.days.delete(day);
            this.written = cloneDays(this.days);
            return true;
        }
        finally {
            releaseLock();
        }
    }
    /** 节流落盘：窗口内首笔启动计时器，到点刷盘；期间新写入标记 dirty 再刷一轮。 */
    scheduleFlush() {
        if (this.timer !== undefined) {
            this.dirty = true;
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            try {
                this.flush();
            }
            finally {
                if (this.dirty) {
                    this.dirty = false;
                    this.scheduleFlush();
                }
            }
        }, TOKEN_LEDGER_FLUSH_MS);
        // unref：落盘不该拖住进程退出（守卫：非 Node 环境没有 unref）。
        this.timer.unref?.();
    }
    /**
     * **增量合并写**（不是整体覆盖）。
     *
     * ## 为什么必须合并（真实缺陷，审计发现并已复现）
     *
     * 整体覆盖只在**单实例**下安全。两个实例并存时（fiber 重启交错期间新旧两个
     * store 都在；或同机多 profile 共享同一个 home —— `permanent-lock-store.ts`
     * 开篇与本文档模块头都明载这一点），各自的内存视图独立，**谁后写谁抹掉对方**：
     *
     * ```
     * O 记 100（未 flush）        : 盘 = 0
     * N（新实例）记 1 并 flush    : 盘 = 1
     * O.flush()（旧 fiber dispose）: 盘 = 100   ← N 的 1 被抹掉
     * N 再记 5 并 flush           : 盘 = 6     ← O 的 100 也丢了（双向丢失，期望 106）
     * ```
     *
     * ⚠️ 修「构造时读盘」只解决**顺序**场景（新实例读到旧数据），解决不了**并存**
     * 场景 —— 后者必须靠合并。
     *
     * ## 算法
     *
     * 1. 重读盘上**当前**内容（别的实例可能刚写过）；
     * 2. 只把「相对本实例上次写盘基线 {@link written} 的**增量**」逐桶累加上去；
     * 3. 原子写（tmp + rename），成功后基线前移。
     *
     * 增量 = 当前内存值 − 上次落盘时的值（逐字段相减，负数钳到 0 防手工编辑倒挂）。
     */
    flush() {
        let releaseLock;
        try {
            mkdirSync(join(this.path, '..'), { recursive: true });
            releaseLock = this.acquireWriteLock();
            if (releaseLock === undefined) {
                // ⚠️ **锁竞争必须留痕（限流）**：取不到锁时我们只是延后重试，账本在本进程内
                // 仍然正确（内存兜底），但**盘上会一直不更新** —— 若另一个实例长期持锁（或
                // 它的锁被误判为存活），用户会看到「历史不更新」却**日志零字**，无从排查。
                // 与 `src/index.ts` 把十个静默 catch 收成一处 warn 是同一条纪律：
                // 延后重试是设计，但「一直在延后」必须是可观测的。
                this.warnLockContention();
                this.scheduleFlush();
                return;
            }
            // ① 盘上现况（含别的实例刚写的）
            //
            // ⚠️ `readFile()` 遇损坏会把文件 rename 成 `.corrupt-*` 并返回**空表**，因此
            // 这里读到的 `merged` 可能为空、且主文件此刻可能已不存在。
            const merged = this.readFile();
            /**
             * ## ⚠️⚠️ **为什么「主文件不存在」时仍然只写增量**（有意的取舍，勿改回去）
             *
             * ⚠️ 先澄清归因（避免后来者误解）：**只写增量是本文件一直以来的行为**，
             * 包括本次修复之前的 `0779fe8`（实测对照：旧版同样只写出增量 `5`，不复活）。
             * 下面这段记录的是「本轮修复期间**一度**加过、又**主动撤掉**」的一条防线，
             * 不是历史遗留代码 —— 撤掉是为了回到「尊重外部删除」的单一语义。
             *
             * 那条被撤掉的防线是「发现主文件不在 ⇒ 用 `this.days` 全量重建」，理由是
             *「损坏被搬走后增量写会丢掉内存里已有的历史」。但**实测证明它方向性地错**：
             * 「主文件不存在」这个磁盘信号**不足以判定意图**，它至少对应三种情形 ——
             *
             * | 场景 | 期望行为 | 全量重建的后果 |
             * |---|---|---|
             * | 损坏被搬成 `.corrupt-*` | 救回内存真值 | ✅ 正确 |
             * | **用户主动 `rm` 掉整个账本**（清历史） | **尊重删除** | ❌ **把删掉的历史复活** |
             * | 另一实例先重建了新文档（只含它的增量） | 救回本实例旧日 | ❌ 判据不成立（主文件在），**照旧丢** |
             *
             * 即：同一信号下，一半情形要救、一半情形要尊重，而**两者在磁盘上完全同形**
             *（都是 `existsSync === false`）⇒ 单侧启发式必然做反一半。实测那条防线：
             *「用户 `rm` 文件 → 本实例再 flush」时，被删的 `10-05:100` / `10-06:30`
             * **全部复活**，直接覆盖用户意图。
             *
             * ### 为什么「加文档级世代标记」也修不好（实测推演，勿再试）
             *
             * 检测到换代后，唯一可选动作仍是「用内存全量重建」，那会**双重累加**：
             * A 重建时写进新文档的 `10-05:100`，正是 B 当初写过的**同一份逻辑数据**；
             * 「盘上 + B 全量内存」= `100 + 100 = 200`，而正确值是 100（两个实例都
             * 「拥有」该桶）。⇒ 单侧启发式只能在**丢数据**与**双重累加**之间二选一，
             * 后者比前者更糟（静默的数值损坏）。
             * 根治需要**按实例记录贡献**的 provenance（存储格式级改动，使「相减」有据
             * 可依），超出本次范围。
             *
             * ### 故当前语义（宁可少救，不可写错）
             *
             * 只写增量：盘上缺的旧日**不自动补回** —— 与「幽灵日」规则（尊重外部删除）
             * 保持**同一套判据**，不再有「有时尊重、有时复活」的分裂。
             *
             * ⚠️ **已知代价（如实记录）**：「损坏搬走」或「用户 `rm`」之后，本进程内
             * `load()`（UI 读它）仍显示旧累计，而盘上只有增量 ⇒ **两者在重启前不一致**
             *（实测：内存 `105` / 盘上 `5`）。这是「尊重删除」的必然代价，不是缺陷；
             * 重启后以盘为准（实测 `5`）。损坏原件始终留档 `.corrupt-*` 可人工恢复。
             */
            // ② 把本实例的增量并进去
            //
            // ⚠️ **必须跳过「零增量」的桶**（真实缺陷，审计发现并原样复现：R1「幽灵日」）：
            // 若盘上的某个日键被**外部删除**（手工编辑 / 另一工作区的旧版本整体覆盖 /
            // 从备份恢复），而本实例内存里仍留着它，那么「全量遍历 + delta=0 也写入」
            // 会把该日**重新建成一个全 0 桶** —— 内存里还是真值（被掩盖），**重启后
            // 变成 0 且不可恢复**。故 `subtractBucket` 对零增量返回 `undefined`，这里跳过。
            let hasDelta = false;
            for (const [day, buckets] of this.days) {
                const base = this.written.get(day);
                let target = merged.get(day);
                for (const [key, bucket] of buckets) {
                    const delta = subtractBucket(bucket, base?.get(key));
                    if (delta === undefined)
                        continue; // 本次没有新增量 ⇒ 不碰盘上这一桶
                    hasDelta = true;
                    if (target === undefined) {
                        target = new Map();
                        merged.set(day, target);
                    }
                    const existing = target.get(key);
                    if (existing === undefined) {
                        target.set(key, delta);
                    }
                    else {
                        target.set(key, addBucket(existing, delta));
                    }
                }
            }
            // ⚠️ 没有任何新增量 ⇒ **直接返回，不重写文件**。
            // 与 `gemini-sigstore.ts` 的 `if (!this.dirty) return` 同款脏检查：避免
            // 无谓的「全量读 + parse + stringify + 原子写」（实测 500 桶/天时该动作约
            // 132ms 同步阻塞，且这段代码跑在 setTimeout 回调里 = 阻塞事件循环）。
            if (!hasDelta)
                return;
            // ③ 原子写（淘汰过老日键）
            this.writeDays(merged);
            // ④ 基线前移（只在写盘成功后）
            //
            // ⚠️ 取**未 prune 的内存全量**（不是「实际写进盘的内容」）：增量口径要求
            // 「盘上已含我上次写的桶」。若取 prune 后的版本，被保留期淘汰的老日会因
            // `written` 缺它而每轮都算出「全量增量」、白白触发一次整份读改写（再被 prune
            // 丢弃）。虚高的老日在 `flush` 里是**无害**的（`delta` 恒 0 ⇒ 不写回 ⇒ 尊重
            // 保留期淘汰），而在 `deleteDay` 里也不再被用作任何判据（那里的守卫已删除，
            // 见 `deleteDay` 的长注释）。
            this.written = cloneDays(this.days);
        }
        catch (error) {
            // 落盘失败只记日志：账本还有内存兜底，不能反噬推理。
            this.logger?.warn(`[jet-hub] 写入 ${this.path} 失败（本次统计不入盘）: ${String(error)}`);
        }
        finally {
            releaseLock?.();
        }
    }
    /** 原子写入指定日表。 */
    writeDays(source, applyRetention = true) {
        const days = {};
        const retained = applyRetention ? pruneDays(source) : source;
        for (const [day, buckets] of retained)
            days[day] = Object.fromEntries(buckets);
        const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        const fd = openSync(tmp, 'w');
        try {
            writeFileSync(fd, JSON.stringify({ schema: SCHEMA, days }, null, 2), 'utf-8');
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, this.path);
    }
}
/** 深拷贝日聚合表（桶对象也复制，避免与基线共享引用）。 */
function cloneDays(days) {
    const out = new Map();
    for (const [day, buckets] of days) {
        out.set(day, new Map([...buckets].map(([key, bucket]) => [key, {
                ...bucket,
                tpsHistogram: { ...(bucket.tpsHistogram ?? {}) },
            }])));
    }
    return out;
}
/** 逐字段相加（两个桶合并）。 */
function addBucket(a, b) {
    return {
        requests: a.requests + b.requests,
        reportedRequests: a.reportedRequests + b.reportedRequests,
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
        errors: a.errors + b.errors,
        ttftSumMs: a.ttftSumMs + b.ttftSumMs,
        ttftCount: a.ttftCount + b.ttftCount,
        tpsSum: a.tpsSum + b.tpsSum,
        tpsCount: a.tpsCount + b.tpsCount,
        tpsHistogram: mergeHistograms(a.tpsHistogram, b.tpsHistogram),
    };
}
function mergeHistograms(a, b, subtract = false) {
    const result = { ...(a ?? {}) };
    for (const [key, count] of Object.entries(b ?? {})) {
        const next = (result[key] ?? 0) + (subtract ? -count : count);
        if (next > 0)
            result[key] = next;
        else
            delete result[key];
    }
    return result;
}
/**
 * 增量 = 当前桶 − 基线桶（逐字段）。
 *
 * ⚠️ 负数一律钳到 0：手工编辑过文档、或基线比当前大时（理论上不该发生），
 * 相减会得到负数，写进账本会**倒扣**用户的历史用量 —— 宁可少记也不能倒扣。
 *
 * ⚠️ **全字段为 0 时返回 `undefined`**（而不是零值对象）：调用方据此**跳过**
 * 该桶，避免把「零增量」写回盘上 —— 否则外部删掉的日键会被**重建为全 0 桶**，
 * 造成静默数据丢失（见 `flush` 的注释与「幽灵日」回归用例）。
 */
function subtractBucket(current, base) {
    if (base === undefined) {
        // 基线里没有（本实例新建的桶）：整体就是增量，但若它本身全 0 也无意义。
        return isZeroBucket(current) ? undefined : { ...current };
    }
    const diff = (a, b) => Math.max(0, a - b);
    const delta = {
        requests: diff(current.requests, base.requests),
        reportedRequests: diff(current.reportedRequests, base.reportedRequests),
        inputTokens: diff(current.inputTokens, base.inputTokens),
        outputTokens: diff(current.outputTokens, base.outputTokens),
        cacheReadTokens: diff(current.cacheReadTokens, base.cacheReadTokens),
        cacheWriteTokens: diff(current.cacheWriteTokens, base.cacheWriteTokens),
        reasoningTokens: diff(current.reasoningTokens, base.reasoningTokens),
        errors: diff(current.errors, base.errors),
        ttftSumMs: diff(current.ttftSumMs, base.ttftSumMs),
        ttftCount: diff(current.ttftCount, base.ttftCount),
        tpsSum: diff(current.tpsSum, base.tpsSum),
        tpsCount: diff(current.tpsCount, base.tpsCount),
        tpsHistogram: mergeHistograms(current.tpsHistogram, base.tpsHistogram, true),
    };
    return isZeroBucket(delta) ? undefined : delta;
}
/** 桶的所有字段是否都为 0（= 没有任何增量）。 */
function isZeroBucket(bucket) {
    return bucket.requests === 0 && bucket.reportedRequests === 0
        && bucket.inputTokens === 0 && bucket.outputTokens === 0
        && bucket.cacheReadTokens === 0 && bucket.cacheWriteTokens === 0
        && bucket.reasoningTokens === 0 && bucket.errors === 0
        && bucket.ttftSumMs === 0 && bucket.ttftCount === 0
        && bucket.tpsSum === 0 && bucket.tpsCount === 0
        && Object.values(bucket.tpsHistogram ?? {}).every((count) => count === 0);
}
/**
 * 创建日聚合后端。
 *
 * home 解析与账号池**同一个函数**（`resolveJetHubHome`），保证文档落在同一目录
 * —— 否则会出现「账号池在 A 处、用量在 B 处」的分裂。
 */
export function createTokenLedgerStore(ctx) {
    const home = resolveJetHubHome(ctx);
    if (home === undefined) {
        ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，Token 用量历史仅存在于内存中');
        return new MemoryLedgerStore();
    }
    return new FileLedgerStore(join(home, 'jet-hub', TOKEN_LEDGER_FILE), ctx.logger);
}
//# sourceMappingURL=token-ledger-store.js.map