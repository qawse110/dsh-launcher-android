# 新 APK 可用性检查：发现的两个真实缺陷（2026-10-11 真机）

## 缺陷 1（中）：popup WebView 关不掉
- 现象：用生产环境建出的新页（https://example.com/），经中继发
  `Target.closeTarget` → 30s 超时且页面**仍在**；直接对该页端点发
  `Runtime.evaluate("window.close()")` 与 `Page.close` 也全部超时且无效。
  多轮测试一度累积 4 个 popup（/json/list 里全是 page）。
- 代码定位：中继 `closeTarget()`（app/src/main/assets/webview-cdp-relay.mjs:355+）
  先 attach 再 `Runtime.evaluate({expression:"window.close()"})`，随后
  `internalCall` 等回包（15s 超时）。真机表现为该回包永不到达。
- 用户可见后果：**尚不能确定是否遮挡界面**。实测该 popup 的 webview 元数据是
  `visible=false, attached=true, 1264x2640 @0,140`（与 GUI 同尺寸、同位置），
  但同一时刻 GUI 也是 `visible=true`；未能截图（screencap 在无 root 下失败），
  故无法断言用户到底看到哪一个。**这是一个未闭环的用户体验风险。**
- 缓解现状：残留页最终会消失（实测一段时间后 /json/list 回到只剩 GUI 1 页），
  可能由 WebView 自身的空间回收/生命周期触发，但**不由我们的代码保证**。
- 影响：ego 的 `closeSpace` / 关标签类工具在新后端上不可靠。

## 缺陷 2（轻）：page.snapshot() 返回空
- 现象：`page.snapshot()`（结构化 a11y 树）在新 WebView 上返回 0 字符；
  同一页面 `snapshotRaw()` 返回 1065 字符正常，`page.evaluate()` 也正常。
- 影响：ego 的 `ego_snapshot` 工具（移动端最主要的「看页面」手段）会拿到空内容；
  插件里 read 类工具走 `page.snapshotRaw()`（见 lib/index.js:3771）所以**不受影响**，
  但直接调 `ego.snapshot()` 的路径（以及 human-check 探针）会退化。
- 未定位：需要进一步判断是 WebView 不支持该 DOMSnapshot/Snapshot 路径，
  还是中继转发 session 的问题。

## 结论
- 「新建页 + 取回真实内容 + 不动用户 GUI」**已经在一档达成**（见 new-apk-usability-proof.txt）。
- 但「关掉新建的页」这一条**未通**（缺陷 1），属于本轮暴露的新缺口，
  不是上一轮的遗留问题。
