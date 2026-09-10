// dsh-shell-termux 单元测试（review-r9）。
//
// 覆盖本插件存在的两个理由，以及一个我自己引入过的回归：
//   1. 显式 Termux 环境注入 —— 不依赖引擎进程环境"恰好正确"
//      （实测：缺 LD_LIBRARY_PATH 时 `git --version` → CANNOT LINK）
//   2. bash **可执行性**检查（X_OK）—— 工作区原先只判 isFile，
//      实测「存在但权限 644」判真后执行 Permission denied
//   3. PATH 继承段必须保留 —— 上游 childEnv 是「父环境 ⊕ spawn env」，
//      注入的 PATH 会覆盖父 PATH；若只写死固定目录，引擎自带 node/bin 会丢失
//
// 运行：node --test app/src/main/assets/extra-plugins/dsh-shell-termux/test/
//
// 注意：本测试**不** import 插件的默认导出路径（它 import 上游
// `@deepseek-ai/dsh-bash-local`，只有 dsh 运行时才能解析）。故只测纯函数——
// 它们承载全部契约逻辑；类本体只是把纯函数接到 seam 上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'lib', 'index.js')

// 剥离 peer import 后动态加载，从而在无 dsh 环境的 CI 上也能测纯函数。
// **只剥离上游 peer 依赖**（`@deepseek-ai/dsh-bash-local`）——`node:fs` 必须保留真身，
// 否则 checkBashExecutable/probeWorld 的探测会全部"成功"，测试变成空转
// （初版就是这样：把 node:fs 一并桩掉后，probeWorld 对不存在的 bash 也返回 full）。
// 剥离是机械的，若上游 import 形式变化，下方断言会立刻失败而不是静默放过。
function loadPure() {
  let src = readFileSync(SRC, 'utf8')
  const before = src
  src = src.replace(
    /^import\s+\{[^}]*\}\s+from\s+'@deepseek-ai\/dsh-bash-local'\s*$/m,
    'const LocalBashExecutor = class {}',
  )
  assert.notEqual(src, before, '导入剥离未生效 —— 插件顶部 peer import 形式已变，请同步本测试')
  assert.match(src, /from 'node:fs'/, 'node:fs 必须保留真身（桩掉会让探测类测试空转）')
  const dir = mkdtempSync(join(tmpdir(), 'shell-termux-'))
  const f = join(dir, 'pure.mjs')
  writeFileSync(f, src)
  return import(f)
}

const mod = await loadPure()
const { buildTermuxEnv, assertAbsolutePaths, checkBashExecutable, probeWorld, PROBE_BINARIES } = mod.__testing

const PREFIX = '/data/user/0/com.dsh.launcher/files/termux/usr'
const HOME = '/data/user/0/com.dsh.launcher/files'
const BASH = `${PREFIX}/bin/bash`

// ── 1. 显式环境注入 ──

test('buildTermuxEnv 注入 Termux 执行世界坐标', () => {
  const env = buildTermuxEnv({ prefix: PREFIX, home: HOME, bashPath: BASH, nodeDir: `${HOME}/node` })
  assert.equal(env.PREFIX, PREFIX)
  assert.equal(env.HOME, HOME)
  assert.equal(env.SHELL, BASH)
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.OPENSSL_CONF, '/dev/null', 'node 自带 openssl 需要它')
})

test('LD_LIBRARY_PATH 含 prefix/lib —— 缺它 Termux 二进制 CANNOT LINK（实测）', () => {
  const env = buildTermuxEnv({ prefix: PREFIX, home: HOME, bashPath: BASH, nodeDir: `${HOME}/node` })
  const parts = env.LD_LIBRARY_PATH.split(':')
  assert.ok(parts.includes(`${PREFIX}/lib`), `LD_LIBRARY_PATH 必须含 ${PREFIX}/lib，实际 ${env.LD_LIBRARY_PATH}`)
  assert.ok(parts.includes(`${HOME}/node/lib`), 'node/lib 应在前，保证优先解析 node 自带库')
  // 顺序：node/lib 在 prefix/lib 之前
  assert.ok(parts.indexOf(`${HOME}/node/lib`) < parts.indexOf(`${PREFIX}/lib`))
})

test('PATH 含 prefix/bin 与 applets（缺 applets 会让 awk/sed 解析失败）', () => {
  const env = buildTermuxEnv({ prefix: PREFIX, home: HOME, bashPath: BASH })
  const parts = env.PATH.split(':')
  assert.ok(parts.includes(`${PREFIX}/bin`))
  assert.ok(parts.includes(`${PREFIX}/bin/applets`))
  assert.ok(parts.includes('/system/bin'), '/system/bin 兜底给 toybox')
})

test('PATH 顺序：显式目录优先于继承段', () => {
  const env = buildTermuxEnv(
    { prefix: PREFIX, home: HOME, bashPath: BASH, inheritPath: '/ambient/bin' },
  )
  const parts = env.PATH.split(':')
  assert.ok(parts.indexOf(`${PREFIX}/bin`) < parts.indexOf('/ambient/bin'))
})

// ── 2.（我自己引入过的回归）PATH 继承段必须保留 ──

test('注入 PATH 不得丢掉继承段（否则引擎自带 node/bin 消失）', () => {
  const env = buildTermuxEnv({
    prefix: PREFIX,
    home: HOME,
    bashPath: BASH,
    nodeDir: `${HOME}/node`,
    inheritPath: `/some/other/bin:${HOME}/.tools/bin`,
  })
  const parts = env.PATH.split(':')
  assert.ok(parts.includes(`${HOME}/.tools/bin`), '继承段条目必须保留在尾部兜底')
  assert.ok(parts.includes('/some/other/bin'))
  assert.ok(parts.includes(`${HOME}/node/bin`), '显式 node/bin 仍在（优先）')
})

test('无继承段时也能产出合法 PATH（不出现空段）', () => {
  const env = buildTermuxEnv({ prefix: PREFIX, home: HOME, bashPath: BASH })
  assert.ok(!env.PATH.includes('::'), '不应出现空路径段')
  assert.ok(!env.PATH.startsWith(':'))
  assert.ok(!env.PATH.endsWith(':'))
})

test('重复目录去重（继承段与显式段重叠时）', () => {
  const env = buildTermuxEnv({
    prefix: PREFIX,
    home: HOME,
    bashPath: BASH,
    inheritPath: `${PREFIX}/bin:/system/bin`,
  })
  const parts = env.PATH.split(':')
  assert.equal(parts.filter((p) => p === `${PREFIX}/bin`).length, 1, 'prefix/bin 不应重复')
  assert.equal(parts.filter((p) => p === '/system/bin').length, 1)
})

test('LD_LIBRARY_PATH 亦保留继承段并去重', () => {
  const env = buildTermuxEnv({
    prefix: PREFIX,
    home: HOME,
    bashPath: BASH,
    nodeDir: `${HOME}/node`,
    inheritLdPath: `${PREFIX}/lib:/extra/lib`,
  })
  const parts = env.LD_LIBRARY_PATH.split(':')
  assert.equal(parts.filter((p) => p === `${PREFIX}/lib`).length, 1)
  assert.ok(parts.includes('/extra/lib'), '继承的额外库路径不应被丢弃')
})

// ── overrides 语义 ──

test('调用方 overrides 最后合并（可信调用方可覆盖）', () => {
  const env = buildTermuxEnv(
    { prefix: PREFIX, home: HOME, bashPath: BASH },
    { HOME: '/custom/home', MY_VAR: 'x' },
  )
  assert.equal(env.HOME, '/custom/home', 'request.env 应能覆盖注入值')
  assert.equal(env.MY_VAR, 'x')
  assert.equal(env.PREFIX, PREFIX, '未覆盖的键保持注入值')
})

test('未提供 ldPreload 时不产生 LD_PRELOAD 键', () => {
  const env = buildTermuxEnv({ prefix: PREFIX, home: HOME, bashPath: BASH })
  assert.ok(!('LD_PRELOAD' in env), '避免注入空值导致动态库加载告警')
})

test('提供 ldPreload 时注入它（termux-exec 的 shebang 翻译依赖）', () => {
  const env = buildTermuxEnv(
    { prefix: PREFIX, home: HOME, bashPath: BASH, ldPreload: `${PREFIX}/lib/libtermux-exec-ld-preload.so` },
  )
  assert.equal(env.LD_PRELOAD, `${PREFIX}/lib/libtermux-exec-ld-preload.so`)
})

// ── 3. 路径校验 fail-loudly ──

test('assertAbsolutePaths 拒绝相对路径并指名字段', () => {
  for (const field of ['bashPath', 'prefix', 'home']) {
    const cfg = { bashPath: BASH, prefix: PREFIX, home: HOME, [field]: 'relative/path' }
    assert.throws(() => assertAbsolutePaths(cfg), new RegExp(field), `${field} 为相对路径时应抛错且信息含字段名`)
  }
})

test('assertAbsolutePaths 拒绝空/非字符串', () => {
  assert.throws(() => assertAbsolutePaths({ bashPath: '', prefix: PREFIX, home: HOME }), /bashPath/)
  assert.throws(() => assertAbsolutePaths({ bashPath: undefined, prefix: PREFIX, home: HOME }), /bashPath/)
  assert.throws(() => assertAbsolutePaths({ bashPath: 123, prefix: PREFIX, home: HOME }), /bashPath/)
})

test('assertAbsolutePaths 接受合法配置', () => {
  assert.doesNotThrow(() => assertAbsolutePaths({ bashPath: BASH, prefix: PREFIX, home: HOME }))
})

// ── 4. 可执行性检查（X_OK）：工作区原先只判 isFile ──

test('checkBashExecutable 对不存在的路径报 not found 且含修复指引', () => {
  const r = checkBashExecutable('/nonexistent/bash-for-test')
  assert.equal(r.ok, false)
  assert.match(r.reason, /not executable/)
  assert.match(r.reason, /not found/)
  assert.match(r.reason, /pkg install bash/, '必须给出修复指引（fail-loudly）')
})

test('checkBashExecutable 对存在但不可执行的文件判失败（isFile 会误判为真）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-termux-bin-'))
  const f = join(dir, 'bash')
  writeFileSync(f, '#!/bin/sh\necho hi\n')
  chmodSync(f, 0o644) // 可读不可执行
  const r = checkBashExecutable(f)
  assert.equal(r.ok, false, '权限不足必须判失败 —— 这正是 isFile 检查漏掉的场景')
  assert.match(r.reason, /permission denied/i)
})

test('checkBashExecutable 对可执行文件判成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-termux-bin2-'))
  const f = join(dir, 'bash')
  writeFileSync(f, '#!/bin/sh\necho hi\n')
  chmodSync(f, 0o755)
  assert.equal(checkBashExecutable(f).ok, true)
})

// ── 5. probe 契约：永不抛、结构化返回 ──

test('probeWorld 在 bash 缺失时返回 unusable（不抛异常）', () => {
  let r
  assert.doesNotThrow(() => {
    r = probeWorld('/nonexistent/bash', '/nonexistent/prefix')
  })
  assert.equal(r.status, 'unusable')
  assert.ok(r.missing.includes('bash'))
})

test('probeWorld 在全部工具就绪时返回 full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-termux-prefix-'))
  const bin = join(dir, 'bin')
  // mkdtemp 已建目录，补 bin
  mkdirSync(bin, { recursive: true })
  const bash = join(bin, 'bash')
  writeFileSync(bash, '#!/bin/sh\n')
  chmodSync(bash, 0o755)
  for (const tool of PROBE_BINARIES) {
    if (tool === 'bash') continue
    const p = join(bin, tool)
    writeFileSync(p, '#!/bin/sh\n')
    chmodSync(p, 0o755)
  }
  const r = probeWorld(bash, dir)
  assert.equal(r.status, 'full', `期望 full，缺 ${JSON.stringify(r.missing)}`)
  assert.deepEqual(r.missing, [])
})

test('probeWorld 缺部分工具时返回 partial 并映射到 pkg 名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-termux-prefix2-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const bash = join(bin, 'bash')
  writeFileSync(bash, '#!/bin/sh\n')
  chmodSync(bash, 0o755)
  // 只提供 ls（coreutils），缺其余 → 应报其余 pkg
  writeFileSync(join(bin, 'ls'), '#!/bin/sh\n')
  chmodSync(join(bin, 'ls'), 0o755)
  const r = probeWorld(bash, dir)
  assert.equal(r.status, 'partial')
  assert.ok(!r.missing.includes('coreutils'), 'ls 就绪则 coreutils 不应报缺')
  assert.ok(r.missing.includes('ripgrep'), 'rg 缺失应报 ripgrep')
  assert.ok(r.missing.includes('findutils'), 'find 缺失应报 findutils')
})

test('probeWorld 的 missing 是去重后的 pkg 名（非二进制名）', () => {
  const r = probeWorld('/nonexistent/bash', '/nonexistent/prefix')
  const dup = r.missing.filter((x, i) => r.missing.indexOf(x) !== i)
  assert.deepEqual(dup, [], 'missing 不应有重复项')
})
