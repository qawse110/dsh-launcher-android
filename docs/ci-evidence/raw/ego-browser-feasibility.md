# ego-browser 运行期缺口：浏览器能力侦察（本轮，原始命令输出）

## 结论速览
设备上**没有任何** Chrome/Chromium 二进制（find 命中 0）。
但**发现应用自身的 System WebView 暴露了活的 CDP 端点**，且能被真 ego 运行时驱动——
这不是完整答案（见「能力天花板」），但它是唯一「近零增量」的可能路径。

## 1. 设备现状
  pm list packages（12 个）里没有任何浏览器包；有 com.google.android.webview。
  chrome/chromium/chromium-browser/brave/msedge/headless_shell/chrome-headless-shell → 全部 not on PATH
  find / -maxdepth 6 -name 'chrome' -o -name 'chromium*' -o -name 'brave' → 0 命中

## 2. 【关键发现】应用 WebView 的 CDP 端点
  抽象 unix socket `@webview_devtools_remote_<app pid>` 可达。
  GET /json/version 返回：
    {"Android-Package":"com.dsh.nextapp1","Browser":"Chrome/153.0.8010.36",
     "Protocol-Version":"1.3","V8-Version":"15.3.76.10"}
  ⚠ 该 socket 存在说明**当前安装的是 debuggable（debug）构建**——
    Android 默认为 debuggable 应用打开 WebView 调试；源码里**没有**任何
    setWebContentsDebuggingEnabled 调用。release 包要复现必须显式加这一行。

## 3. 用真 ego 运行时驱动该端点（已实测成功）
  本地 TCP<->unix 中继 + EGO_LINUX_CDP_URL=ws://127.0.0.1:<port>/devtools/browser：
    page.info()     → {"url":"http://127.0.0.1:3080/","title":"...","w":361,"h":754}
    page.snapshot() → 32288 字符真实页面内容（DSH GUI 的可访问性树，含 ref/loc）
    page.evaluate() → 真实 navigator.userAgent / document.title
    browser.listTabs() → 1 个 page target
  ⇒ 读/求值/截图这类能力可用。

## 4. 【能力天花板】WebView 不支持 ego 需要的新建标签页
  直接对该端点发 CDP，实测：
    Target.createTarget         → {"code":-32000,"message":"Not supported"}
    Target.createTarget(bg)     → 同上
    Target.createTarget(ctx)    → 同上
    Target.createBrowserContext → {"code":-32000,"message":"Failed to create browser context."}
    HTTP PUT /json/new          → 500 "Could not create new page"
  ego 的每个工具都会先 useSpace() → taskSpaces.useOrCreate() → createTaskSpace()
  → Target.createTarget，这一步在 WebView 上**必失败**。
  ⇒ 且 socket 上只有 1 个 page target，就是**用户正在看的 DSH GUI**；
    任何「导航现有页」的绕法都会把用户的界面导航走。

## 5. Termux 源里确有 Android 原生 chromium，但体积远超阈值
  termux-main 源：无 chromium（3006 包实测，只有 geckodriver 等）。
  termux-x11 源：有 chromium 154.0.8037.97。
  离线算出的完整依赖闭包（Termux main + x11 索引，4177 个包）：
    chromium : 172 包，下载 266 MB，装机 **1.24 GB**
      chromium 647.6MB / libllvm 165.6MB / ffmpeg 35.7MB / gtk3 30.8MB / python 25.6MB ...
    firefox  : 148 包，下载 180 MB，装机 0.86 GB
    webkit2gtk-4.1: 158 包，下载 137 MB，装机 0.71 GB
  磁盘现状：/data/user/0 共 218G，**仅剩 3.0 GB 可用，已用 99%**。
  ⇒ 1.24 GB ≈ 剩余空间的 41%，且与用户设定的「增量应与现有内置插件（约 1.4 MB）同量级」相差约 900 倍。

## 6. 环境有一处**先于本轮**的 apt 破损，会挡住任何安装
  dpkg 状态：configured(ii)=89，unpacked 未 configure(iU)=**39**
  这 39 个（abseil-cpp/alsa-lib/dbus/freetype/brotli/libx11/...）的 dpkg info mtime = 2026-10-11 19:02，
  早于本轮工作；chromium 依赖闭包里的 gtk3/dbus/libx11 等正好落在其中。
  实测 `apt-get install -s --fix-broken chromium` → E: Unmet dependencies。
  ⇒ 要装 chromium 必须先 `apt --fix-broken install`（会配置这 39 个包，是对用户 Termux 环境的实质改动）。

## 7. 无法在本机重建 APK
  java/javac/gradle/sdkmanager/aapt/aapt2/d8/apksigner/zipalign → 全部 absent；
  ANDROID_HOME 为空；/storage/emulated/0/Android/sdk 不存在。
  ⇒ 任何需要改 Kotlin（例如给 WebView 开多窗口 + 显式打开调试）的方案，
    都必须走 CI 出包 + 用户重装。

## 8. 出网
  GitHub / api.github.com：不可达（TLS unexpected eof）。
  npmmirror：可达，但其 chrome-for-testing / chromium-browser-snapshots 只有桌面构建，
    没有 Android 构建 ⇒ 不能给 Android 塞内核；lightpanda 在 npmmirror 上 404。
  packages.termux.dev / sustech 镜像：可达。

## 9. 两条真正可行的路线（都需要用户裁决）
  A. 让应用 WebView 支持多窗口 + 显式开调试，再在 CDP 侧做一层 Target.createTarget→window.open 垫片。
     体积增量：0（复用已装的 System WebView）。需要：改 Kotlin（约 30 行）+ 出一次 APK + 重装。
  B. 在 Termux 里 apt 装 chromium（x11 源）。体积增量：约 1.24 GB，且需先修 39 个包的破损状态。
     不需要改 APK；立刻可用（前提是 repair 顺利且 headless 能跑）。

## 10. 本轮已做的环境改动（可回滚）
  为探测 B 路线可用性，临时加了 $PREFIX/etc/apt/sources.list.d/x11.list 并跑了 apt-get update。
  未安装任何包，未改动 dpkg 状态；该文件在暂停时已移除。

## 11. 精确失败点复现（真 ego 运行时 + 隔离 state）
  EGO_LINUX_CDP_URL=<中继> EGO_LINUX_STATE_DIR=<tmp 隔离> ego-browser nodejs:
    taskSpaces.useOrCreate('probe-space') → ERR "Not supported"
    （即 Target.createTarget 被 WebView 拒绝，ego 每个工具的第一步就断在这）
    browser.createTab                   → createTab is not a function（heredoc 里没有这个全局）

## 12. 额外确认
  - 全应用只有 WebViewActivity 一处 new WebView()；单实例、launchMode=singleTask。
  - 该 WebView 上 CDP 只有 1 个 page target（就是用户的 DSH GUI）。
  - 本轮探测未改写用户的 DSH 页面（全程只做 info/snapshot/evaluate 读取，未导航）。
  - 探测产生的 $HOME/.local/state/ego-lite-linux/task-spaces.json 是 ego 正常会建的**空状态**
    （spaces: [], nextId: 1），非破坏性；不想要可直接删。

## 13. 磁盘可回收量（决定路线 B 是否勉强可行）
  files/tmp 占 **1.5 GB**，其中大部分是 2026-10-07 的 node 前缀适配实验残留：
    o4..o9 / rename-verify        各 113 MB（共约 680 MB）
    nodefix-backup-* / nodefix2-backup-* / nodefix   约 200 MB（**是 node 的回滚备份，不能擅自删**）
    origin2/3 / hj4-* / hijack-*  各约 48–65 MB
  这些**不是**本轮产生的。若用户同意清理其中纯实验副本，可用空间可从 3.0 GB 提到约 4.5 GB。
  但 nodefix-backup-* 是 node 二进制被改写前的备份（见 node RUNPATH/OPENSSLDIR 修复），删掉等于放弃回滚能力——
  故本报告**没有**删除任何一项。

## 14. 本轮最终判定
  qi-1（ego_doctor 不再 none found + 一次真实取页）**未达成**。
  原因不是没查，而是查完发现：三条候选路线里没有一条能同时满足用户的三个质量维度。
  详见上文 2/4（WebView 能力天花板）、5（chromium 体积）、6（apt 破损）、7（无法本地出包）。
