/**
 * 驱动**官方 Codely CLI**（`codely.exe`）执行推理。
 *
 * ## ⚠️⚠️ 为什么是「驱动官方进程」而不是自己发 HTTP
 *
 * 推理网关 `codely-litellm.tuanjie.cn` 要求 `X-Codely-Signature`（HMAC），
 * 签名密钥藏在官方客户端的编译产物里 —— 2026-10-20 已穷尽五种手段均未取得
 * （详见 `codely-adapter.ts` 模块头的清单）。与其伪造一个注定 401 的请求，
 * 不如**让官方客户端自己签名**：它本来就带着合法凭据与签名逻辑，我们只需要
 * 它的输出。同一取舍在 `qoder-machine.ts` 里有过先例（「复刻代价高且属重复
 * 造轮子，直接读更可靠」）。
 *
 * 2026-10-20 实测（`codely --help` 与真跑各一次）：
 *
 * ```
 * codely --output-format stream-json -m codely-core --approval-mode yolo --prompt "Say OK"
 * → {"type":"init","session_id":"…","model":"codely-core"}
 *   {"type":"message","role":"user","content":"Say OK","delta":false}
 *   {"type":"message","role":"assistant","content":"OK","delta":true}
 *   {"type":"result","status":"success","stats":{"total_tokens":…,"duration_ms":…}}
 * ```
 *
 * ## 形态与代价（**已知且已被用户接受**，2026-10-20 拍板）
 *
 * - **依赖本机安装**：默认路径见 {@link DEFAULT_CODERLY_CLI_PATH}，可用
 *   `DSH_CODERLY_CLI_PATH` 覆盖；找不到时**明确报错**，不退化成静默空流。
 * - **凭据是 CLI 自己的登录态**（`~/.codely-cli/oauth_creds.json`），
 *   **不是**本插件账号池里的那份 ⇒ 推理侧的换号 / 多账号在 CLI 模式下不成立
 *   （积分、签到仍走插件自己的凭据，不受影响）。
 * - **每次请求起一个进程**（实测端到端 ~3.1s，含进程启动）。
 * - **审批模式由调用方给**：`--approval-mode yolo` 允许 CLI 读写文件、执行命令
 *   —— 这是拍板选的「更接近官方 CLI 的体验」；换成 `ask` 即只读。
 *
 * ## 本模块刻意不做的两件事
 *
 * - **不转发 `reasoning_content`**：实测思考内容是独立字段且正文照常产出，
 *   混进正文会让回答带上思维链噪声（本仓库对「编造读数」一贯说不，这里
 *   选择**丢弃**而不是假装它是正文）。
 * - **不解析工具事件**：工具由 CLI 自己调度执行，本插件只消费最终文本。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
/** 覆盖 CLI 路径的环境变量（本机装到别处时用）。 */
export const CODERLY_CLI_PATH_ENV = 'DSH_CODERLY_CLI_PATH';
/** 官方 CLI 的默认安装路径（实测本机位置）。 */
export const DEFAULT_CODERLY_CLI_PATH = 'D:\\Program File\\Tuanjie Cowork\\cli\\bin\\win32-x64\\codely.exe';
/** `--output-format` 取值：逐行 JSONL，`delta:true` 为增量。 */
const OUTPUT_FORMAT = 'stream-json';
/**
 * 解析 CLI 路径：环境变量 → 默认路径 → 不存在则返回 `undefined`。
 *
 * ⚠️ 环境变量优先是为了让「装到别处」的用户自助修好，而不是改代码；
 *    默认路径**存在性**要真检查（`existsSync`）——直接 spawn 一个不存在的路径
 *    只会拿到一个含义模糊的 ENOENT。
 */
export function resolveCodelyCliPath(env = process.env) {
    const override = env[CODERLY_CLI_PATH_ENV];
    if (typeof override === 'string' && override.trim().length > 0) {
        const trimmed = override.trim();
        // ⚠️ 覆盖路径**也必须**存在：否则用户设错了会拿到比默认路径更难懂的错误。
        return existsSync(trimmed) ? trimmed : undefined;
    }
    return existsSync(DEFAULT_CODERLY_CLI_PATH) ? DEFAULT_CODERLY_CLI_PATH : undefined;
}
/** 构造 CLI 参数（顺序与实测一致）。 */
export function buildCodelyCliArgs(options) {
    return [
        '--output-format', OUTPUT_FORMAT,
        '-m', options.model,
        '--approval-mode', options.approvalMode ?? 'yolo',
        // ⚠️ `--prompt=` 形式（不是 `--prompt <值>`）：后者在带空格 / 换行的
        //    prompt 上会被 shell 层拆成多个参数（实测报
        //    `Unknown arguments: with, exactly, two, …`）。
        `--prompt=${options.prompt}`,
    ];
}
/**
 * 跑一次 CLI 并逐块产出事件。
 *
 * ⚠️ 出错一律**抛出**，绝不返回空流：静默空流会让上层显示「模型没说话」，
 * 而真实原因是 CLI 没装 / 没登录 / 模型不被允许 —— 那是本仓库明令禁止的
 * 静默失效形态（autoclaw 与 officeace 都记过同款）。
 */
export async function* runCodelyCli(options) {
    const cliPath = options.cliPath ?? resolveCodelyCliPath(options.env);
    if (cliPath === undefined) {
        throw new Error('未找到官方 Codely 客户端（Tuanjie Cowork CLI），推理无法进行。'
            + `请安装后重试，或用环境变量 ${CODERLY_CLI_PATH_ENV} 指向 codely.exe 的实际路径。`
            + `（默认探测路径：${DEFAULT_CODERLY_CLI_PATH}）`);
    }
    const spawner = options.spawner ?? ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
    const child = spawner(cliPath, buildCodelyCliArgs(options), {
        cwd: options.cwd ?? process.cwd(),
        // ⚠️ 必须隐藏窗口：否则每次发消息都会闪一个控制台窗口（与
        //    `chromium-session.ts` 的同款取舍）。
        windowsHide: true,
    });
    // ── 收尾信号：exit 与 error 谁先来算谁（二者互斥，且 error 后不再有 exit）──
    let settled = false;
    const exited = new Promise((resolve) => {
        const done = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        child.on('exit', (code) => { done({ code }); });
        child.on('error', (error) => { done({ code: null, error }); });
    });
    // ── stderr 留尾（诊断用，限长防日志炸掉）──
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stderrTail = (stderrTail + text).slice(-4000);
    });
    // ── 取消 ──
    //
    // ⚠️⚠️ 不能用 `for await` 裸读 stdout：子进程被 kill 后它的 stdout **不会**
    // 给出一个干净的 `end`（实测：destroy 过的流会让 readline 一直挂着，
    // 表现为「点了取消但请求不结束」，直到宿主超时）。
    // ⇒ 让「读到下一行」与「被取消」**竞争**，谁先来走谁。
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const aborted = new Promise((resolve) => {
        if (options.signal === undefined)
            return;
        if (options.signal.aborted) {
            resolve('aborted');
            return;
        }
        options.signal.addEventListener('abort', () => { resolve('aborted'); }, { once: true });
    });
    const onAbort = () => { child.kill(); };
    options.signal?.addEventListener('abort', onAbort);
    try {
        while (true) {
            const next = await Promise.race([iterator.next(), aborted]);
            if (next === 'aborted' || next.done === true)
                break;
            const event = parseCliLine(String(next.value));
            if (event === undefined)
                continue;
            yield event;
        }
    }
    finally {
        lines.close();
        options.signal?.removeEventListener('abort', onAbort);
    }
    const { code, error } = await exited;
    if (error !== undefined) {
        throw new Error(`启动官方 Codely 客户端失败：${error.message}`);
    }
    if (code !== 0) {
        // ⚠️ CLI 把结构化错误（`{"error":{"type":…,"status":401,…}}`）打到 stdout，
        //    而进程级失败（未登录、崩溃）走 stderr + 非 0 退出码 ⇒ 这里把 stderr
        //    尾部带上，否则用户只能看到一个干巴巴的退出码。
        const detail = stderrTail.trim();
        throw new Error(`官方 Codely 客户端以退出码 ${code} 结束`
            + (detail.length === 0 ? '' : `：${detail.slice(-600)}`));
    }
}
/** 单行解析：认得的行产出事件，认不得的（含空行与噪声）返回 `undefined`。 */
function parseCliLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== '{')
        return undefined;
    let raw;
    try {
        raw = JSON.parse(trimmed);
    }
    catch {
        // ⚠️ CLI 可能夹带非 JSON 的进度噪声：跳过，不让它中断整条流。
        return undefined;
    }
    const type = raw.type;
    if (type === 'message' && raw.role === 'assistant') {
        // ⚠️ 只认 `typeof === 'string'`：实测另一侧恒为 `null`（`openai-compat.ts`
        //    记过同款：`null.length` 会让第一帧就崩）。
        const content = typeof raw.content === 'string' ? raw.content : '';
        if (content.length === 0)
            return undefined;
        // ⚠️ 丢弃 `reasoning_content`（见模块头：思维链不当正文）。
        return { type: 'delta', text: content };
    }
    if (type === 'result') {
        // ⚠️ 非 success 不产出 result：让上层走「没有正常收尾」的错误分支，
        //    而不是把一次失败的调用伪装成成功结束。
        if (raw.status !== 'success')
            return undefined;
        return { type: 'result', stats: readStats(raw.stats) };
    }
    return undefined;
}
/** 读用量统计；字段缺席就不写（不补 0 —— 0 与「未知」不是一回事）。 */
function readStats(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const raw = value;
    const stats = {};
    const number = (key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] : undefined;
    const inputTokens = number('input_tokens');
    const outputTokens = number('output_tokens');
    const totalTokens = number('total_tokens');
    const durationMs = number('duration_ms');
    const toolCalls = number('tool_calls');
    if (inputTokens !== undefined)
        stats.inputTokens = inputTokens;
    if (outputTokens !== undefined)
        stats.outputTokens = outputTokens;
    if (totalTokens !== undefined)
        stats.totalTokens = totalTokens;
    if (durationMs !== undefined)
        stats.durationMs = durationMs;
    if (toolCalls !== undefined)
        stats.toolCalls = toolCalls;
    return stats;
}
//# sourceMappingURL=codely-cli.js.map