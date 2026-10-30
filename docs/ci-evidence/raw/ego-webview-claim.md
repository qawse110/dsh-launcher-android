# 证据：ego 新建页能力的「可验证程度」（本轮 2026-10-11）

设备：Realme RMX3888 / RE5C37 / Android 16 / arm64-v8a，包 com.dsh.nextapp1（uid 10904）。
安装的是**旧 APK**（本轮的 Kotlin 改动**尚未**装到设备上）。

> 三档严格分开，**仿造件的输出一律不放一档**：
>   一档 = 真机 + **真** WebView + 真 ego 运行时（原始日志见同目录 real-webview-*.log）
>   二档 = 本机构造（真 ego 运行时 + 真中继 + **仿造** WebView）
>   三档 = 代码级 / CI 级

---

## 一档：真机 + 真 WebView

### 1.1 新建页被拒绝（真 WebView，原始输出见 real-webview-refusal.log）
  中继**未**设 EGO_LINUX_WEBVIEW_SOCKET ⇒ 自行解析到真应用的
  `webview_devtools_remote_28790`（非仿造件）。真 ego 运行时调
  `taskSpaces.useOrCreate`：
    OUTCOME refusal: refusing to open a window: the only page is the user's dsh UI,
    and window.open() on it would navigate it away. Enable multi-window
    (setSupportMultipleWindows + onCreateWindow) so a second WebView exists.
  同一轮前后观测（RELAY_DEBUG=1）：
    GUI BEFORE: url=http://127.0.0.1:3080/  title=将liustack/modsearch和dsh-ego-browser — DeepSeek Harness
    GUI AFTER : url=http://127.0.0.1:3080/  title=将liustack/modsearch和dsh-ego-browser — DeepSeek Harness
    page count: before=1 after=1
    relay debug lines: []
    restoreUserPage 是否导航过: 否（从未导航，无需还原）

  「无事后还原」的判据：若中继曾「先导航走再 Page.navigate 还原」，它会打印
  `DBG restored user page -> ...`（源码 webview-cdp-relay.mjs 的 restoreUserPage）。
  真机这轮该行为空。
  ⚠ 脚本断言的是 **url 未变 + 无还原行**；title 未变是同一轮观测到的（前后值相同），
  但**未写成脚本断言**。
  **支撑**：真 WebView 上「拒绝语义正确」+「url 未变」+「中继未执行还原导航」。
  **不支撑**：仅凭离散前后快照 + 无还原日志，**不能百分之百排除**一次极快的
  「先导航、又被 restore 覆盖」的瞬时损伤。能彻底排除「发出过导航调用」的是
  二档的全方法计数（本机构造）。

### 1.2 ego --status 由 false 变 true（真机，原始输出见 real-webview-status.log）
  中继自行解析真 socket（`webview_devtools_remote_28790`）后：
    {"running": true, "port": 42122, "wsUrl": "ws://127.0.0.1:42122/devtools/browser",
     "binary": "webview-cdp-relay", "via": "android-system-webview-relay", ...}
  （此前为 `{"running": false}`，见 K5-K6-raw.txt。）
  **支撑**：真机上 ego 不再报「未找到浏览器二进制」。

---

## 二档：本机构造（真 ego 运行时 + 真中继 + **仿造** WebView）

> 仿造件只复刻真 WebView 的四条关键行为：/json/version 的 ws url 不带端口、
> permessage-deflate 有条件接受、收到 window.open 就注册出第二个 page target
> （= onCreateWindow 的作用）、attach 回**唯一** sessionId。
> 中继与 ego 运行时是真的，**WebView 一侧是仿造的**。

### 2.1 结构证明：拒绝分支对上游**没有任何导航类调用**
  记录上游收到的**全部** CDP 方法（不只 Runtime.evaluate）：
    upstream methods (all)          : Browser.getVersion, Target.getTargets, Target.getTargets
    upstream Page.navigate count    : 0
    upstream Runtime.evaluate count : 0
    of which window.open            : 0
    STRUCTURAL_PASS
  既没发 window.open，也没发 Page.navigate ⇒ 既不会被 window.open 导航走，也**不存在**
  restoreUserPage 那种事后还原导航 ⇒ 没有任何导航动作。
  （`disc-structural.mjs` + `ego-webview-safety-proof.txt`，同目录）
  **支撑**：中继拒绝语义在「一个导航调用都不发」这一强意义上成立。
  **不支撑**：真 WebView 的行为——该实验 WebView 一侧是仿造的。

### 2.2 垫片与 ego 接口对得上 ⇒ 一旦宿主多窗口生效，新建页就走通
    RESULT_OK {"page":{"url":"https://example.com/","title":"Example Domain",
                        "w":1280,"h":720,...}} ; targets: GUI_TARGET, AGENT_TARGET ;
    GUI url intact: true
  **支撑**：中继垫片 ↔ ego 运行时的 CDP 报文序列、attach 唯一性、ws url 形态对齐。
  **不支撑**：页面内容来自仿造件罐头数据，不是真网页；真 WebView 的多窗口（Kotlin 侧）
  是否可用，必须装新 APK 后才能验证。

### 2.3 组件级自测
  `tools/webview-cdp-relay.test.mjs`：**19 项断言全通过**，exit 0
  （原始日志 `local-gates.log`，同目录）。覆盖 ws url 补端口 / 剥 permessage-deflate /
  未开多窗口时拒绝且 GUI url 未变 / GUI 被导航走后仍被拒（身份钉住 targetId）/
  开多窗口时 1→2 且 GUI 保留。同样是「仿造 WebView + 真中继」。

---

## 三档：代码级 / CI 级

- `EGO_LINUX_CDP_URL` 使 vendored `ensureBrowser()` 短路、不再 resolveBinary/spawn ——
  这是**代码级**论断（1.2 的真机 `--status` 是其观测结果）。
- `openTarget` 在 `opener === null` 时**直接 throw**，位于 `Runtime.evaluate(window.open)`
  之前；`pickOpener` 在「无 agent 页且未开多窗口」时返回 null，绝不退回 `pages[0]`
  —— 代码级，解释一档/二档的拒绝语义。
- CI 首轮抓出真编译错 `WebViewActivity.kt:206:39 Function invocation
  'supportMultipleWindows()' expected`（WebSettings getter 无 get 前缀）——
  本机无 JDK，这类语义错误只能靠 CI 的 Assemble debug 门禁暴露。已修。
- 既有门禁未被打破（`local-gates.log`）：check-plugin-manifest → builtin=10 optional=2
  exit 0；verify-prefix-patch.test → exit 0；webview-cdp-relay.test → 19 项 exit 0。
- CI 结果经 GitHub API 读回：sha 62267ff 的 CI 与 Build APK 均 completed/success，
  产物 app-debug-apk 81.6MB。
  ⚠ **本机取不回 Actions 日志与产物**（Azure Blob 被 ECONNRESET），
  此条**仅为 API 读回的自述**，无本地产物校验。

---

## 四、尚未验证 / 未闭环

1. **新 APK 尚未在真机上跑通**（本机装的仍是旧 APK；本机取不回 Actions 产物、
   也无法构建 APK）。⇒ 「手机上跑出 qi-1」必须由用户下载并重装 81.6MB 的
   app-debug-apk 后验证。
2. Kotlin 侧 setSupportMultipleWindows + onCreateWindow **只经 CI 编译验证**，
   未经真机运行验证 —— 与 1 同属待用户装包后才能闭环。
3. 一档 1.1 的「无瞬时损伤」不能由真机离散快照独立证明，只由二档构造实验支撑。
4. 新开的页面对用户**可见**（本轮取舍，未做离屏/隐藏）。

## 五、分发体积
未随包/随装引入任何浏览器二进制。增量 = 文本资产 `webview-cdp-relay.mjs`（约 24KB）
+ Kotlin 数十行，与「现有内置插件约 1.4MB」同量级。
