# 浏览器能力侦察（本轮，全部为原始命令输出）

## 1. 设备上没有任何 Chrome/Chromium 二进制
  对 chrome/chromium/chromium-browser/brave/msedge/headless_shell/chrome-headless-shell 逐个 command -v → 全部 not on PATH
  find / -maxdepth 6 -name 'chrome' -o -name 'chromium*' -o -name 'brave' → 命中 0

## 2. 已安装包：无浏览器，但有 System WebView
  com.google.android.webview 存在（Chromium 153.0.8010.36）；无任何 Chrome/Brave/Edge/Firefox 包

## 3. 【关键发现】应用自身 WebView 暴露了活的 CDP 端点
  抽象 unix socket `@webview_devtools_remote_<app pid>` 可达；HTTP /json/version 返回：
  {"Android-Package":"com.dsh.nextapp1","Browser":"Chrome/153.0.8010.36","Protocol-Version":"1.3"}
  用本地 TCP<->unix 中继 + 真 ego-browser 运行时驱动该端点，实测成功：
    page.info()     → {"url":"http://127.0.0.1:3080/","title":"...","w":361,"h":754}
    page.snapshot() → 32288 字符真实页面内容（真实的 DSH GUI 可访问性树）
    page.evaluate() → 返回真实 navigator.userAgent / document.title
  但该端点的能力上限（同一 WebView，实测）：
    Target.createTarget        → {"code":-32000,"message":"Not supported"}
    Target.createBrowserContext→ {"code":-32000,"message":"Failed to create browser context."}
    fetch.browser(...)         → TypeError: Failed to fetch
  ⇒ Android WebView 每个实例只有 1 个 page target，ego 的 useSpace→createTaskSpace 建新标签页一步必失败。
  ⇒ 且唯一那个 page 就是用户正在看的 DSH GUI；ego 一旦接管并导航它，会破坏用户界面。

## 4. 【关键发现】Termux x11 源里有 Android 原生 chromium，但代价很大
  仓库索引实测（packages.termux.dev / 清华镜像均同）：
    [chromium] Version=154.0.8037.97  InstalledSize=648768KB  Size=154418984B(~154MB 下载)
    Depends=atk,cups,dbus,fontconfig,gtk3,krb5,libc++,libevdev,libxkbcommon,libminizip,libnss,libx11,mesa,openssl,pango,pipewire,pulseaudio,zlib
  ⇒ 安装后占用约 634MB + 一大堆 X11/GTK 依赖，合计约 1GB 量级。
  注意：termux-main 源里没有 chromium；只有 termux-x11 源有。当前设备只配了 termux-main。

## 5. 磁盘/内存现状（这才是真正的约束）
  /data/user/0  228572220 KB 总，仅 3226744 KB(≈3.1GB) 可用，已用 99%
  MemTotal 11.5GB / MemAvailable ≈1.7GB / Swap 16GB
  ⇒ 1GB 的 chromium 与依赖会吃掉可用空间的约三分之一，设备已处于 99% 满盘。

## 6. 环境已有一处预先存在的 apt 破损（非本轮造成）
  dpkg 状态：configured(ii)=89，unpacked-but-not-configured(iU)=39
  这 39 个的 dpkg info 目录 mtime 是 2026-10-11 19:02（早于本轮工作），且其中并不含 chromium 相关包。
  任何 chromium 安装都要先 apt --fix-broken，会牵动这批包。

## 7. 无法在本机构建 APK（若要改 WebView 支持多窗口）
  java/javac/gradle/sdkmanager/aapt/aapt2/d8/apksigner/zipalign 全部 absent；ANDROID_HOME 为空；无 sdcard SDK。
  ⇒ 任何需要重建 APK 的方案都必须走 CI + 用户重新安装。

## 8. 出网情况
  GitHub / api.github.com 不可达（TLS unexpected eof）。
  npmmirror、packages.termux.dev、sustech 镜像可达。
  npmmirror 的 chrome-for-testing / chromium-browser-snapshots 只有桌面平台构建，没有 Android 构建 ⇒ 不能靠它给 Android 塞一个内核。
  lightpanda 在 npmmirror 上不存在（404）。
