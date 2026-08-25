# 脚本式 DSH 修改审计与插件化改造记录（v4.10）

- 目标：**尽量减少用脚本直接修改 dsh 本体**；凡可由插件实现的功能改为独立内置插件，
  走官方 `dsh plugin --profile web add` / bundle patch 通道，避免 dsh 升级被补丁破坏。
- 方法：对 `stub-dsh.mjs` 的每一处补丁，下载 **pristine `0.1.1-rc.2` npm 原包**
  逐一 grep 锚点/常量，并核对运行时缝隙（settings 服务、client-modules、
  directory-picker browse 源码、HTML 引导时序），给出「保留 / 移除 / 插件化」三向结论。
- 结论速览：12 处补丁 → **1 处插件化**（新增 `dsh-android-links`）、
  **2 处死码移除**（apiproxy 白名单、sandbox "/tmp"）、
  **1 处改按需注入**（AbortSignal shim）、8 处保留并注明不可替代原因。

---

## 一、stub-dsh.mjs 补丁逐项判定

| # | 补丁对象 | 机制 | 判定 | 证据（对 pristine 0.1.1-rc.2） |
|---|---|---|---|---|
| 1 | koffi（ESM+CJS Proxy stub） | import 期模块顶替 | **保留** | Android 无预编译产物；Cordis 插件运行于加载完成之后，无法介入 import 解析 |
| 2 | node-pty stub | 同上 | **保留** | 同上；dsh PTY 会话在 Android 由启动器 Termux 终端承担 |
| 3 | sharp 纯 JS shim（PNG 全解码） | import 期模块顶替 | **保留** | libvips 二进制缺失；消费方 `dsh-attachment-local` 的 require 链路无插件缝隙 |
| 4 | attachment-local 视觉链路 v4（syncDirectory fsync 容错 + publishCopied link→copy 回退） | 改写包内源码 | **保留** | SELinux 禁 app uid link(2)、sdcard FUSE 不支持硬链接、FUSE 目录 fsync 失败——fs 兼容层（loader 级）不覆盖 CJS `require('fs/promises')` 与 `linkSync` 盲区，只能改源；锚点在 rc.2 原包均存在 |
| 5 | apiproxy `WEB_SETTINGS_NAMESPACES += "vision"` | 正则插桩 | **移除（死码）** | rc.2 原包已无该常量（grep=0），补丁恒命中 "pattern not found, skip"；`dsh-vision` 现经 `@deepseek-ai/dsh-settings` 的 `settingsNamespace('vision')` 直接注册命名空间 |
| 6 | llm-pi-ai sendAttribution（schema default + requestHeaders 分流） | 正则插桩 | **保留** | rc.2 原包无此字段且源码注释明示 *“omission cannot suppress attribution”*——归因 UA 大小写不敏感地覆盖用户 headers，唯一抑制通道就是该补丁；`dsh-provider-headers` 设置页的「发送归因请求头」开关依赖它。待上游提供官方抑制缝隙后删除 |
| 7 | sandbox-windows-acl STARTUPINFOW/PROCESS_INFORMATION 断言禁用 | 正则替换 | **保留（防御性）** | 断言存在于 rc.2 原包 `lib/types-*.js`；koffi 已被顶替，一旦上游自动选中 windows-acl 策略即崩，禁用成本≈0 |
| 8 | index.html AbortSignal.timeout polyfill | dist/index.html 注入 | **改为按需注入** | 全量扫描 rc.2 前端 dist 与全部 @deepseek-ai 包：**无任何浏览器侧消费者**（仅 host 侧 vision/super-injector 使用，Node 原生支持）；现仅在 assets 中检测到真实引用才注入（**递归扫描含子目录 chunk**，布局变化不丢消费者；误报无害——shim 自带 `if(!AbortSignal.timeout)` 守卫），资产目录不可读时保守回退注入。必须留在引导期脚本：polyfill 需先于 `/assets/index-*.js` 与 client-modules 条目执行，client 插件由模块系统在 app bundle 内引导，时序上不可能更早 |
| 9 | @vscode/ripgrep 解析器 Android 回退 | 重写解析器 | **保留** | 无 android-arm64 平台包；import 期 `require.resolve` 抛错导致 glob/grep 工具瘫痪；优先 Termux 原生 rg 属产品语义。（备选方案：alias 出 `@vscode/ripgrep-android-arm64` 侧门面包——会丢失 Termux rg 优先级，未采纳） |
| 10 | dsh-sandbox/-local `"/tmp"`→TMPDIR | 字符串全量替换 | **移除（已被上游覆盖）** | rc.2 `writableRoots()` 已原生并入 `os.tmpdir()`（Node 读 TMPDIR，启动器恒导出应用私有 tmp）；sandbox-local 的 `--tmpfs/readWrite` 分支依赖 bubblewrap，Android 上不可达。旧补丁在 rc.2 上零替换仍追加 marker 头，属纯文件污染 |
| 11 | dsh-fs-local chmod EACCES/EPERM 容错 | 三处调用点包裹 | **保留** | FUSE（/storage/emulated）不支持 chmod，原子写 staging 会 EACCES；三处锚点 rc.2 均存在；内部实现路径无插件缝隙 |
| 12 | directory-picker-browse "SD Card" 条目 | 源码插桩 | **插件化 → 移除** | browse `list()` **原生保留符号链接项**（`dirent.isDirectory() || dirent.isSymbolicLink()`）、`directoryRow()` 对链接 stat 跟随判定可进入，home 即 `os.homedir()`——只需在 HOME 放符号链接，零改动上游 |

## 二、新增独立内置插件：`@dsh-external/dsh-android-links`

- 位置：`app/src/main/assets/extra-plugins/dsh-android-links/`（package.json +
  cordis.patch.yml + lib/index.js + README.md，随 AssetSync 整目录同步，
  install-dsh.mjs 经 `dsh plugin --profile web add` 装配）。
- 行为：启动时在 dsh HOME 创建 `sdcard -> /storage/emulated/0` 符号链接
  （可用 `DSH_ANDROID_LINKS="name=target,..."` 自定义多条）。工作区目录浏览器的
  「添加工作区」即可直达共享存储。
- 安全约定：幂等；目标缺失/非目录跳过；同名位置被非链接占用**绝不覆盖**；
  卸载不回收链接（用户可见的文件系统便利设施，避免活动会话断链）。
- 真机验证：
  - 单测 5 例（创建/幂等/占用保护/目标缺失/spec 解析）全过；
  - dev_inject 注入 → `[active] (@dsh-external/dsh-android-links)`，
    `files/sdcard` 符号链接生成且可列目录；卸载后 loader entry / registry /
    junction 全部清理。

## 三、装配通道变更（install-dsh.mjs）

- `BUILTIN_PLUGINS` / `BUILTIN_NAMES` / `BUILTIN_IDS` 追加
  `dsh-android-links` / `@dsh-external/dsh-android-links`。
- `cleanBuiltinPatch()` 因此会在下次安装流中自动清掉历史遗留的
  `- id: dsh-android-links disabled: true` 之类 patch 行，不会与 bundle 装配冲突。

## 四、其他脚本层复核（无需改动）

| 脚本 | 判定 | 说明 |
|---|---|---|
| fs-register/loader/promises-compat | 保留 | Node `--import` 会话级兼容层（SELinux 禁硬链接），先于模块图构建，非插件通道可达；不改 dsh 文件 |
| routing-suite.mjs | 保留 | 第三方聚合仓库的一次性适配安装器，走官方 plugin add / agent-presets 拷贝 |
| tpkg.sh / web-launcher.sh.tpl / profile.d 生成物 | 保留 | Termux 环境 / 进程启动层，不触碰 dsh 本体 |
| install-dsh.mjs ensureRipgrepFallback | 保留 | 以 package.json dependency 声明方式装 linux-arm64 兜底（npm 官方语义，非源码改写） |

## 五、升级守护清单（后续 dsh 版本需复查的点）

1. attachment-local v4 与 fs-local chmod 的锚点是否漂移（补丁自带 node --check 防毒化）；
2. llm-pi-ai 是否提供官方归因抑制缝隙（有则删补丁 #6）；
3. 前端 dist 是否重新引入 `AbortSignal.timeout` 消费者（按需注入自动兜底，无需动作）;
4. `writableRoots()` 是否退回丢失 `os.tmpdir()`（若有变化恢复补丁 #10 并去掉 marker 头写入）；
5. browse 是否改变符号链接语义（若不再 stat 跟随，`dsh-android-links` 需同步调整）。

## 六、验证记录（2026-08-25，真机 v4.9 环境 @ dsh 0.1.1-rc.2）

- `node --check`：stub-dsh.mjs / install-dsh.mjs / 插件 lib 全过；
- pristine tarball grep：见上表证据列；
- HTML 引导时序：`<head>` 内为 module-loader shim → client-modules/client-runtime 预载
  → `__DSH_BOOT__` → （shim 位点）→ `<script type="module" src="/assets/index-*.js">`，
  证实 client 插件无法先于 app bundle 执行；
- 设备 WebView 为 Chromium 94，当前 rc.2 页面在**无 shim** 时亦正常（无消费者），
  与「按需注入」结论一致。
