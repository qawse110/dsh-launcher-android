/**
 * MiniMax 续期/身份 **JSONL 日志**（2026-10-24 本地试验版新增）。
 *
 * ## 为什么要有它（对应本次试验的验收方式）
 *
 * 原续期路径只有 `ctx.logger` 的两句话（「已续期」/「续期失败」）——
 * 「换钥匙」这种高危操作**既不知道 frequency 也不知道死因**。试验版要求
 * 一两天内能回答三个问题，全部依赖这份日志：
 *
 * 1. 轮换频率是否真的从「每 30 分钟五连发」降到「每账号各自 ~45-55 分钟」；
 * 2. 401 兜底（`forced`）与请求路径续期（`ondemand`）各触发过几次；
 * 3. 终态 `invalid_grant` 是否出现过、死于抢救链哪一层。
 *
 * ## 形态
 *
 * - **JSONL**（一行一条）：`appendFile` 原子性按行保证，进程崩了最多丢半行；
 * - **fire-and-forget**：任何错误（目录建不出、盘满）都**静默吞掉** ——
 *   日志是观测设施，绝不能反噬续期主路径（与 `syncAccountExpiry` 的
 *   「失败只记日志不上抛」同一纪律）；
 * - **>5MB 轮转**：改名 `.old`（覆盖旧 .old），试验期量级用不到，纯保险；
 * - **必须显式注入 home**（`MinimaxAuth` 的 `journalHome` 选项）：单测不传 ⇒
 *   **绝不写盘** —— 否则单测会把日志写进用户真实的 `~/.dsh`。
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
/** 单文件上限；超过即轮转（`.jsonl` → `.jsonl.old`，覆盖旧 `.old`）。 */
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;
/**
 * 测试环境下**拒绝**写进真实用户目录（2026-10-27 实测污染后补的防线）。
 *
 * ## 事故
 *
 * 本轮审计期间，`~/.dsh/jet-hub/refresh-journal.jsonl` **真的出现了** ——
 * 内容是用户**真实账号**（`minimaxintl-6d76168a`）的一条 `result:'error'`
 * 记录，`latencyMs: 2001`（说明**真的向上游发了续期请求**）。
 *
 * 成因是审计探针/某个非 `setupFiles` 路径（如 e2e 或临时脚本）**没有隔离**
 * `DSH_JET_HUB_STATE_DIR`，而 `journalHome` 由 `index.ts` 无条件注入
 * ⇒ 一路落到第 ⑤ 条兜底：`homedir()/.dsh`。
 *
 * ## 为什么要在**运行时**再加一道，而不是只靠测试配置
 *
 * `tests/setup-isolation.ts` 只对走 `vitest.config.ts` 的**单测**生效；
 * e2e 配置、临时探针脚本、`node -e` 都绕得过。而这类污染的**后果不是报错**
 * 而是「在用户的真实数据目录里留下测试痕迹」—— 且若那个账号的
 * `refresh_token` 是一次性的，**测试会真的把它烧掉**（本仓库
 * `officeace` 就发生过真实事故：`STS5.1806 has been used`）。
 *
 * ⇒ 判据：`NODE_ENV === 'test'` **且** `home` 解析后落在
 *   `homedir()/.dsh` 之下 ⇒ **拒写**（只 warn 一次）。临时目录不受影响，
 *   生产（`NODE_ENV` 不是 test）也完全不受影响。
 */
let warnedRealHomeWrite = false;
function isRealUserHomeWrite(home) {
    if (process.env.NODE_ENV !== 'test')
        return false;
    try {
        const real = join(homedir(), '.dsh');
        const normalizedHome = resolve(home);
        const normalizedReal = resolve(real);
        return normalizedHome === normalizedReal
            || normalizedHome.startsWith(`${normalizedReal}${sep}`);
    }
    catch {
        // 解析失败 ⇒ 不阻断（宁可漏拦，也不让观测设施把主路径搞坏）
        return false;
    }
}
/** 追加一条日志。`home` 缺省（单测）时**什么都不做**。 */
export function appendMinimaxJournal(home, entry) {
    if (home === undefined || home === '')
        return;
    /**
     * ⚠️ 测试环境下拒写真实用户目录（见 {@link isRealUserHomeWrite} 的事故记录）。
     * 只 warn 一次，避免把测试输出刷满。
     */
    if (isRealUserHomeWrite(home)) {
        if (!warnedRealHomeWrite) {
            warnedRealHomeWrite = true;
            console.warn('[minimax] 测试环境下拒写真实用户目录的 refresh-journal'
                + `（${home}）—— 请检查测试是否隔离了 DSH_JET_HUB_STATE_DIR`);
        }
        return;
    }
    void (async () => {
        try {
            const dir = join(home, 'jet-hub');
            await mkdir(dir, { recursive: true });
            const file = join(dir, 'refresh-journal.jsonl');
            // ⚠️ 先查大小再轮转：appendFile 不做截断，5MB 上限靠这一下守住。
            const current = await stat(file).catch(() => undefined);
            if (current !== undefined && current.size > MAX_JOURNAL_BYTES) {
                await rename(file, `${file}.old`).catch(() => undefined);
            }
            await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
        }
        catch {
            // 静默：见模块头「fire-and-forget」纪律。
        }
    })();
}
//# sourceMappingURL=minimax-refresh-journal.js.map