# 证据：中继 createTarget→window.open 垫片的安全守卫（原文摘录 + 自测结果）

## 背景约束（真机实测）
宿主 WebView 未开多窗口时，对页面执行 window.open(url,"_blank") **不会失败**，
而是把**当前页**导航到该 url。本轮实测把用户的 dsh GUI 导航成了 about:blank。
所以「新建页」这条路必须保证：要么真的多出一个 target，要么明确失败，绝不导航用户页。

## 守卫 1：pickOpener 拒绝策略（唯一页是 GUI 且未开多窗口 ⇒ 返回 null）
  const MULTIWINDOW = process.env.EGO_LINUX_WEBVIEW_MULTIWINDOW === "1";
  function pickOpener(pages) {
    const agentPages = pages.filter((p) => !isUserPage(p));
    if (agentPages.length) return agentPages[0];
    if (MULTIWINDOW) return pages.find(isUserPage) || pages[0] || null;
    return null;   // ← 未开多窗口且只有 GUI 页：宁可失败
  }
  // openTarget：opener 为 null 时直接抛错，不执行 window.open
  if (!opener) { throw new Error("refusing to open a window: the only page is the user's dsh UI, ..."); }

## 守卫 2：restoreUserPage 兜底（万一 GUI 被导航走，事后导航回原 url）
  before 时记录 guiId/guiUrl；window.open 之后无论成功或超时都调用 restoreUserPage：
  若 GUI 页 url !== 原 url，则用内部 session 发 Page.navigate 回原 url。

## 守卫 3：window.open 必须回原始值（否则 -32000）
  expression = "(function(){try{return window.open(URL,\"_blank\")?1:0}catch(e){return -1;}})()"
  returnByValue:true  // 直接返回 Window 对象会报 "Object reference chain is too long"

## 守卫 4：closeTarget 不关用户页
  if (target && isUserPage(target)) { /* 拒绝关闭 */ }

## Kotlin 侧配合（宿主真正造出第二个 WebView）
  webView.settings.apply { javaScriptCanOpenWindowsAutomatically = true; setSupportMultipleWindows(true) }
  onCreateWindow: 若 !settings.supportMultipleWindows() 返回 false；
                 否则 WebViewTransport.sendToTarget() 交出一个**独立** WebView 实例
                 （独立实例才会在同一 devtools socket 上注册成另一个 page target）。
  onCloseWindow / onDestroy: 回收子 WebView，避免漏渲染进程。

## 自测（tools/webview-cdp-relay.test.mjs，零依赖复现四类真实行为）
  仿造 WebView socket 后断言，17 项全通过，含：
    ✓ version 的 webSocketDebuggerUrl 被补回端口
    ✓ 客户端请求里的 permessage-deflate 报价被剥掉
    ✓ 未开多窗口时 createTarget 被拒，且 GUI 页 url 全程不变
    ✓ 开多窗口时 createTarget 真的多出 1 个 page，且 GUI 页保留、url 未变
    ✓ PUT /json/new 被本地接住
  运行：node tools/webview-cdp-relay.test.mjs → exit 0
