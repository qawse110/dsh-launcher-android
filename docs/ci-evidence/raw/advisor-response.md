# 回应上一轮审查（gaps）的四点，并附原始输出

## 审查意见 1：只看前后 url/title 无法区分「从未导航」与「先导航走再 restore」
### 回应：改用**结构证明**，不依赖时间采样。
在仿造 WebView 上记录上游收到的**全部** Runtime.evaluate 表达式；拒绝分支下计数为 0，
即 window.open 从未被发出 —— 不是「导航后还原」，而是根本没有这一步。
原始输出（docs/ci-evidence/raw/ego-webview-safety-proof.txt 内，disc2.mjs）：
    ego: refusal
    upstream Runtime.evaluate count : 0
    of which window.open           : 0
    targets                        : GUI_TARGET
    GUI url                        : http://127.0.0.1:3080/
    STRUCTURAL_PASS: 拒绝分支从未发出 window.open，用户页连被导航的机会都没有
另附时间采样（每 ~80ms，disc.mjs）作为交叉印证：
    samples: 10 ; anomalous states: NONE ; VERDICT: GUI 全程未被导航（判别通过）
与源码一致：openTarget 在 opener===null 时直接 throw，不进入 Runtime.evaluate 那一步。
（中继源码 app/src/main/assets/webview-cdp-relay.mjs 的 openTarget/pickOpener）

## 审查意见 2：B 只支撑接口对齐，不能当成「真 WebView 多窗口已验证」
### 回应：已按三档重写 ego-webview-claim.md：
  「一、已在真机（旧 APK）上验证」/「二、只在本机构造验证」/「三、代码级/CI 级」，
  并在每档写明「支撑什么、不支撑什么」。第二节明确写：
    「不支撑：真 WebView 的多窗口（Kotlin 侧）真的可用 —— 那需要装了新 APK 之后才能验证。
      页面内容本身来自仿造件的罐头数据，不是真网页。」

## 审查意见 3：断言数不一致（17 vs 18）
### 回应：以实测为准重数，并写入文档。
    $ grep -c 'check(' tools/webview-cdp-relay.test.mjs  → 19
    $ node tools/webview-cdp-relay.test.mjs | grep -c '  ✓ ' → 19
  claim 文档已改为 **19 项断言全通过**（旧的 17/18 是加断言过程中的过时数字）。

## 审查意见 4：C/D（单测、CI、81.6MB 产物）全为自述，无可核材料
### 回应：本机**取不回** Actions 产物与日志（Azure Blob 被 ECONNRESET），
可核的是**可复现命令 + 退出码**（建议审阅者直接跑）：
    node tools/webview-cdp-relay.test.mjs        → exit 0，19 项 ✓
    node tools/check-plugin-manifest.mjs         → builtin=10 optional=2，exit 0
    node tools/verify-prefix-patch.test.mjs      → exit 0
CI 结论经 GitHub API 读回（本机可取 runs/jobs/annotations）：
    sha 62267ff：CI 与 Build APK 均 completed/success；artifacts=1 app-debug-apk 81.6MB
若需更强证据，只能由用户从 Actions 页面下载该 81.6MB 包并重装后复现 qi-1。

## 仍然未闭环（不掩饰）
新 APK 尚未在真机上跑通（本机装的仍是旧 APK，且本机无法构建/取回 APK）。
这是本轮唯一未闭环的一步，需要用户下载并重装。
