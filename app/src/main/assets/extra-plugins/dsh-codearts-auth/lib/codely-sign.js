/**
 * Codely 推理网关的请求签名（`X-Codely-Signature`）。
 *
 * ## 算法（2026-10-20 实测确认，真凭据 → **200 + 非空内容**）
 *
 * ```
 * signingKey = HMAC_SHA256( HMAC_SHA256(SECRET, "codely-signing-v1"), cli_api_key )
 * sig        = HMAC_SHA256( signingKey, ["v1", pathname, ts].join("\n") ).base64url
 * header     = `v1.${ts}.${sig}`          // ts = 秒级时间戳
 * ```
 *
 * ## 权威源码在哪（2026-10-20 复核，可复现）
 *
 * 官方 **npm 包** `@unity-china/codely-cli`（二进制里也有同一份实现，但 npm 包是明文、更易读）：
 * 包内 `bundle/gemini.js`，rc.60 里叫 `qEf`（派生）/ `JEf`（签名），
 * rc.61 混淆改名 `Lpp` / `Gpp`，**逻辑逐字节相同**：
 *
 * ```js
 * function qEf(t){ let e=hmac("sha256",SECRET).update("codely-signing-v1").digest()
 *                  return hmac("sha256",e).update(t).digest() }
 * function JEf({path,signingKey,timestamp}){
 *   let o=["v1",path,timestamp].join(`<LF>`)      // ← 模板字面量里就是一个裸换行
 *   return `v1.${timestamp}.${hmac("sha256",signingKey).update(o).digest("base64url")}` }
 * ```
 *
 * ⇒ `node scripts/verify-codely-signature.mjs` 会把这两个函数体从 bundle 里抽出来
 *   直接执行，与本文实现逐字节对拍（rc.60 / rc.61 各 13/13 全等）。
 *   这一步不可省：`tests/unit/codely-sign.spec.ts` 的固定向量是**我们自己算的**，
 *   只能锁回归、锁不住「公式本身抄错」，而脚本是**非同源**判据。
 *
 * ## ⚠️⚠️ 分隔符是 **LF（`\n`）**，这三条历史坑必须留在注释里
 *
 * 1. 官方 CLI 二进制（`1.0.0-release.57`）里那段明文 JS 是
 *    `["v1", path, ts].join("|")` —— **它是未生效/旧版代码**，
 *    按它签名一定 401（我按 `|` 试过全部派生与消息串组合，17 万+ 全不中）；
 * 2. 官方 npm 包里写的是 `.join(`<LF>`)` —— **模板字面量里一个裸换行**；
 *    早前被误读成 `\r\n`（只看到转义展示），按 `\r\n` 签名 → **401**；
 * 3. 双重保证：该 bundle **零 CRLF**（实测 `CRLF 数=0`），且 ECMAScript
 *    规定源文本的行终结符在解析时统一规范化为 LF。
 *
 * ⇒ 这条差异是**一字节级**的，任何"看起来等价"的重构（改成 `join('|')`、
 *   `join(os.EOL)`、或先拼数组再 `join()` 不带参数）都会让整条通道静默失效。
 *   `tests/unit/codely-sign.spec.ts` 用固定向量把 LF 钉死。
 *
 * ## 服务端校验规则（2026-10-20 真机探针实测，见脚本 `--live`）
 *
 * | 维度 | 实测结论 |
 * |---|---|
 * | 时间窗 | **±300 秒**（过去侧 -290s 通过 / -300s 拒；未来侧 +300s 通过 / +330s 拒） |
 * | body | **不参与**：同一签名配改过的 body（含换 model）照旧 200 |
 * | query | **不参与**：签名只覆盖 `pathname` |
 * | 重放 | **未做 nonce**：同一 ts 连发三次都 200 ⇒ 服务端认的是「签名对不对」不是「用过没」 |
 * | 端点范围 | `/v1/chat/completions` **强制校验**（缺/错签名 → 401「请升级到最新版」）；`GET /v1/models` **不校验**（签不签都 200） |
 * | key 配对 | 签名用的 key 必须与 `Bearer` 同源，错配 → 401 `LiteLLM Virtual Key expected` |
 *
 * ⚠️ 官方实现还有一道 **host 门**：只有 `codely-litellm.tuanjie.cn`（及其子域、
 * 走 https）会加签，其它 host 原样透传；额外 host 白名单走环境变量
 * `CODELY_LITELLM_SIGNING_HOSTS`（逗号分隔，允许 http）。我们只打那个 host，
 * 故本模块无条件签名，与官方行为等价。
 *
 * ## 为什么 SECRET 是硬编码常量而不是配置
 *
 * 它来自官方客户端的编译产物（`Buffer.from(hex, "hex")`），对**所有用户相同**；
 * 真正的按账号隔离靠 `cli_api_key`（每个账号自己换发）⇒ 两段派生缺一不可。
 */
import { createHmac } from 'node:crypto';
/**
 * 官方客户端的签名根密钥（32 字节，全客户端共用）。
 *
 * ⚠️ 与 npm 包 `@unity-china/codely-cli` 的 `jEf` 常量**逐字节一致**
 * （二进制里也一致），不是猜测值。
 */
export const CODELY_SIGNING_SECRET = Buffer.from('406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018', 'hex');
/** 第一段派生的盐（改它 = 换协议版本）。 */
export const CODELY_SIGNING_SALT = 'codely-signing-v1';
/**
 * 推理请求的 `User-Agent`。
 *
 * 取值就是客户端自报的形态。**照抄官方形态**是稳妥做法（上游将来可能加校验）。
 *
 * ⚠️ 但别把它当硬约束：2026-10-20 复核时换成 `Mozilla/5.0` 打同一个签名请求，
 * **照样通过签名校验**（返回的是下游 400 而不是 401），说明 UA 目前既不是签名
 * 输入也不是鉴权判据。旧笔记「UA 不对就 401」的说法证据不足（当年那次 401
 * 更可能是 path / key 配对问题），已按实测结论下修。
 */
export const CODELY_CLI_USER_AGENT = 'codely-cli/1.0.0-release.57 (win32; x64)';
/**
 * 派生 per-account 签名密钥：`HMAC(HMAC(SECRET, salt), cli_api_key)`。
 *
 * @param cliApiKey 换发得到的 `sk-…`（**不是** access_token）
 */
export function codelySigningKey(cliApiKey) {
    const stage1 = createHmac('sha256', CODELY_SIGNING_SECRET).update(CODELY_SIGNING_SALT).digest();
    return createHmac('sha256', stage1).update(cliApiKey).digest();
}
/** 归一化 pathname（签名只覆盖 path，不含 query）。 */
function pathnameOf(url) {
    try {
        return new URL(String(url)).pathname;
    }
    catch {
        return String(url);
    }
}
/**
 * 计算 `X-Codely-Signature` 头的值。
 *
 * @param cliApiKey 该账号的 `cli_api_key`
 * @param target 目标 URL（只取其 `pathname`）
 * @param timestampMs 时间戳（毫秒；内部取秒）——测试注入用
 */
export function codelySignatureHeader(cliApiKey, target, timestampMs = Date.now()) {
    const ts = String(Math.floor(timestampMs / 1000));
    const msg = ['v1', pathnameOf(target), ts].join('\n');
    const sig = createHmac('sha256', codelySigningKey(cliApiKey)).update(msg).digest('base64url');
    return `v1.${ts}.${sig}`;
}
/**
 * 构造一次已签名的推理请求头。
 *
 * `x-litellm-session-id` 是**必填**（缺它 = 400 `非法session`），
 * 但不参与签名 ⇒ 可复用同一个 id；这里按调用方传入（缺省随机 UUID）。
 */
export function signedCodelyHeaders(options) {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${options.cliApiKey}`,
        'User-Agent': CODELY_CLI_USER_AGENT,
        'X-Codely-Signature': codelySignatureHeader(options.cliApiKey, options.target, options.timestampMs),
        'x-litellm-session-id': options.sessionId,
    };
}
//# sourceMappingURL=codely-sign.js.map