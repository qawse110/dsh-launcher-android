# 隔离：agent 浏览器插件不得控制用户界面（2026-10-13 本轮）

## 用户报告的问题
「agent 浏览器插件会控制到 dsh webui 和用户在 webui 打开的界面」。

## 复现（隔离前，真机真 WebView）
中继只拦截 Target.createTarget / Target.closeTarget，其余**原样透传**；
/json/list 与 Target.getTargets 都把用户 GUI 的**真 targetId** 暴露给 ego。
证据（本轮实测）：
  GUI id = 523751C1FD7008
  attach 到 GUI → ★ 成功 sessionId=8A7448E64F4F
  ① 读 location.href   → "http://127.0.0.1:3080/"
  ② 读 document.title  → "将liustack/modsearch和dsh-ego-browser — DeepSeek Harness"
  ③ 读 document.cookie → 可读
  ④ Page.enable        → 成功
  ⑤ Input.dispatchKeyEvent → ★ 成功（能向你的界面注入键盘）
  ⑥ 执行 JS (1+1)      → 2
⇒ 用户界面可被读、可被注入、可被导航。

## 修复（只改 webview-cdp-relay.mjs，不碰 Kotlin / dsh 前端）
核心：**只有中继自造的页对客户端可见**（st.agentIds）。
1. openTarget 成功后把新 targetId 登记进 st.agentIds；
2. Target.getTargets 的返回按 agentIds 过滤，并**重新序列化**下发
   （只改 msg.result 而照发 frame.raw 是不生效的——这是本轮修掉的一个真 bug）；
3. /json/list（HTTP）同样过滤（新增 filterListBody + st.listWanted 走可改写路径）；
4. Target.attachToTarget：非 agent 页一律拒绝（GUI 永不进 agentIds）；
5. 事件侧：targetCreated / targetInfoChanged / targetDestroyed 里非 agent 的 target 直接吞掉，
   否则 agent 靠订阅事件就能捡到用户页 id，前面的列表过滤白做；
6. Target.setAutoAttach / Target.exposeDevToolsProtocol：拒绝（这两条能绕过 attach 闸门）；
7. HTTP /json/close|activate/<id>：非 agent id 一律 404，不转发。

## 验收（隔离后，真机真 WebView）
  A) HTTP /json/list        → []            （GUI 已不暴露）
  B) WS Target.getTargets    → page 数 = 0   （GUI 已不可见）
  C) attach 到真 GUI id      → ★ 被拒：refusing to attach to a non-agent target
  D) relay DBG：/json/list 703 → 2 bytes；hid 1 user target(s) from Target.getTargets

## 不过度拦截（agent 仍要能用）
真 ego 运行时 + 真中继 + 仿造新 APK 多窗口行为：
  ego: RESULT_OK {"tabsSeen":1,"url":"https://example.com/"}
  ⇒ 隔离后 agent 仍能新建页、listTabs 只看得到自己的页、并能取回内容。

## 自测
tools/webview-cdp-relay.test.mjs：24 项断言全通过（含 4 条隔离断言：
客户端看不到任何页 / 只看到 agent 页 / attach 到 GUI 被拒 / attach 到 agent 页仍成功）。

## 诚实边界
- 本轮改动只在**中继层**（CDP 视图）。若 agent 真能绕过中继直连抽象 socket，
  该隔离不适用——但那需要同 uid 任意进程权限，已超出本插件的攻击面。
- **存储/登录态未隔离**：CookieManager 是全局的，agent 的页与用户页可能共享存储。
  本轮未做（需 setDataDirectorySuffix，且必须在首次使用 WebView 前调用，
  代价是两侧登录态彻底不共享）。**这一条要用户决定是否要。**
- 隔离在**真机旧 APK** 上已验证；新版（含 Kotlin 多窗口）需装包后再验一次。


---

## 补强（第二轮核对后）

审查指出「逐个方法黑名单会漏」，故改为**按参数判定**：

### 通用 default-deny（覆盖未知方法）
**任何**带 params.targetId（或 target）的 CDP 调用，只要那个 id 不是中继自造的
agent 页，一律本地拒绝、不转发。这样 getTargetInfo / activateTarget /
getWindowForTarget / attachToBrowserTarget 之类不必逐个枚举。
真机实测（真 GUI id 523751C1FD7008）：
  Target.getTargetInfo      → ★ 被拒
  Target.activateTarget     → ★ 被拒
  Target.getWindowForTarget → ★ 被拒
  Target.getTargetInfo(<agent 页>) → ★ 放行（不误伤 agent 自己）

### 单数 targetInfo 也不外露
Target.getTargetInfo 返回的是**单数** targetInfo，原先只过滤了数组 targetInfos。
现在单数也过同一道闸门（非 agent 页则回空对象）。

### 修掉一处过度拦截
原先按 st.sess.has(sessionId) 过滤 Target.attachedToTarget。但 st.sess 是
**每连接**的，客户端自己 attach 产生的 session 不在其中 ⇒ 会误吞 agent 自己的
事件。中继从不 attach 用户的 GUI，所以该过滤没有安全收益，已移除。

### 真机复核（默认拒绝生效的那一轮）
  agent 页 = 4C788D746CBE；Target.getTargets → 1 页（无用户 GUI）
  真 ego 运行时经中继：RESULT_OK {"tabsSeen":1,...}（agent 仍可用）
自测：32 项断言全通过，exit 0。

### 已知残余（诚实边界）
- Target.attachToBrowserTarget 仍返回一个**浏览器级** session。它本身不暴露任何
  页内容，且此后任何带 targetId 的调用都会被 default-deny 挡住；但严格说
  「浏览器级 session 的存在」未被消除。**未验证**它能否在不带 targetId 的
  方法上读到用户数据。
- 存储/登录态未隔离（同前）。
- 真机验证是在旧 APK（无多窗口 Kotlin）上完成。
