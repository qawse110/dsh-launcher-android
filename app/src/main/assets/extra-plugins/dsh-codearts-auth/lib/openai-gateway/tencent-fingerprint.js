/**
 * 腾讯系渠道的**内容级**风控指纹改写（Gitee issue IKJNA1）。
 *
 * ## 现象
 *
 * 外部客户端（ZCode 等）经本插件的 OpenAI 网关调 `buddy` / `workbuddy` 时，
 * 只要 `system` 消息里带着某些**客户端自带的模板句**，腾讯网关就稳定回
 * `HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"`，
 * 客户端侧只显示 `provider_code=INVALID_REQUEST reason=unknown`。
 * DSH 直连同一模型则完全正常 —— 差别只在于**外部客户端往 system 里注了什么**。
 *
 * ## 哪些角色要改（实测出来的，不是推理出来的）
 *
 * 本机逐组实测（`www.workbuddy.ai` 与 `copilot.tencent.com` **两个端点表现一致**，
 * 同账号 / 同模型 / 同 UA 与 X-* 头 / `max_tokens` 取小值，被拦不耗额度）：
 *
 * | 探针 | 指纹所在处 | 结果 |
 * |---|---|---|
 * | 中性对照 | 无 | ✅ 200 |
 * | 最小充分触发 | `system` | ❌ 400/11128 |
 * | 只留标签 `Main branch: master` | `system` | ✅ 200 |
 * | 换分支名（`: dev`） | `system` | ❌ 400/11128 ⇒ **分支值无关** |
 * | 句中 / 段中被别的句子夹住 | `system` | ❌ 400/11128 ⇒ **位置无关** |
 * | **改写该句** | `system` | ✅ 200 ⇒ 改写是有效修法 |
 * | 指纹在**第二条** system（非 `messages[0]`） | `system` | ❌ 400/11128 |
 * | 只差一个词（`normally` 替 `usually`） | `system` | ✅ 200 ⇒ **逐字符**匹配 |
 * | 内层多一个空格 | `system` | ✅ 200 ⇒ 同上 |
 * | 全小写 / 全大写 | `system` | ❌ 400/11128 ⇒ **大小写不敏感** |
 * | 同一句放进 **user** 消息 | `user` | ✅ 200 |
 * | 同一句放进 **tool 结果** | `tool` | ✅ 200 |
 * | ★ 同一句放进 **assistant 正文** | `assistant.content` | ❌ **400/11128** |
 * | ★ assistant 只放在 **`reasoning_content`** | 该字段 | ✅ 200 |
 * | ★ assistant 只放在 **`tool_calls[].function.arguments`** | 该字段 | ✅ 200 |
 * | ★ 40KB 良性长文本（与文档同字节数） | `assistant.content` | ✅ 200 ⇒ **体量不是原因** |
 *
 * ★ 那四行是 2026-10-12 补测的。**初版只测了 `system` / `user` / `tool` 三个位置**，
 * 于是得出「只拦 system」这个**过窄**的结论并把它写成了硬约束 —— 而 `assistant`
 * 那一格根本没测过（当时的 assistant 探针把触发句**改写**成了 `I see … here.`
 * 的转述形态，而服务端逐字符匹配，那个形态本身就不含触发串，**等于空跑**）。
 *
 * 由此得到三条**不能违反**的实现约束：
 *
 * 1. **改 `system` 与 `assistant` 正文两处**，其余一概不碰：
 *    `user` / `tool` 结果 / `reasoning_content` / `tool_calls` 的 `arguments`
 *    实测**都不拦**（上表那四行 ✅）。改它们换不来任何放行，却会篡改用户原话、
 *    工具输出（那是要回读给模型看的证据）与模型自己的思考。
 *    ⚠️ 反向也要守住：**别把 `assistant` 这一格「简化」掉** —— 见下文「为什么必须
 *    连直连一起改」，那正是本轮线上报障的成因。
 *    ⚠️ 也不要扩到那四行：实测放行，且改了破坏前缀缓存与证据完整性。
 * 2. **改写所有** system 消息**，不只 `messages[0]`：非首位的 system 同样被拦
 *    （上表「指纹在第二条 system」那一行）。
 * 3. **大小写不敏感的精确匹配**：全小写与全大写都被拦（上表「全小写 / 全大写」
 *    那一行），所以 `replaceAll` 的字面量比对必须带 `i`；但**只差一个词**或
 *    **多一个空格**都不拦（上表「只差一个词」「内层多一个空格」两行），
 *    说明服务端认的是**逐字符的字面量**，**不能**把它泛化成正则/关键词。
 *
 * ⚠️ **可复核凭据已入库**（2026-10-12 审计补齐）：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts`。
 * 上面那四行 ★ **不是**本文件的自我声明 —— 它们各有一次真实发请求的用例。
 * ⚠️ 这个 e2e 文件不可省：单测只能锁「代码按这个范围改」，**锁不住这个范围对不对**。
 * 2026-10-12 的审计正是据此才发现初版把「只拦 system」写成了硬约束，而
 * `assistant` 那一格从未被测过（当时的探针还把触发句改成了转述形态，
 * 服务端逐字符匹配 ⇒ 空跑）。
 *
 * ## 为什么必须连**直连适配器**一起改（2026-10-12 真实报障，本节推翻初版取舍）
 *
 * 初版把改写**只**放在网关，理由有两条，其中一条已被实测证伪：
 *
 * - ✅ 仍然成立的：网关是外部客户端入口，指纹来自客户端模板注入。
 * - ❌ 已证伪的：「DSH 直连不受影响」。DSH 的 system 提示词确实不含这句，
 *   但**会话历史里的 `assistant` 正文会含** —— 而且几乎是必然：一旦用户让 agent
 *   排查这类风控问题，模型会先 `read` 记录该指纹的文档（`tool` 结果，不拦），
 *   再把它**逐字复述进自己的正文**（拦）。那条 assistant 消息从此每轮原样重放，
 *   于是**排查风控 bug 的会话本身被风控拦死**，症状是「这个 provider 从此每轮
 *   都失败，换任何一个腾讯系模型都一样」—— 2026-10-12 用户报
 *   `step-5-preview` 与 `space-bunny` 同错，正是这一条（**跟会话走，不跟模型走**）。
 *
 * ⇒ 所以这一层必须是**单一真相源**，同时被**两个方向**的调用方使用：
 *   `src/openai-gateway/{messages,responses}.ts`（外部客户端方向）与
 *   `src/buddy-adapter.ts` 的 `serializeMessages`（DSH 直连方向，含
 *   `options.system` 那个第四产出点）。
 *   **只在网关补 = 换一个入口又被拦**，与初版「三处接入点」是同一条教训的复现。
 *
 * ⚠️ 但「两个方向」**不等于**「已覆盖全部出站路径」：`src/buddy-growth.ts` 另有
 * 两处直发 `POST …/v2/chat/completions`（保连胜的「你好」、抓 requestId 的「1+1」），
 * **不经 `BuddyAdapter`、故不过这一层改写**。当前安全 —— 那两处请求体写死、
 * 既无指纹也无 assistant 历史；但一旦将来把它们改成携带历史或拼接用户内容，
 * 就会静默成为第三个未改写入口（其失败表象是整轮 400/11128，极难归因）。
 * 见 `buddy-growth.ts` 里那两处的注释。
 *
 * ⚠️ 直连侧改的是**已持久化的历史**，与 `stripCourseLeakFromHistoryContent`
 * 是同一类「存量自愈」逻辑（那个清的是模型自己的行首泄漏，这个清的是被上游拦的
 * 字面量），落点也因此贴着它，不另起一套遍历。
 *
 * ## ⚠️ 千万不要把 11128 加进 `isContentRejection`
 *
 * 那是**内容级**拦截：同一账号换掉这一句就通（上面「改写该句」一行）。
 * 认成「账号被策略拦」会触发换号 + 30 分钟账号冷却（`CONTENT_REJECTION_COOLDOWN_MS`），
 * 把整个账号池白锁 30 分钟，而真正该做的是改写那一句。
 * 维持现状（`isContentRejection` 只认 11140 / `request illegal` / 安全审核文案）
 * **是正确**的。
 *
 * ## 表驱动，而不是写死一处
 *
 * 屏蔽名单服务端掌握、可能随时更新，任何客户端将来都可能撞上新指纹。
 * 故这里是**表**：新增一条 = 往 {@link CONTENT_FINGERPRINTS} 里加一行 + 一条用例。
 */
/** 受影响的 provider：腾讯系两个后端（`buddy` = CodeBuddy 中国版，`workbuddy` = WorkBuddy 国际版）。 */
const TENCENT_PROVIDERS = ['buddy', 'workbuddy'];
/**
 * 已知会被腾讯网关拦下的 system 模板句。
 *
 * ⚠️ **每一条都必须有实发证据**（被拦 + 改写后放行，两条都要），
 * 照抄别家客户端的常量而没实测过 = 给上游加了一条没人验证过的改写。
 */
const CONTENT_FINGERPRINTS = [
    {
        // ZCode 内建常量：`$Js="Main branch (you will usually use this for PRs)"`。
        // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
        find: 'Main branch (you will usually use this for PRs)',
        replace: 'Main branch (PRs usually go here)',
        note: 'Gitee IKJNA1；本机 2026-10-05 对 workbuddy / CodeBuddy 双端点实测复现',
    },
];
/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const COMPILED = CONTENT_FINGERPRINTS.map((rule) => ({
    replace: rule.replace,
    findLower: rule.find.toLowerCase(),
    // `g` = 全部出现都改写；`i` = 大小写不敏感（实测全小写 / 全大写同样被拦）。
    pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}));
/** 该 provider 是否走腾讯系后端（有这套内容级风控）。 */
export function isTencentContentFingerprintProvider(provider) {
    return TENCENT_PROVIDERS.includes(provider);
}
/**
 * 把一段文本里已知的腾讯风控指纹做**窄改写**。
 *
 * ## 契约
 *
 * - **非腾讯系 provider 原样返回**（同一个函数指针意义上的同一份字符串内容）；
 * - **不含任何指纹的文本逐字符不变** —— 这一条是硬要求：腾讯侧按前缀缓存，
 *   无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：`Main branch (PRs usually go here)` 与原句
 *   语义等价，模型读到的仍是「主分支（提 PR 通常走这里）」。
 *
 * ## 本函数**刻意不认识角色**
 *
 * 「哪些角色该送进来」是**调用方**的策略（见文件头那张实测表的约束 1），
 * 不是这里的职责。当前该送的是 **`system` 正文**与 **`assistant` 正文**两处；
 * 该**不**送的是 `user` / `tool` 结果 / `reasoning_content` /
 * `tool_calls[].function.arguments`（实测都不拦）。
 * 新增调用点时请回到文件头核对实测行，别凭「统一一下」扩大范围。
 *
 * @param text 已取出的纯文本（system 或 assistant 正文）
 * @param provider `parseModelRoute` 得到的 provider 段，或产品的 id
 */
export function rewriteTencentContentFingerprints(text, provider) {
    if (!isTencentContentFingerprintProvider(provider))
        return text;
    let out = text;
    for (const rule of COMPILED) {
        // 预检：不含（小写化后的）字面量就整条跳过，`out` 保持同一份字符串内容。
        if (!out.toLowerCase().includes(rule.findLower))
            continue;
        // `String.replace` 配 `g` 正则会在调用前后把 lastIndex 归零，不会串状态。
        out = out.replace(rule.pattern, rule.replace);
    }
    return out;
}
//# sourceMappingURL=tencent-fingerprint.js.map