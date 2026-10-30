# 证据汇总：modsearch / dsh-ego-browser 加入内置插件

## 1. 清单条目（app/src/main/assets/plugin-manifest.json，builtin 末尾两项）
dir=modsearch  name=@liustack/modsearch  id=modsearch  version=5.10.6
  upstream=https://github.com/liustack/modsearch
dir=dsh-ego-browser  name=dsh-ego-browser  id=ego-browser  version=0.8.6
  upstream=https://github.com/Fisfzy/dsh-ego-browser

## 2. 上游 tarball sha256（本地 vendor 副本 vs registry.npmmirror.com 重新下载）
modsearch: ca63139408202f6edbe46be5e6b8df3bc83e00cf9168c69369c12269623e07f1  (两处一致)
ego      : d7e8db48029a2bbba46683878a327cff83fdca1feea0dd41bf3c90179ebd813f  (两处一致)
diff -rq 解包后目录 vs assets 目录 → 无差异（整包同源，未改字节）

## 3. 兼容性判定（调用 dsh 自带的 evaluatePluginCompatibility，runtime=0.2.0-rc.2）
modsearch: 返回 undefined（该包无任何 @deepseek-ai/dsh* peerDependencies，判定不适用）
ego      : 返回 undefined（peer 均为 >=0.1.2-rc.1，0.2.0-rc.2 满足；均标 optional）
独立旁证：install/plugins.mjs 的 auditBuiltinCompatibility 落盘 plugin-status.json
  → 10 条全部 compatible:true，0 incompatible

## 4. 真机装配日志（install-dsh.mjs --plugins-only，完整一轮）
extra plugin modsearch synced: absent -> 5.10.6 (apk 300)
dsh plugin add modsearch  ... exit=0
extra plugin dsh-ego-browser synced: absent -> 0.8.6 (apk 300)
dsh plugin add dsh-ego-browser ... exit=0
builtin plugins assembled: 10 ok, 0 failed / 10 total
compat audit: 10 compatible, 0 incompatible / 10 total (dsh 0.2.0-rc.2)
（该轮 grep WARN|skip|fail：只有既有的「already wired, skip add」与 ripgrep 行；
  两个新插件所在行是 synced + exit=0，不是 skip/failed）

## 5. 真实 boot 配置前置校验（dsh --profile web --dump-config，stderr 0 行）
- id: modsearch
  name: '@liustack/modsearch'
- id: ego-browser
  name: dsh-ego-browser
两行均无 disabled: 字段（对比：dsh-web-mobile 等旧条目的同类行亦无）

## 6. 客户端（浏览器半区）解析
用 dsh 自带的 orderByModuleGraph 对 7 个声明 dsh.client 的内置插件排图 → 无环、无自引用
用真实 seed 表（react / react-dom / dsh-client-store / dsh-client-ui-slots /
  dsh-client-ui-primitives / dsh-client-ui-dockkit / cordis）逐条核对 client.js 的 require 说明符：
  @liustack/modsearch   → all specifiers resolvable
  dsh-ego-browser       → all specifiers resolvable
client.js 自注册 id 与 Loader 行 specifier 一致（@liustack/modsearch / dsh-ego-browser）

## 7. 入口与自带运行时可执行
modsearch host entry: apply=function name=modsearch
ego host entry      : apply=function name=ego-browser inject=[tools,subprocess]
modsearch CLI --version → 5.10.6    （从最终装配位置 files/plugins/modsearch 执行）
modsearch doctor      → OK（Node 26.4.0，引擎解析到 firecrawl READY）
modsearch search      → 真实出网成功，返回 nodejs.org 官方结果
ego-browser --status  → {"running": false}（能运行，只是浏览器未启动）

## 8. 依赖桥接（modsearch 专有隐性契约）
modsearch 的 dsh/index.js 用 process.execPath 拉起自带 dist/main.js；
该 CLI 顶层 import commander / undici。装配是 link:，pnpm 不为其按 dependencies 落盘；
实际解析：commander -> .pnpm/commander@15.0.0（本包声明 ^13.1.0）
          undici    -> .pnpm/undici@8.11.2 （本包声明 ^7.29.0）
即跨大版本，但已实跑 doctor/search 通过。属安装链既有行为（deps.mjs 桥接），非本次新增。

## 9. 已知运行期缺口（如实记录，非装配/兼容性问题）
本机无任何 Chrome/Chromium（pm list packages 无浏览器；文件系统无二进制）。
故 dsh-ego-browser 的工具可注册可调用，但实际驱动浏览器会回报「未找到浏览器二进制」；
ego_doctor 已把该状态显式列出：browser binary: (none found — set chromePath …)。

## 10. 仓库门禁
node tools/check-plugin-manifest.mjs → ✓ builtin=10，optional=2，exit=0
node tools/verify-prefix-patch.test.mjs → 15 项通过，exit=0
git status：新增 modsearch/ (36 文件)、dsh-ego-browser/ (47 文件)；改 README.md /
  docs/plugin-roster.md / plugin-manifest.json
