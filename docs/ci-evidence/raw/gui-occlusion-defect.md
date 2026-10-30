# 缺陷：多窗口弹层遮住 dsh GUI（已修，待真机验证）

## 用户报告
原话：「启动多窗口方案时原 dsh webUI 也不可见了」

## 根因（代码 + 真机日志双向确认，不是推断）
app/src/main/java/com/dsh/nextapp1/ui/WebViewActivity.kt 的 openPopupWebView 里：
    val layer = popupLayer ?: FrameLayout(this).apply {
        setBackgroundColor(Ui.BG)                 // Ui.BG = 0xFF0F1116（不透明）
        layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
    }.also { rootView?.addView(it) }              // ← 默认加到**顶层**
而 rootView 的子视图顺序是：progressBar(96) → webView(98) → errorView(143) → popupLayer(549)。
后加的盖在上面 ⇒ 弹层把 dsh GUI 的 WebView 整屏遮住。

## 为什么"永久"不可见（两个缺陷叠加）
1. 遮挡：弹层 MATCH_PARENT + 不透明背景，盖住 GUI。
2. 关不掉：closeTarget 用 await internalCall("Runtime.evaluate", window.close())，
   真机上 WebView 不回这条回包 ⇒ 每次白等 15s 超时；页面其实已在关，但**弹层与子
   WebView 的销毁依赖 onCloseWindow**，回包丢失时这条链不完整。
   叠加结果是：用户界面被盖住且不会自行恢复，只能重启应用。

## 真机日志证据（files/dsh.log，WebViewActivity 标签）
    2026-10-12 07:32:21.896 popup WebView created (total=1)
    2026-10-12 07:32:40.064 popup WebView created (total=2)
    2026-10-12 07:32:58.406 popup WebView created (total=3)
    2026-10-12 07:34:21.898 popup WebView created (total=4)   ← 同时 4 层叠着
    2026-10-12 07:36:48.563 popup WebView destroyed (remaining=3)   ← 4 分钟后才开始回收
    ...
    2026-10-12 07:39:38.117 popup WebView created (total=1)
    2026-10-12 07:45:01.424 popup WebView destroyed (remaining=0)
  ⇒ 6 次 created、最多同时 4 个存活，回收滞后数分钟 ⇒ 用户在这几分钟里看不到自己的界面。

## 修复（提交 e144e9c）
1. Kotlin：`rootView?.addView(it)` → `rootView?.addView(it, 0)`
   索引 0 = 最底层，弹层压在 GUI WebView **下面**。
2. 中继 closeTarget：不再等回包；依次 fire
   Page.close（真机实测有效，会触发宿主 onCloseWindow → 真正 destroy 子 WebView）
   → window.close() → 原生 Target.closeTarget。
3. 自测修两个真问题：startRelay 原用 ...process.env 会继承 shell 里泄漏的 EGO_LINUX_*，
   使「未开多窗口」那一档实际按多窗口跑；阶段二未重置仿造 targets。

## 前提与风险（诚实标注）
- 修复依赖一个假设：**放在底层（被 GUI 覆盖、visible=false）的 WebView 仍能被 CDP
  枚举并执行 JS**。真机曾观测到 visible=false 的 target 仍在 /json/list 且尺寸正常
  （1264x2640），中继判断「页面」也从不读 visible 字段。
- 但「visible=false 时仍可 evaluate」这一条，本轮**未能在真机上正面复现**
  （当前只有 1 个 page、visible 恒为 true；示例页已被清掉）。因此该前提属
  **部分验证**，需要装新包后确认 ego 仍能新建页并取回内容。
- 若该前提不成立（底层 WebView 不渲染 ⇒ ego 拿不到内容），退路是：
  保留顶层但给返回键/超时自动关闭弹层，或改为 1×1 角标叠放。

## 待验证（装新 APK 后）
1. ego 新建页仍成功并取回真实内容（前提成立的正面证据）。
2. 用户的 dsh GUI 全程可见（这是本次修复的目标）。
3. 关页现在能真正回收（dsh.log 出现 popup WebView destroyed）。
