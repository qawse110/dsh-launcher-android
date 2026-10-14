/**
 * 共享的 **Chromium 会话**：起一个 chromium、接上 CDP 通道、把它（连同窗口）干净地收掉。
 *
 * ## 为什么抽出来（2026-10-08）
 *
 * 本仓库原本只有 ZCode 需要外挂 chromium（阿里云 captcha）。库库AI（百度 GenFlowPro）
 * 的登录是 **cookie 登录而非 OAuth**（见 `docs/agent-notes/providers-kukuai.md` §5.4），
 * 要把 `.baidu.com` 上的 **HttpOnly** cookie 取回来，同样只能靠「自己起浏览器 + CDP」。
 *
 * 于是「起 chromium」这件事有了第二个调用方。而下面这些**每一条都是真实缺陷换来的**，
 * 各写一份必然分叉（分叉的方向恒定是「漏修的那份」）：
 *
 * | 缺陷 | 症状 | 修法 |
 * |---|---|---|
 * | 不监听 `'error'` | spawn 失败时**未捕获异常直接杀掉整个宿主** | `child.once('error', …)` |
 * | 只杀主进程 | chromium 是多进程（实测 13 个），子进程变孤儿 | `taskkill /T` / 进程组 |
 * | 异步 `taskkill` | 调用方以为清理完了，旧实例还占着端口 | `spawnSync` |
 * | 端口纯随机 | 连到旧实例 → `child` 指向死进程 → 整棵树泄漏 | 探测空闲端口 + 校验应答端口 |
 * | 一次性 `rmSync` | 句柄未释放，残留数十个 profile 目录 | 退避重试 |
 * | 窗口进任务栏 | 每次刷新都在任务栏闪烁（用户报障） | `WS_EX_TOOLWINDOW` / EWMH / 最小化 |
 *
 * ## 与 ZCode 的关系
 *
 * `src/zcode-captcha.ts` 的 `ZcodeCaptchaBrowser` 改为**组合**本模块的
 * {@link ChromiumSession}，captcha 专属的东西（反检测补丁、页面池、DOM 重置、
 * 表达式构造）全部留在那边。本模块**不含任何 captcha 语义**。
 *
 * ⚠️ 浏览器**发现**（{@link browserCandidates} 一族）与**窗口隐藏**也在这里：
 * 它们回答的是「哪个 chromium 可用」「怎么让它别打扰用户」，同属浏览器设施。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix } from 'node:path';
/**
 * macOS 的浏览器包名 → 包内可执行文件名。
 *
 * ⚠️ 两者**不同**：`Microsoft Edge` 在 Windows 上是 `msedge.exe`，
 * 而 macOS 包内二进制就叫 `Microsoft Edge`。这是 issue IKJKNT 的成因之一。
 */
const MAC_BROWSER_BUNDLES = [
    ['Google Chrome.app', 'Google Chrome'],
    ['Chromium.app', 'Chromium'],
    ['Microsoft Edge.app', 'Microsoft Edge'],
    ['Brave Browser.app', 'Brave Browser'],
];
/** Windows 候选链（逐字保留自重构前，⚠️ 改这里等于动本仓库绝大多数用户）。 */
function windowsBrowserCandidates(env, home) {
    const localAppData = env.LOCALAPPDATA ?? '';
    const programFiles = env.PROGRAMFILES ?? '';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? '';
    return [
        /**
         * ① scoop 的 **显式声明的**根目录优先于默认推导。
         *
         * `SCOOP` / `SCOOP_GLOBAL` 是 scoop 自己的「我装在哪」的权威声明 ——
         * 用户设了它们就说明默认路径不对。若排在 `~/scoop` 之后，会出现
         * 「旧默认路径恰好存在 → 用它，而用户实际在用的那个被忽略」。
         */
        ...(env.SCOOP !== undefined && env.SCOOP.trim().length > 0
            ? [join(env.SCOOP.trim(), 'apps', 'chromium', 'current', 'chrome.exe')]
            : []),
        ...(env.SCOOP_GLOBAL !== undefined && env.SCOOP_GLOBAL.trim().length > 0
            ? [join(env.SCOOP_GLOBAL.trim(), 'apps', 'chromium', 'current', 'chrome.exe')]
            : []),
        // ② scoop 默认根目录（`~/scoop`）。实测可用。
        join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'),
        // ③ 系统 Chrome。
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        // ④ Chromium。
        join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
        join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
        // ⑤ Edge（Chromium 内核，系统普遍自带）。
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
}
/**
 * macOS 候选链：每个浏览器先找 `/Applications`，再找 `~/Applications`
 * （Mac 上把 app 拖进「应用程序」文件夹会装到后者，而**两者都是常规位置**）。
 *
 * ⚠⚠ **必须用 `posix.join`，不能用 `join`**（真实缺陷，2026-10-03，Gitee issue IKJKNT）。
 *
 * `join` 按**宿主**平台选分隔符：本仓库的 CI 与绝大多数开发机是 Windows，
 * 在那里执行本函数会拼出 `/Applications\Google Chrome.app\Contents\MacOS\…`
 * —— 在真机 macOS 上完全正常（那里 `join` 就是 `posix.join`），
 * 但这意味着**整条 darwin 分支在 Windows 上不可测、CI 永远测不到**。
 * 显式 `posix.join` 与 mac 上的行为逐字一致，同时让本分支可被单测锁死。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts` 的「一个反斜杠都没有」。
 */
function macBrowserCandidates(home) {
    const roots = ['/Applications', posix.join(home, 'Applications')];
    const candidates = [];
    for (const [bundle, exe] of MAC_BROWSER_BUNDLES) {
        for (const root of roots) {
            candidates.push(posix.join(root, bundle, 'Contents', 'MacOS', exe));
        }
    }
    return candidates;
}
/**
 * Linux 候选链。
 *
 * ## ⚠️ 签名里**刻意没有 `env`** —— 这是对报障人建议的一处**结构性**修正
 *
 * Gitee issue IKJKNT 的报障人在评论里给了实现建议，其中写了
 * `const env = process.env` —— 那会让函数**忽略注入的 `env`**，
 * linux 分支在 Windows CI 上就不可测、永远静默通过。
 * 那正是 {@link macBrowserCandidates} 存在的同一条理由（只是它用 `posix.join` 躲掉了）。
 * 这里**连参数都不给** ⇒ 结构上不可能误读进程环境。
 *
 * ⚠️ **`ZCODE_CHROME_PATH` 本函数不得处理**：{@link browserCandidates} 已统一
 * `unshift`，平台分支再处理一次会出现重复候选。
 *
 * ## ⚠️ flatpak 只能用 `exports/bin/`，**不是 `appstream/`**
 *
 * 报障人建议里写的是 `…/flatpak/appstream/org.chromium.Chromium` —— 那是
 * **AppStream 元数据目录**，不是可执行文件。而 {@link findBrowserExecutable}
 * 的判据只有 `existsSync`（**不做「能不能执行」**），列了它就会
 * 「探测成功 → spawn 时 EACCES」，**比不列更糟**。
 * 反例锁在 `tests/unit/zcode-browser-linux.spec.ts`。
 */
function linuxBrowserCandidates(home) {
    return [
        // ① Chrome（`google-chrome` 与 `google-chrome-stable` 是两个包名）。
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
        // ② Chromium（Debian/Ubuntu 的 `chromium`、`chromium-browser`；snap 版）。
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        // ③ Edge（微软的 Linux 包）。
        '/usr/bin/microsoft-edge',
        // ④ Brave（chromium 内核）。
        '/usr/bin/brave-browser',
        // ⑤ flatpak 导出的**可执行文件**（见函数头关于 appstream 的警告）。
        posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.chromium.Chromium'),
    ];
}
/**
 * 浏览器可执行文件的**候选链**（按优先级，`ZCODE_CHROME_PATH` 恒排第一）。
 *
 * ## 为什么抽成**纯函数**
 *
 * 候选链按平台分叉后，**macOS / Linux 分支在本仓库的 Windows CI 上一次都执行不到** ——
 * 直接写在 `findBrowserExecutable()` 里，这些路径会永远「静默通过」，
 * 直到用户报障（IKJKNT 就是 macOS 那条的先例）。
 * 抽出来后它们是纯字符串计算，可在任何平台断言。
 *
 * 三个入参都可注入，正是为了这个：`platform` 定分支、`env` 造 scoop /
 * `ZCODE_CHROME_PATH`、`home` 造 `~/Applications` 与 `~/.local/share/flatpak`。
 *
 * ## ⚠⚠ **`else` 分支是 Windows —— 别把它当「非 Win 也走这儿」
 *
 * 三个平台的分支必须**显式**列全。历史上 `linux` 落在 else 里拼出一套
 * `PROGRAMFILES` / `msedge.exe`（Linux 上全不存在 ⇒ 恒找不到浏览器），
 * 与 macOS 那条**完全同型**。**新增平台时务必在这里加一条显式分支。**
 *
 * ## ⚠ 两个必须防的坑（都实测踩过）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', …)` 返回 `Google\Chrome\…` —— 一个**相对路径**，
 * `existsSync` 会相对**当前工作目录**解析。于是「当前目录下恰好有个同名文件」
 * 会被误判成浏览器，而真正的浏览器却找不到。
 *
 * ⇒ {@link findBrowserExecutable} 只接受**绝对路径**候选（`isAbsolute` 过滤）。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 的安装位置在 `~/.scoop` 或 `~/scoop` 下，而 `~` 应当用
 * `os.homedir()` 求（它还会看 `HOME`，且在 `USERPROFILE` 被改写时仍正确）。
 * 用 `process.env.USERPROFILE` 拼路径会在「环境变量异常/被沙箱改写」时失效 ——
 * 实测：把 `USERPROFILE` 指到沙箱后，原本可用的 scoop chromium 就找不到了。
 */
export function browserCandidates(input = {}) {
    const platform = input.platform ?? process.platform;
    const env = input.env ?? process.env;
    const home = input.home ?? homedir();
    let candidates;
    if (platform === 'darwin') {
        candidates = macBrowserCandidates(home);
    }
    else if (platform === 'linux') {
        candidates = linuxBrowserCandidates(home);
    }
    else {
        candidates = windowsBrowserCandidates(env, home);
    }
    const override = env.ZCODE_CHROME_PATH;
    if (typeof override === 'string' && override.trim().length > 0) {
        candidates.unshift(override.trim());
    }
    return candidates;
}
/** 在候选链里挑第一个**存在**的绝对路径。 */
export function findBrowserExecutable() {
    for (const candidate of browserCandidates()) {
        try {
            /**
             * ⚠ 只接受**绝对路径**：空环境变量产生的相对路径会相对 CWD 解析，
             * 可能误匹配同名本地文件（见 {@link browserCandidates} 的坑 1）。
             */
            if (candidate.length === 0 || !isAbsolute(candidate))
                continue;
            if (existsSync(candidate))
                return candidate;
        }
        catch {
            // 试下一个。
        }
    }
    return undefined;
}
/**
 * 找不到浏览器时的**用户可执行提示**（按平台说人话）。
 *
 * ## 为什么必须分平台（Gitee issue IKJKNT）
 *
 * 修复前是单一口径：「已尝试 scoop chromium / Chrome / Chromium / Edge；
 * 可用 ZCODE_CHROME_PATH 显式指定 **chrome.exe** 路径。」
 * —— macOS 上 **scoop 根本不存在**、`chrome.exe` 也不是那个文件名
 * （见 {@link MAC_BROWSER_BUNDLES}），用户照着提示做只会更懵。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts`。
 *
 * ⚠ 第二个参数（环境变量名）是抽到共享模块时加的，**默认值保持 zcode 的
 * 原样文案**；库库AI 传自己的变量名，用户看到的出路才不会指错。
 */
export function browserNotFoundMessage(platform = process.platform, overrideEnvName = 'ZCODE_CHROME_PATH') {
    if (platform === 'darwin') {
        return '已尝试 /Applications 与 ~/Applications 下的 Google Chrome / Chromium / Microsoft Edge / Brave；' +
            `可用 ${overrideEnvName} 显式指定可执行文件路径` +
            '（如 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome）。';
    }
    if (platform === 'win32') {
        return '已尝试 scoop chromium / Chrome / Chromium / Edge；' +
            `可用 ${overrideEnvName} 显式指定 chrome.exe 路径。`;
    }
    if (platform === 'linux') {
        return '已尝试 /usr/bin 下的 google-chrome / chromium / microsoft-edge / brave-browser' +
            '（含 /opt/google/chrome、/snap/bin 与 flatpak 导出位置）；' +
            `可用 ${overrideEnvName} 显式指定可执行文件路径（如 /usr/bin/chromium）。`;
    }
    return '已尝试 Chrome / Chromium / Edge 的常见安装位置；' +
        `可用 ${overrideEnvName} 显式指定可执行文件路径。`;
}
/**
 * 该可执行文件是否是**系统 Edge**（候选链的最后几档）。
 *
 * ## 为什么单独抽成纯函数
 * 「实际用了哪个浏览器」需要被**告警**（issue IKJLB1 的期望行为 2：
 * 用户不知道系统在拿 Edge 兜底）。告警条件必须可测，故不留在启动流程里。
 *
 * ⚠️ 判据是**文件名**（不区分大小写），而不是路径里搜 `Edge`：
 * 前者对 `…\Microsoft\Edge\Application\msedge.exe`、scoop 布局、
 * macOS 的 `…/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` 以及
 * 用户经 `ZCODE_CHROME_PATH` 指向的 Edge 副本都成立；
 * 后者会把路径中恰好含 "Edge" 字样的第三方 chromium 误报成系统 Edge。
 *
 * ⚠⚠ **macOS 那个名字是同型缺陷的修复**（2026-10-03，issue IKJKNT）：
 * 原判据只认 `msedge.exe`，而 macOS 包内二进制叫 **`Microsoft Edge`**
 * （无扩展名）⇒ Mac 用户落到 Edge 兜底时**一声不吭**，与 IKJLB1
 * 的期望行为 2 直接冲突。补这个别名时别把判据改成 `includes('edge')`
 * —— 那会把 `Brave Browser` 之类的路径误伤。
 */
export function isEdgeExecutable(executable) {
    const name = basename(executable).toLowerCase();
    return name === 'msedge.exe' || name === 'microsoft edge';
}
/** 尽力删除临时目录（失败无妨，系统会回收临时目录）。 */
function safeRemoveDir(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch { /* 忽略 */ }
}
/**
 * 把窗口从**任务栏**移除（按平台分派；整体失败静默）。
 *
 * ## 为什么需要（用户报障，2026-09-29）
 *
 * > captcha 的 chromium 每次刷新页面完成都会在任务栏**闪烁提示**；
 * > 任务栏自动隐藏时会不停浮出，挡住屏幕最下面一排。
 *
 * 根因（Win32 实测）：主窗口缺 `WS_EX_TOOLWINDOW`（`0x80`），
 * 而 `--window-position=-32000,-32000`（移出屏幕）**不足以**让它不进任务栏 ——
 * 页面一渲染就获得任务栏按钮，有按钮就有东西可闪。
 *
 * ## 实测取证（Windows，13 个窗口）
 *
 * | 项 | 结果 |
 * |---|---|
 * | 打上后 `inTaskbar` | 13 个窗口**全部 false** |
 * | 连续 3 次 mint 后样式是否被重置 | **全部保持**（不会被 chromium 重置） |
 * | 对 captcha 功能的影响 | mint 仍成功（1802~1950ms） |
 * | 成本 | 约 1.2 秒（**这是这一步 PowerShell 自身的耗时，不是 mint 的耗时**）；**只需在启动时做一次**，可与约 3.7 秒的启动并行 ⇒ 几乎免费 |
 *
 * ⚠ **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。
 * 借外部工具都有失败可能（策略限制/无权限/未安装），此时最坏结果是回到
 * 修复前的行为（窗口在任务栏），**绝不能让 captcha 因此不可用**。
 *
 * ⚠ 调用**时机**由 {@link ChromiumSession} 保证：必须在页面渲染**之前**
 * （否则窗口已获得任务栏按钮）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选）。macOS 藏窗失败时用它告警一次，原因见
 *   {@link hideWindowMacos}：失败被静默吞掉，用户报「窗口还是弹出来」时
 *   没有这条日志就只能猜。
 */
export function hideWindowFromTaskbar(pid, log) {
    try {
        if (process.platform === 'win32')
            hideWindowWindows(pid);
        else if (process.platform === 'linux')
            hideWindowLinux(pid);
        else if (process.platform === 'darwin')
            hideWindowMacos(pid, log);
    }
    catch {
        // 静默：优化失败不影响 captcha。
    }
}
/**
 * Windows：直接改窗口的**扩展样式**。
 *
 * 见 {@link hideWindowFromTaskbar} 的取证表（`WS_EX_TOOLWINDOW` 一出，
 * 窗口即不在任务栏）。
 *
 * ⚠ 用 **`powershell.exe`**（Windows 5.1，系统自带）而不是 `pwsh` ——
 * 后者是可选安装，不能假设存在。实测本机 5.1 存在且 `Add-Type` 可用。
 */
function hideWindowWindows(pid) {
    let dirCreated;
    try {
        /**
         * 脚本**纯 ASCII**（无中文注释）—— PS 5.1 对无 BOM 的 UTF-8 会按 ANSI
         * 解读，含中文的脚本会损坏（实测过）。
         *
         * ⚠ 关键设计：**回读校验 + before 为 0 时跳过**。
         * 内联版失败时的特征是「读到的 `exStyle` 恒为 0」，而脚本仍把样式
         * 写成 0（可能破坏窗口）。这里明确要求 before 非 0 才写。
         */
        const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ZcodeWinStyle {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  public static List<IntPtr> All() {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$EX = -20
$TOOL = 0x80
$APP = 0x40000
$NOACT = 0x8000000
$target = ${String(pid)}
$n = 0
$all = @([ZcodeWinStyle]::All())
if ($all.Count -eq 0) { Write-Output 'enum-empty'; exit 0 }
foreach ($h in $all) {
  $wp = 0
  [void][ZcodeWinStyle]::GetWindowThreadProcessId($h, [ref]$wp)
  if ([int]$wp -ne $target) { continue }
  $before = [int64][ZcodeWinStyle]::GetWindowLongPtr($h, $EX)
  if ($before -eq 0) { continue }
  $new = (($before -bor $TOOL -bor $NOACT) -band (-bnot $APP))
  [void][ZcodeWinStyle]::SetWindowLongPtr($h, $EX, [IntPtr]$new)
  $n++
}
Write-Output "hidden=$n"
`;
        const dir = mkdtempSync(join(tmpdir(), 'zcode-hide-'));
        const file = join(dir, 'hide.ps1');
        dirCreated = dir;
        writeFileSync(file, script, 'ascii');
        /**
         * ⚠ 用 `-File`（**不是** `-Command`）—— 内联版实测无效且会清坏样式。
         * `stdio: 'ignore'`：装饰路径不该因沙箱下的 stdio EPERM 而失败。
         *
         * ⚠ 闭包里用 `file`（局部 const）而不是可变的 let：后者在回调里会
         * **丢失类型收窄**（TS 报 undefined 不可赋值）。
         */
        const child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', file,
        ], { stdio: 'ignore', windowsHide: true });
        child.on('exit', () => { safeRemoveDir(dir); });
        child.on('error', () => { safeRemoveDir(dir); });
    }
    catch {
        if (dirCreated !== undefined)
            safeRemoveDir(dirCreated);
    }
}
/**
 * Linux（X11）：用 **EWMH** 标准机制把窗口从任务栏移除。
 *
 * ## ⚠⚠ 与 Windows 的**本质差异**（先读这段）
 *
 * | | Windows | Linux（X11） |
 * |---|---|---|
 * | 机制 | 窗口**属性**（`SetWindowLongPtr`） | **WM 协议**（EWMH 客户端消息） |
 * | 生效条件 | 立刻生效，不需 WM 配合 | **需 WM 支持 `_NET_WM_STATE_SKIP_TASKBAR`** |
 * | 依赖 | 系统自带 `powershell.exe` | **外部工具 `wmctrl`**（非自带，可能没装） |
 * | Wayland | 不适用 | **完全无效**（无 X11 访问权） |
 *
 * ⇒ **本路径是「尽力而为」**：装了就生效，没装就静默跳过（回到修复前行为）。
 * **不引入 npm 依赖**去直接发 X11 协议（那要动 X11 连接层，风险与体积都不划算）。
 *
 * ## 为什么用 `wmctrl` 而不是 `xdotool`
 *
 * `xdotool` 的 `windowstate` 只支持 `add/remove` 少数几项，**不含
 * `SKIP_TASKBAR`**；而 `wmctrl -r <win> -b add,skip_taskbar` 正是干这个的。
 * 故主选 `wmctrl`，`xdotool` 仅用于**按 pid 找窗口 id**（若 `wmctrl` 的
 * `-lp` 不够用时作为补充）。
 *
 * ## ⚠ 未在本机实测（如实标注）
 *
 * 开发机是 Windows，且 WSL 实例损坏、无 X11 工具 —— **无法真机验证 Linux 行为**。
 * 故：
 *   - 命令构造抽成纯函数 {@link buildLinuxSkipTaskbarArgs} 并**单测锁死**
 *   - 失败路径**完全静默**（最坏回到修复前）
 *   - 这里只依赖 `wmctrl` 的**文档化语义**，不做任何"猜测式"的额外调用
 */
function hideWindowLinux(pid) {
    /**
     * ⚠ `wmctrl -lp` 列出所有窗口，格式（文档）：
     * ```
     * 0x0320000a  0 12345  hostname  Window Title
     * ```
     * 第 1 列是窗口 id、**第 3 列是 pid** —— 据此筛出我们自己的窗口。
     *
     * 用 `-r <id> -b add,skip_taskbar` 逐个设置。
     * `-i` 表示按**窗口 id**（而不是标题）匹配（标题可能含特殊字符）。
     *
     * 为什么不写 shell 脚本（与 Windows 侧对称）：Linux 侧没有「内联脚本
     * 被转义破坏」那类问题（`spawn` 不经 shell），但**需要解析 `-lp` 输出**
     * 才能按 pid 过滤 —— 那段解析逻辑放在 JS 里更好测（见 `parseWmctrlList`）。
     *
     * ⚠ 不检查 `wmctrl` 是否存在：`spawn` 失败会走 `error` 事件（静默处理），
     * 比预先 `which` 探测更简单且无竞态。
     */
    const list = spawn('wmctrl', ['-lp'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    list.stdout?.on('data', (c) => chunks.push(c));
    list.on('error', () => { });
    list.on('exit', () => {
        try {
            const ids = parseWmctrlList(Buffer.concat(chunks).toString('utf8'), pid);
            for (const id of ids) {
                const child = spawn('wmctrl', buildLinuxSkipTaskbarArgs(id), {
                    stdio: 'ignore',
                    windowsHide: true,
                });
                child.on('error', () => { });
            }
        }
        catch {
            // 静默：优化失败不影响 captcha。
        }
    });
}
/**
 * macOS：把该 pid 的 chrome 窗口**最小化**（`set miniaturized of every window to true`）。
 *
 * ## 为什么是最小化（而非 osascript 移屏 / 1x1）
 *
 * 真机（macOS，主屏 0,0 1470×956）对 4 种藏法逐一验证了「窗口是否仍挂在
 * 屏幕可见区」与「captcha 是否仍能 mint」：
 *
 * | 藏法 | 命令 | captcha 实测 |
 * |---|---|---|
 * | 最小化 | `set miniaturized … to true` | **稳**（10/10 mint OK，paramLen 280） |
 * | 移到 -32000 | `set position … to {-32000,-32000}` | **偶发 `F001`**（窗口离屏时 SDK 取证帧偶尔拿到空 canvas） |
 * | 1×1 缩到角 | `set size … to {2,2}` | 偶发 F001（同上，渲染尺寸过小触发 SDK 重试） |
 * | `--headless=new` | （启动参数） | 一律 `F001`，**不可用** |
 *
 * 结论：macOS 上**最小化是唯一同时满足「不挡屏幕」与「mint 稳定」**的做法。
 * 最小化后窗口缩到屏幕右下角（Dock 区），肉眼几乎不可见，且不破坏 captcha。
 *
 * ## 为什么不用 osascript `set position`（移屏）
 *
 * `--window-position=-32000,-32000` 已经传给了 chromium，但
 * **macOS 的 WindowServer 会把离屏窗口钳回屏幕内**（与 `--headless` 相反，
 * 这是系统行为，不是 chromium 行为）。所以「移屏」这条在 macOS 上等于没移。
 * 最小化则不受该钳制影响（窗口仍在屏幕坐标系内，只是缩到角上）。
 *
 * ## ⚠⚠ 依赖：宿主必须已授予 macOS「辅助功能」权限（与 Linux 的 wmctrl 不同）
 *
 * | | Linux | macOS |
 * |---|---|---|
 * | 机制 | WM 协议（EWMH 客户端消息） | `osascript` 驱动 System Events 的 UI 脚本 |
 * | 依赖 | 外部工具 `wmctrl` | 系统自带 `osascript`，**但 UI 脚本需宿主被授予「辅助功能」权限** |
 * | 缺了怎么办 | `apt install wmctrl`，一条命令 | 系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主，**通常还要重启应用** |
 * | 用户知道吗 | 报错会说「没装 wmctrl」 | **大多数人不知道这个权限存在**，且授权可能随应用升级被重置 |
 *
 * ⇒ 未授权时 `osascript` 非零退出，被本函数的静默语义吞掉，**窗口照常弹出**。
 * 这是「减少打扰」的优化失效，不是功能故障；用户报「窗口还是弹出来」时先查这一项。
 *
 * ## 接入与失败语义（与 Windows/Linux 侧对称）
 *
 * - **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。`spawn` 的
 *   `error`/非零退出都直接吞掉，最坏结果回到修复前的行为（窗口正常弹出），
 *   **绝不能让 captcha 因此不可用**。
 * - 与 Windows 侧一样用 `windowsHide: true` + `stdio: 'ignore'` 异步 fire-and-forget。
 * - **只按 pid 匹配**（`unix id`），刻意没有「按进程名兜底」—— 理由与代价见
 *   {@link hideWindowMacos} 的函数头。
 * - ⚠ 本函数是**唯一**拼 AppleScript 的地方，且**只插值一个整数**：
 *   没有字符串插值 ⇒ 没有引号/反斜杠转义问题（初版的进程名兜底栽在这里）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @returns `osascript` 参数数组（`-e <script>`），纯函数便于单测锁死。
 */
export function buildMacosMiniaturizeArgs(pid) {
    // AppleScript：遍历该 pid 名下所有窗口并最小化。
    // `System Events` 需要 `process` 句柄，`pid` 用 `unix id` 精确匹配。
    const appleScript = `tell application "System Events" to set miniaturized of every window of ` +
        `(first process whose unix id is ${pid}) to true`;
    return ['-e', appleScript];
}
/**
 * 对 macOS 该 pid 的窗口执行最小化（异步、失败静默）。
 *
 * ## ⚠⚠ 刻意**没有**「按进程名兜底」——那会最小化用户自己的浏览器
 *
 * 初版在 pid 匹配非零退出后，用 `first process whose name is "Google Chrome"`
 * 再试一次。**已删除**，两个原因：
 *
 * ① **会误伤用户真实浏览器**：`whose name is` 匹配**任意**同名进程，不是「我们
 *    那个」。用户在用 Chrome 时兜底一旦触发，其全部真实窗口被最小化。
 *    ⚠ 而触发条件比想象中宽：本函数以「osascript 非零退出」触发兜底，
 *    `stdio: 'ignore'` 又丢掉 stderr ⇒ **分不清「pid 落空」与「辅助功能未授权
 *    （-1719）」**。后者才是更常见的失败原因（真机第一轮实测就撞到过）。
 * ② **字符串插值未转义**：`"${exeName}"` 里若进程名含 `"`，字面量会被撑开
 *    （实测 `evil".do shell script "id` → `… whose name is "evil".do shell
 *    script "id") to true`）。删掉兜底后**不再有任何字符串插值进
 *    AppleScript**，注入面随之一并消失。
 *
 * ⇒ pid 落空就**什么都不做**：窗口短暂可见，正是**修复前**的行为。代价是
 * Chrome re-exec 换 pid 时最小化失效 —— 那是「少一个优化」，不是功能回退。
 * 拿「少隐藏一次」换「绝不最小化用户自己的浏览器」，这笔账划算。
 *
 * 契约锁在 `tests/unit/zcode-window-hide-macos-review.spec.ts`。
 *
 * 一次性告警闸门：同一进程里只提醒一次，避免每次启动刷屏。
 */
let macosHideWarned = false;
/**
 * macOS 藏窗失败时告警一次。
 *
 * ⚠ 只说「可能的原因」而不下断言：`stdio: 'ignore'` 丢掉了 stderr，
 * 区分不出「pid 落空」与「辅助功能未授权（-1719）」，而后者更常见。
 *
 * ⚠ 文案**刻意不写产品名**：本模块是两个 provider 共享的，写死任一家
 * 都会在另一家的日志里说谎。产品身份由调用方的 `log` 回调归属。
 */
function warnMacosHideOnce(log, reason) {
    if (log === undefined || macosHideWarned)
        return;
    macosHideWarned = true;
    log(`[jet-hub] macOS 藏窗未生效（${reason}）—— 窗口会照常弹出，但不影响 captcha。` +
        '最常见原因是宿主未获 macOS「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主（通常需重启应用）。');
}
/**
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选），见 {@link hideWindowFromTaskbar}。
 */
function hideWindowMacos(pid, log) {
    const child = spawn('osascript', buildMacosMiniaturizeArgs(pid), {
        stdio: 'ignore',
        windowsHide: true,
    });
    child.on('error', () => { warnMacosHideOnce(log, 'osascript 不可用'); });
    // 非零退出同样静默继续（不重试，见函数头 ①），但留一条告警。
    child.on('close', (code) => {
        if (code !== 0)
            warnMacosHideOnce(log, `osascript 退出码 ${code}`);
    });
}
/**
 * 构造「把窗口加入 `_NET_WM_STATE_SKIP_TASKBAR`」的 `wmctrl` 参数。
 *
 * ⚠ `-i` 必带：让 `-r` 按**窗口 id** 匹配（`0x...`），而不是按标题 ——
 * 标题里有空格/括号（chromium 的标题是「新标签页 - Chromium」）会被误解析。
 *
 * ⚠ **只加 `skip_taskbar`，不加 `skip_pager`**：前者即「不出现在任务栏」
 * （这正是要的）。`skip_pager` 是「不出现在工作区切换器」，与本次目的无关，
 * 多加会改变用户对窗口的既有预期（用户没要求隐藏工作区条目）。
 *
 * ⚠ 也**不**用 `-b add,hidden`（最小化）：chromium 已经用
 * `--window-position=-32000,-32000` 移出屏幕，再改最小化状态会与
 * captcha 流程的窗口假设冲突（那些流程依赖窗口"存在且可渲染"）。
 */
export function buildLinuxSkipTaskbarArgs(windowId) {
    return ['-i', '-r', windowId, '-b', 'add,skip_taskbar'];
}
/**
 * 从 `wmctrl -lp` 的输出里筛出**属于指定 pid** 的窗口 id。
 *
 * 输出格式（每行，字段以空白分隔）：
 * ```
 * 0x0320000a  0 12345  hostname  Window Title
 * └─ 窗口 id  │  └─ pid
 *            └─ 桌面号
 * ```
 *
 * ⚠ **标题可能含任意空白**，故只能按「前 4 个字段」切分，**不能**整体
 * `split(/\s+/)` 后取全部 —— 那样标题会被拆散（对本用途无害，但会让人
 * 误以为解析"完全正确"）。
 *
 * ⚠ 只取**前 4 个字段**：第 4 列（hostname）之后全是标题。
 * 用 `split(/\s+/, 5)`（限 5 段）恰好把标题保留为最后一段。
 *
 * @returns 属于该 pid 的窗口 id（形如 `0x0320000a`）；解析不到就返回空数组。
 */
export function parseWmctrlList(output, pid) {
    const ids = [];
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '')
            continue;
        // 限 5 段：id / desktop / pid / host / 其余（标题）
        const fields = line.split(/\s+/, 5);
        if (fields.length < 3)
            continue;
        const id = fields[0] ?? '';
        // 窗口 id 必须是 0x 开头的十六进制（防把标题行当数据行）
        if (!/^0x[0-9a-f]+$/i.test(id))
            continue;
        const linePid = Number(fields[2]);
        if (!Number.isInteger(linePid) || linePid !== pid)
            continue;
        ids.push(id);
    }
    return ids;
}
/** 极简 CDP 客户端（用 Node 内置 WebSocket，**零第三方依赖**）。 */
export class CdpConnection {
    ws;
    nextId = 0;
    pending = new Map();
    constructor(ws) {
        this.ws = ws;
        ws.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                return;
            }
            if (message.id === undefined)
                return;
            const slot = this.pending.get(message.id);
            if (slot === undefined)
                return;
            this.pending.delete(message.id);
            if (message.error !== undefined)
                slot.reject(new Error(JSON.stringify(message.error)));
            else
                slot.resolve(message.result);
        });
    }
    /**
     * 发送一条 CDP 命令并等结果。
     *
     * ⚠️ **`sessionId` 是给页面级命令用的**（2026-10-08 实测踩到）：
     * 浏览器级端点只认 `Target.*` / `Storage.*` / `Browser.*` 这类命令；
     * 一旦用 `Target.attachToTarget { flatten: true }` 拿到 `sessionId`，
     * **此后每条页面级命令都必须带上它**，否则命令落在**浏览器端点**上，
     * 回报的是一句含糊的 `-32601 'XXX' wasn't found`
     * —— 看起来像「API 不存在」，实际是「你没说要发给哪个页面」。
     *
     * ⚠️ 同一条实测还纠正了两个流传的说法：**浏览器级没有**
     * `Network.getAllCookies`，也**没有**浏览器级 `Network.getCookies`
     * （都回 `-32601`）。要读 cookie，浏览器级的唯一可用命令是
     * `Storage.getCookies`，且**不需要 `sessionId`**。
     */
    send(method, params = {}, timeoutMs = 30_000, sessionId) {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
                }
            }, timeoutMs);
            timer.unref?.();
        });
    }
    close() {
        try {
            this.ws.close();
        }
        catch {
            // 已关闭。
        }
    }
}
/** 可被 `unref` 的 sleep（生产由 HTTP server 撑着 event loop）。 */
export const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
});
/**
 * 挑一个**确实空闲**的调试端口。
 *
 * ⚠ 为什么不能随机取（见 {@link ChromiumSession} 启动流程里端口处的完整缺陷链）：
 * 随机撞上「尚未退干净的旧实例」会让新实例启动失败、而我们连到旧实例上，
 * 最终形成「dispose 打空 + 真实例整棵树泄漏」（实测 10~14 个进程）。
 *
 * ⚠ 探测与真正启动之间仍有理论竞态，故启动流程里还有第二道
 * 「应答端口是否一致」的校验。
 */
async function pickFreePort() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const candidate = 9300 + Math.floor(Math.random() * 500);
        if (await isPortFree(candidate))
            return candidate;
    }
    // 兜底：极端情况下退回随机（后续的端口校验会把问题暴露成明确报错）。
    return 9300 + Math.floor(Math.random() * 500);
}
/** 试占一个端口判断是否空闲（能绑上就算空闲）。 */
function isPortFree(port) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        // 只绑回环：chromium 的调试端口也在回环上。
        try {
            server.listen(port, '127.0.0.1');
        }
        catch {
            resolve(false);
        }
    });
}
/**
 * 一个常驻的 chromium 会话：进程 + 调试端口 + CDP 通道。
 *
 * 生命周期：`start()` → 用 `cdp.send(…)` → `kill()`（只杀进程树 + 关通道）
 * 或 `dispose()`（再删临时 profile）。
 *
 * ⚠️ **`dispose()` 必须被调用**，否则会留下一个孤儿 chromium
 * （约 200-400MB）；`kill()` 与 `dispose()` 的分工见各自注释。
 */
export class ChromiumSession {
    options;
    child;
    ws;
    /**
     * 浏览器级 CDP 通道。
     *
     * ⚠️ 是**公开可写字段**（不是私有 + getter）：既有回归用例直接注入桩
     * （`tests/unit/zcode-page-prepared.spec.ts`），换成访问器会改变它们的写法。
     */
    cdp;
    profileDir;
    port = 0;
    starting;
    /**
     * 浏览器**起不来 / 自己没了**的可读原因（由启动流程里的
     * `'error'` / `'exit'` 监听写入，见该处注释）。
     *
     * `undefined` = 一切正常。轮询循环每轮检查它，命中即立刻失败 ——
     * 否则「浏览器秒退」要白等满 `readyTimeoutMs`（默认 30 秒）才报错。
     */
    spawnFailure;
    log;
    constructor(options = {}) {
        this.options = options;
        this.log = options.log;
    }
    /** 浏览器是否已就绪。 */
    get ready() {
        return this.cdp !== undefined && this.ws?.readyState === 1;
    }
    /** 调试端口（诊断与 `/json/list` 用）。 */
    get debugPort() {
        return this.port;
    }
    /** 浏览器主进程 pid（清理与诊断用）。 */
    get pid() {
        return this.child?.pid;
    }
    /**
     * 浏览器级 WebSocket。
     *
     * ⚠️ 与 {@link cdp} 同理：公开可写，供既有用例注入桩。
     */
    get socket() {
        return this.ws;
    }
    set socket(value) {
        this.ws = value;
    }
    /** 启动（幂等：并发调用共享同一次启动）。 */
    async start() {
        if (this.ready)
            return;
        if (this.starting !== undefined) {
            await this.starting;
            return;
        }
        const task = this.launch().finally(() => {
            this.starting = undefined;
        });
        this.starting = task;
        await task;
    }
    async launch() {
        const label = this.options.label ?? 'browser';
        const envName = this.options.overrideEnvName ?? 'ZCODE_CHROME_PATH';
        const executable = this.options.executablePath ?? findBrowserExecutable();
        if (executable === undefined) {
            /**
             * ⚠ 文案按平台生成（2026-10-03，issue IKJKNT）：原先是单一口径
             * 「已尝试 scoop chromium / Chrome / Chromium / Edge；用 ZCODE_CHROME_PATH
             * 显式指定 chrome.exe 路径」—— 在 macOS 上 scoop 不存在、`chrome.exe`
             * 也不是那个文件名，Mac 用户照着做只会更懵。口径见 {@link browserNotFoundMessage}。
             */
            throw new Error(`${label}: 找不到可用的浏览器${this.options.notFoundHint ?? ''}。` +
                browserNotFoundMessage(process.platform, envName));
        }
        /**
         * ★ **Edge 兜底必须出声**（Gitee issue IKJLB1 的期望行为 2）。
         *
         * 候选链里 Edge 排最后（见 {@link findBrowserExecutable}），于是
         * **没装 Chrome/Chromium 的机器上它是唯一可选项** —— 而这是国内 Windows
         * 的常见状态。原先它被**静默**选中：用户既不知道用的是哪个浏览器，
         * 也不知道该去哪换，于是只能靠翻崩溃日志反推。
         *
         * ⚠️ 只在**确实落到 Edge** 时告警：装了 Chrome/Chromium 的用户不受打扰。
         * ⚠️ 判断用文件名（`msedge.exe`）而不是 `includes('Edge')` ——
         * 前者对路径里的 `Microsoft\Edge\` 与 scoop 布局都成立，且不会把
         * `ZCODE_CHROME_PATH` 指向的第三方 chromium 误报成 Edge。
         */
        if (isEdgeExecutable(executable)) {
            const edgeLabel = this.options.edgeLabel ?? label;
            this.log?.(`[jet-hub] ${edgeLabel} 未检测到 Chrome/Chromium，改用系统 Edge（msedge.exe）产出 —— ` +
                `若 Edge 异常导致 captcha 失败，可安装 Chrome/Chromium 或用 ${envName} 指定其它浏览器。`);
        }
        /**
         * 每次启动都是一次全新的尝试：上一次的失败原因必须清掉，
         * 否则上一轮「浏览器起不来」会让后续**所有**轮次秒失败。
         */
        this.spawnFailure = undefined;
        this.profileDir = mkdtempSync(join(tmpdir(), this.options.profilePrefix ?? 'chromium-session-'));
        /**
         * ★ **必须挑一个确实空闲的端口**（真实缺陷）。
         *
         * 早期是 `9300 + Math.floor(Math.random() * 500)` —— 纯随机、**不检查占用**。
         * 若撞上一个**尚未完全退出的旧实例**的端口，会串成一条隐蔽的失效链：
         *
         * 1. 新 chromium 因端口被占而启动失败（自行退出）
         * 2. 但 `fetch('/json/version')` **成功** —— 应答的是**旧实例**！
         * 3. 于是我们连上了旧浏览器，而 `this.child` 指向那个**已死**的新进程
         * 4. `dispose()` 的 `taskkill` 打在一个死 pid 上 → **毫无效果**
         * 5. 真正在跑的旧实例从此无人回收 ⇒ **整棵树泄漏**（实测 10~14 个进程）
         *
         * 实测证据：`dispose()` 立即接下一轮时**偶发**泄漏（随机端口才撞得上），
         * 而每轮间隔 2.5 秒时 5/5 干净 —— 正是「旧实例还没退干净」的特征。
         *
         * 故改为：在候选端口里**探测到空闲**的那个。
         */
        this.port = this.options.debugPort ?? await pickFreePort();
        const hide = this.options.hideWindow !== false;
        this.child = spawn(executable, [
            `--remote-debugging-port=${this.port}`,
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-features=Translate',
            '--lang=zh-CN',
            `--window-size=${this.options.windowSize ?? '1280,900'}`,
            /**
             * ⚠ **不用 `--headless=new`** —— 实测 headless 一律 `F001`，必须 headful。
             * 为了不打扰用户，把窗口移到屏幕外。
             *
             * ⚠ 移屏**不足以**让它不进任务栏（见 {@link hideWindowFromTaskbar}），
             * 故下面还有一步窗口样式/协议处理。
             */
            ...hide ? ['--window-position=-32000,-32000'] : [],
            ...this.options.initialUrl !== undefined ? [this.options.initialUrl] : [],
            ...this.options.extraArgs ?? [],
        ], {
            stdio: 'ignore',
            windowsHide: hide,
            /**
             * ⚠ POSIX 上必须 `detached: true`：这样 chromium 自成**进程组**，
             * `killProcessTree()` 才能用负 pid 一次杀掉全部子进程。
             * 不加的话子进程会脱离、变成孤儿（实测留下 12 个 chrome.exe）。
             *
             * ⚠ Windows 不用这个（它有 `taskkill /T`），且 `detached` 在 Windows
             * 上会额外开一个控制台窗口 —— 与「不打扰用户」冲突。
             */
            detached: process.platform !== 'win32',
        });
        /**
         * ★★ **必须监听 `error` 与 `exit`**（真实缺陷，2026-10-03，Gitee issue IKJLB1）
         *
         * ## 为什么这是**能杀掉整个宿主**的缺陷（不是「浏览器崩了」的泛泛之谈）
         *
         * `ChildProcess` 是 EventEmitter，而 **`'error'` 事件在没有监听器时会被
         * `throw` 成未捕获异常**。实测（`spawn` 一个不存在的绝对路径、且不注册
         * `error`）：
         *
         * ```
         * Error: spawn …\msedge.exe ENOENT
         *   throw er; // Unhandled 'error' event
         * → 进程立刻退出，exit code = 1
         * ```
         *
         * 插件是通过 `ctx.plugin()` 跑在 **dsh desktop host 进程内**的，而
         * `cordis` 没有装 `uncaughtException` / `unhandledRejection` 处理器 ⇒
         * 插件侧的未捕获异常会**直接终止 host**；Electron main 收到 `close`
         * 回调（`app.asar/lib/main.js` 打印 `dsh desktop host exited with …`）
         * 便弹出宿主级错误框。
         *
         * ⚠️ **触发条件是「起不来」而非「崩溃」**：`exit` 事件有监听器时不会抛，
         * 所以浏览器**运行中崩溃**只会被静默吞掉（实测：父进程存活、exit code 0）。
         * 真正致命的是 spawn 阶段的 `ENOENT` / `EACCES` / `EPERM` —— 也就是
         * 「候选链选中的那个 exe 存在但打不开」（权限、被占用、文件损坏、
         * Edge 正在自我更新等）。
         */
        const child = this.child;
        child.once('error', (error) => {
            /**
             * ⚠️ 存起来**而不是就地抛**：此刻启动流程还在下面的轮询循环里，
             * 直接抛会变成「循环外的 promise rejection」，而 `start()` 仍会等满
             * `readyTimeoutMs` 才返回。存下来让循环**下一轮立刻**失败（见下）。
             */
            this.spawnFailure = new Error(`${label}: 浏览器无法启动（${executable}）：${error.message}` +
                `。可安装 Chrome/Chromium，或用 ${envName} 指定其它 chromium 内核浏览器。`);
        });
        child.once('exit', (code, signal) => {
            /**
             * 判据是「`this.child` 还是不是它」——因为 `killProcessTree()` 会先把
             * `this.child` 置空，故**主动停机**（`dispose()` / 轮询超时 / 端口错配）
             * 走到这里时 `this.child !== child`，只有**浏览器自己没了**才等于。
             * ⇒ 不需要额外的 `stopping` 标志，也不会把正常清理误报成崩溃。
             */
            if (this.child !== child)
                return;
            this.child = undefined;
            const how = signal !== null && signal !== undefined
                ? `signal=${signal}`
                : `code=${String(code)}`;
            this.spawnFailure ??= new Error(`${label}: 浏览器进程异常退出（${executable}，${how}）` +
                `。请重试，或用 ${envName} 指定其它 chromium 内核浏览器。`);
        });
        const timeoutMs = this.options.readyTimeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        let debuggerUrl;
        while (Date.now() < deadline) {
            /**
             * ⚠️ **每轮先看 `spawnFailure`**：浏览器起不来 / 秒退时立刻失败，
             * 而不是白等满 `readyTimeoutMs`（默认 30 秒）才报一个含糊的「超时」。
             * 旧实现的用户体感就是「签到卡住半分钟然后失败」—— 根因就在这里。
             */
            if (this.spawnFailure !== undefined) {
                const failure = this.spawnFailure;
                this.kill();
                throw failure;
            }
            try {
                const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
                    signal: AbortSignal.timeout(2_000),
                });
                if (response.ok) {
                    const version = await response.json();
                    if (typeof version.webSocketDebuggerUrl === 'string') {
                        debuggerUrl = version.webSocketDebuggerUrl;
                        break;
                    }
                }
            }
            catch {
                // 还没起来。
            }
            await sleep(300);
        }
        if (debuggerUrl === undefined) {
            this.kill();
            /**
             * ⚠️ 走到这里若 `spawnFailure` 已就位，优先抛它 ——
             * 「浏览器起不来」比「端口没就绪」更贴近根因，用户才知道该换浏览器。
             */
            throw this.spawnFailure
                ?? new Error(`${label}: 浏览器调试端口未就绪（${timeoutMs}ms 超时）`);
        }
        /**
         * ★ **确认应答的确实是我们启动的那个浏览器**（防「连到旧实例」）。
         *
         * 端口已经挑空闲的了，这里是**第二道防线**：万一仍有竞态（别的进程
         * 在我们探测之后抢占了端口），`/json/version` 的 `webSocketDebuggerUrl`
         * 里的端口会暴露它。启动时 chromium 一定会占住我们给的端口，
         * 故再校验一次 `debuggerUrl` 里的端口号是否等于 `this.port`。
         *
         * ⚠ 不等就**抛错**而不是继续用 —— 继续用会导致「dispose 打空 + 真实例泄漏」
         * 那条隐蔽链（见上面端口选择处的说明）。
         */
        if (!debuggerUrl.includes(`:${this.port}/`)) {
            this.kill();
            throw new Error(`${label}: 调试端口 ${this.port} 应答的不是本实例（${debuggerUrl}）—— ` +
                '疑似端口被其它 chromium 占用，已放弃以避免泄漏');
        }
        const ws = new WebSocket(debuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error(`${label}: 连接浏览器调试端口失败`)), { once: true });
        });
        this.ws = ws;
        this.cdp = new CdpConnection(ws);
        /**
         * ★ **把窗口从任务栏移除**（Windows / Linux / macOS 各一条路）。
         *
         * ⚠ 时机是**唯一正确的那一个**：此刻窗口已存在、页面还没渲染。
         * 放到渲染之后，窗口已经获得任务栏按钮，就有东西可闪了（用户报障）。
         *
         * ⚠ 必须受 `hide` 门控：`hideWindow: false` 的语义是「别动我的窗口」
         * （库库AI 的登录要让用户看见并自己操作）。
         *
         * ⚠ 不 await：这是装饰性优化，失败要静默，不能拖慢启动。
         */
        if (hide && this.child?.pid !== undefined)
            hideWindowFromTaskbar(this.child.pid, this.log);
    }
    /**
     * 终止浏览器进程**树**并清理所有 CDP 连接（**保留**临时 profile）。
     *
     * ⚠ 与 {@link dispose} 的分工：`kill()` 用于「还要重来一次」的场景
     * （captcha 轮询超时后会重新 `start()`），故不能删 profile。
     *
     * ## ⚠ 为什么必须杀**整棵树**（真实缺陷）
     *
     * 早期只写 `child.kill()` —— 那只杀**主进程**。而 Chromium 是
     * **多进程架构**（browser / gpu / renderer / utility 各一个进程），
     * 主进程被 `SIGTERM` 后**子进程会变成孤儿继续运行**。
     *
     * 实测证据（一次被中断的测试后）：
     *   - **12 个** 残留 `chrome.exe` 全指向同一个 `--user-data-dir`
     *   - **28 个**残留的临时 profile 目录
     *
     * 生产影响：**每次会话泄漏约 200MB**（一个 Chromium 实例），
     * 且残留进程占着调试端口，会干扰后续启动（曾让一次 `max` 档位测试
     * 表现得像「卡住 80 秒」，实为旧实例干扰）。
     *
     * 修法：POSIX 用进程组（`detached: true` + `kill(-pid)`），
     * Windows 用 `taskkill /T /F`（`/T` = 含子进程树）。
     */
    kill() {
        try {
            this.cdp?.close();
        }
        catch { /* 已关闭 */ }
        try {
            this.ws?.close();
        }
        catch { /* 已关闭 */ }
        this.cdp = undefined;
        this.ws = undefined;
        this.killProcessTree();
    }
    /**
     * 终止浏览器及其**全部子进程**。
     *
     * ⚠ 不能退回成 `child.kill()`（见 {@link kill} 的说明：会留下孤儿）。
     *
     * ⚠⚠ **必须同步等它做完**（真实缺陷）：早期用异步 `spawn('taskkill', …)`
     * 后立即返回 —— 调用方以为清理完了、紧接着启动下一轮，而旧实例**还活着
     * 占着端口**。若下一轮随机撞到同一端口就会串成：
     * 连到旧实例 → `child` 指向已退出的新进程 → `dispose()` 打空 →
     * **旧实例整棵树泄漏**（实测 10~14 个进程）。
     *
     * 实测对照：`dispose()` 后**立即**下一轮会偶发泄漏；
     * 每轮间隔 2.5 秒则 5/5 干净 —— 正是「没等它退完」的特征。
     *
     * 故改用 `spawnSync`：清理路径阻塞几十毫秒是可接受的，
     * 换来确定性的「返回即已终止」。
     */
    killProcessTree() {
        const child = this.child;
        this.child = undefined;
        if (child === undefined || child.pid === undefined)
            return;
        const pid = child.pid;
        if (process.platform === 'win32') {
            /**
             * ⚠ Windows 没有进程组信号，用 `taskkill /T`（树）+ `/F`（强制）。
             * 必须 `stdio: 'ignore'`：某些沙箱下捕获子进程输出会 EPERM，
             * 而这是清理路径，不该因此失败。
             */
            try {
                spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
                    stdio: 'ignore',
                    windowsHide: true,
                    // 最多等 10 秒（正常几十毫秒；卡住说明系统异常，别无限等）。
                    timeout: 10_000,
                });
            }
            catch { /* 尽力而为 */ }
            // 兜底：万一 taskkill 不可用，至少杀掉主进程。
            try {
                child.kill();
            }
            catch { /* 已退出 */ }
            return;
        }
        /**
         * POSIX：`detached: true` 时子进程自成进程组，负 pid 即整组。
         * ⚠ 失败（ESRCH 等）就退回单进程 kill。
         */
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch {
            try {
                child.kill('SIGKILL');
            }
            catch { /* 已退出 */ }
        }
    }
    /**
     * 关闭浏览器并清理临时 profile。
     *
     * ⚠ 删除要**重试几次**：chromium 的子进程刚被 taskkill 掉，
     * 句柄释放有延迟 —— 一次性 `rmSync` 实测会留下 28 个残留目录。
     * 用退避重试（100/500/1500ms），全部失败就交给系统回收临时目录。
     */
    dispose() {
        this.kill();
        const dir = this.profileDir;
        this.profileDir = undefined;
        if (dir === undefined)
            return;
        const attempts = [0, 100, 500, 1_500];
        const tryRemove = (index) => {
            if (index >= attempts.length)
                return;
            const delay = attempts[index];
            const run = () => {
                try {
                    rmSync(dir, { recursive: true, force: true });
                }
                catch {
                    tryRemove(index + 1);
                }
            };
            if (delay === 0)
                run();
            else
                setTimeout(run, delay).unref?.();
        };
        tryRemove(0);
    }
}
//# sourceMappingURL=chromium-session.js.map