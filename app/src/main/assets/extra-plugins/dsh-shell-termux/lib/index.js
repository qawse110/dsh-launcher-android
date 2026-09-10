/**
 * dsh-shell-termux — Android/Termux bash 执行世界的显式环境注入。
 *
 * ## 为什么需要这个插件（工作区实证，2026-09-10）
 *
 * dsh 默认的 bash 执行器 spawn 时用的是**裸 `"bash"`**
 * （`LocalBashExecutor.runArgv(spec, ["bash", "-c", command])`）——靠**继承进程环境**
 * 里的 PATH 解析；而子进程环境 = `scrubbedParentEnv()` 与 spawn 显式 env 的合并，
 * 即**完全依赖 web 进程自身的 PATH/LD_LIBRARY_PATH 恰好正确**。
 *
 * 实测该依赖会失效：
 * ```
 * # 无显式 Termux 环境时，bash 工具子进程里：
 * $ git --version
 * CANNOT LINK EXECUTABLE "git": library "libpcre2-8.so" not found
 * # 注入 Termux 环境后正常：
 * $ git --version
 * git version 2.55.0
 * ```
 * 原因：Termux 二进制依赖 `LD_LIBRARY_PATH=<prefix>/lib`；缺失即动态链接失败。
 *
 * 本插件把 Termux 执行世界的坐标**在每次 resolve 时显式注入**，使执行不再依赖
 * 环境是否恰好正确——对齐参考项目 `kelai141/dsh-shell-termux` 的核心设计。
 *
 * ## 与参考实现的取舍
 *
 * - **不**注入 `TERMUX_VERSION`：工作区 bootstrap 与官方 Termux app 无交互，
 *   无消费方；伪造版本号可能误导 pkg 的兼容性分支（review-r4 已评估不采纳）。
 * - **不**注入 `DSH_WRITE_MODE` 等写面栅栏键：本机 dsh 的写面闸门由
 *   `dsh-sandbox-policy` 按会话档位（`sandbox/mode` 事件）裁决，
 *   实测 `grep -rl DSH_WRITE_MODE` 全树零命中 → 注入即死键。
 * - **保留** `assertBash` 式 fail-loudly：参考用 `accessSync(X_OK)`，工作区原先只判
 *   `isFile`——实测「存在但权限 644」时判真、执行 `Permission denied` 后以含混错误挂掉。
 *
 * ## 形态选择：子类化而非装饰器
 *
 * 参考实现 `extends LocalBashExecutor` 并让 `bash-sandbox` 条目 `disabled: true`，
 * 由本插件独占提供 `ctx.shell`。**必须**这样做：`ctx.shell` 是 cordis 单例服务，
 * 若只是"包一层现有实例的 resolve"，一旦默认执行器被禁用（或装配顺序变化）
 * 就没有任何东西提供该服务，插件会静默失效。子类化让注册权归属本插件，
 * 装配顺序不再影响正确性。
 *
 * 工作区是纯 JS 资产（无 tsc 构建链），故直接 import 上游 ESM 类并继承——
 * 已验证 `LocalBashExecutor` 可在运行时 import（导出含其本类与 `ENV_OVERRIDES`），
 * 且不需要复刻其私有字段（`config` 由基类 getter 提供、`ctx` 由基类持有）。
 *
 * @module @dsh-external/dsh-shell-termux
 */

import { accessSync, constants } from 'node:fs'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'

export const name = 'dsh-shell-termux'

/** 需要 cordis 注入的服务（与基类一致，子类必须重新声明）。 */
export const inject = ['subprocess']

/** `$PREFIX/bin` 下探测的可执行文件（coreutils/findutils/grep 基础件）。 */
const PROBE_BINARIES = ['bash', 'ls', 'cat', 'grep', 'find', 'sed', 'cp', 'mv', 'rm', 'mkdir', 'rg']

/** 探测二进制 → pkg 包名（供缺包提示）。 */
const PKG_FOR_BINARY = {
  bash: 'bash',
  ls: 'coreutils',
  find: 'findutils',
  grep: 'grep',
  rg: 'ripgrep',
}

/**
 * 构建自包含的 Termux 环境（纯函数，便于单测与门禁直接断言）。
 *
 * @param {{prefix:string, home:string, bashPath:string, nodeDir?:string, extraPath?:string[], globalDirs?:string[], ldPreload?:string, inheritPath?:string}} cfg
 * @param {Record<string,string>} [overrides] 调用方 request.env（最后合并，可信调用方可覆盖）
 * @returns {Record<string,string>}
 */
export function buildTermuxEnv(cfg, overrides = {}) {
  const { prefix, home, bashPath } = cfg
  const extra = cfg.extraPath ?? []
  const globalDirs = cfg.globalDirs ?? []
  // PATH 顺序即解析优先级。applets 是 Termux 的 busybox 风格入口，缺它会让
  // awk/sed 一类基础工具解析失败；/system/bin 兜底给 toybox。
  const explicit = [
    ...(cfg.nodeDir ? [`${cfg.nodeDir}/bin`] : []),
    ...globalDirs,
    `${prefix}/bin`,
    `${prefix}/bin/applets`,
    `${prefix}/local/bin`,
    ...extra,
    '/system/bin',
    '/bin',
    '/usr/bin',
  ]
  // **继承段必须保留在尾部**：上游 `childEnv` 是「父环境 ⊕ spawn env」，本插件
  // 注入的 env 会**覆盖**父 PATH。若只写死上面的固定目录，父 PATH 里引擎自带的
  // node/bin（以及用户自装的 ~/.tools/bin 等）会被整段丢掉 —— 工具层 `node`、
  // `pnpm` 一类命令随即不可用。显式目录优先、继承段兜底：既不依赖环境"恰好正确"，
  // 也不制造新缺口。
  const inherited = String(cfg.inheritPath ?? '')
    .split(':')
    .filter(Boolean)
  const merged = [...new Set([...explicit, ...inherited])]
  if (merged.length === 0) merged.push('/system/bin')

  return {
    PATH: merged.join(':'),
    // Termux 二进制依赖它解析 libpcre2/libexpat 等；缺失即 CANNOT LINK（实测）。
    // 同理保留继承段里的条目（如引擎 node/lib）。
    LD_LIBRARY_PATH: [
      ...new Set([
        ...(cfg.nodeDir ? [`${cfg.nodeDir}/lib`] : []),
        `${prefix}/lib`,
        ...String(cfg.inheritLdPath ?? '').split(':').filter(Boolean),
      ]),
    ].join(':'),
    HOME: home,
    PREFIX: prefix,
    SHELL: bashPath,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    // node 自带 openssl 需要它；不设会让 node 子进程报 openssl config error
    OPENSSL_CONF: '/dev/null',
    ...(cfg.ldPreload ? { LD_PRELOAD: cfg.ldPreload } : {}),
    ...overrides,
  }
}

/**
 * 校验三个坐标必须是绝对路径（fail-loudly，对齐参考实现）。
 * @throws {Error} 非绝对路径时抛出，信息含字段名与实收值。
 */
export function assertAbsolutePaths(cfg) {
  for (const field of ['bashPath', 'prefix', 'home']) {
    const v = cfg?.[field]
    if (typeof v !== 'string' || !v.startsWith('/')) {
      throw new Error(`shell-termux: ${field} must be an absolute path, got ${String(v)}`)
    }
  }
}

/**
 * bash 是否**可执行**（而非仅存在）。
 *
 * 工作区原实现只判 `File.isFile`——实测「存在但权限 644」时判真、执行
 * `Permission denied`，随后以含混错误挂掉。此处对齐参考实现的 `X_OK` 语义。
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkBashExecutable(bashPath) {
  try {
    accessSync(bashPath, constants.X_OK)
    return { ok: true }
  } catch (e) {
    const why =
      e?.code === 'ENOENT'
        ? 'not found'
        : e?.code === 'EACCES'
          ? 'permission denied (not executable)'
          : (e?.code ?? e?.message ?? 'unknown')
    return {
      ok: false,
      reason:
        `shell-termux: ${bashPath} is not executable (${why}); ` +
        `run 'pkg install bash' and 'chmod +x', or fix bashPath/prefix in the ` +
        `dsh-shell-termux plugin config`,
    }
  }
}

/**
 * 探测执行世界：bash 可执行性 + 模型工具依赖的工具链。
 * **永不抛异常**——不可用状态以结构化数据返回（对齐参考实现的 probe 契约）。
 *
 * @returns {{status:'full'|'partial'|'unusable', bash:string, missing:string[]}}
 */
export function probeWorld(bashPath, prefix) {
  const missing = []
  for (const tool of PROBE_BINARIES) {
    const p = tool === 'bash' ? bashPath : `${prefix}/bin/${tool}`
    try {
      accessSync(p, constants.X_OK)
    } catch {
      missing.push(tool)
    }
  }
  if (missing.includes('bash')) {
    return {
      status: 'unusable',
      bash: bashPath,
      missing: ['bash', 'coreutils', 'findutils', 'grep', 'ripgrep'],
    }
  }
  const missingPkgs = [...new Set(missing.map((b) => PKG_FOR_BINARY[b]).filter(Boolean))]
  return {
    status: missingPkgs.length === 0 ? 'full' : 'partial',
    bash: bashPath,
    missing: missingPkgs,
  }
}

/**
 * Termux bash 执行器：继承上游 `LocalBashExecutor` 的全部预算与生命周期机制
 * （进程组 SIGTERM→SIGKILL、输出上限与 spill、grace），只把「执行世界坐标」
 * 换成显式注入的 Termux 环境，并**诚实地声明沙箱语义**。
 *
 * ## 为什么必须替换默认执行器（本工作区实测，2026-09-10）
 *
 * dsh-base 默认装配 `bash-sandbox`，它在 `workspace-write`/`read-only` 下把命令交给
 * `ctx.sandbox.confine()` 包装（`this.ctx.sandbox.confine(["bash","-c",cmd], policy)`）。
 * 而 sandbox provider（`dsh-sandbox-local`）的平台链条是：
 * ```
 * PLATFORM_CHAINS = { linux: [bwrap, landlock], darwin: [seatbelt], win32: [windows-acl] }
 * ```
 * **没有 android 条目** → `chainVerdict()` 返回 `"unavailable"` → `selectRunner()` 抛
 * `SandboxUnavailableError`（fail-closed，拒绝执行）。
 *
 * 而 dsh-base 的会话默认档位是 `workspace-write`（`DSH_PERMISSION_MODE ?? 'workspace-write'`）
 * ——即**默认档位下 Android 的 bash 工具会被沙箱 fail-closed 拒绝**。
 * 本工作区之所以暂时可用，是因为现有会话档位恰好都是 `danger-full-access`
 * （该模式下 `run()` 直接 `return super.run(spec)`，不经 confine）。用户一旦把档位切回
 * 默认的 workspace-write（或新会话未显式升档），bash 工具即不可用。
 *
 * 参考项目 `kelai141/dsh-shell-termux` 的整个存在理由正是这一实证
 * （其设计文档：「A platform with no chain fails closed at confine()」→
 * 「安卓上 bash 工具实际执行会被沙箱拒绝」）。
 *
 * ## 沙箱语义：诚实声明，不做假沙箱
 *
 * 安卓上真实的安全边界是 **Android SELinux 应用域（untrusted_app_27）+ 审批流**，
 * 不是路径级 confiner。故 `run`/`start` 如实上报 `enforcement: 'partial'`、
 * `denied: false`，而不假装有沙箱；档位语义与审批流由 `dsh-sandbox-policy` 承担。
 */
export class TermuxBashExecutor extends LocalBashExecutor {
  constructor(ctx, config) {
    super(ctx, config)
    // schemastery 不认识的键会原样保留在 config 上（上游 getter 只读已知字段），
    // 故 Termux 坐标在此读取并显式校验。
    const c = config ?? {}
    assertAbsolutePaths(c)
    this._termuxCfg = {
      prefix: c.prefix,
      home: c.home,
      bashPath: c.bashPath,
      nodeDir: c.nodeDir,
      extraPath: c.extraPath,
      globalDirs: c.globalDirs,
      ldPreload: c.ldPreload,
    }
  }

  /**
   * 把受控的 Termux 环境盖到每个请求上。
   *
   * 覆盖策略：注入项在前、调用方 `request.env` 在后 —— 与上游 `ENV_OVERRIDES`
   * 「可信调用方仍可覆盖」的哲学一致，避免把调用方主动指定的值静默吃掉。
   */
  resolve(request) {
    // inheritPath/inheritLdPath 取**引擎进程**的当前值：上游 childEnv 是
    // 「父环境 ⊕ spawn env」，我们注入的 PATH 会覆盖父 PATH，故必须显式把父值
    // 接在尾部兜底，否则引擎自带 node/bin 会被丢掉（工具层 node 随即不可用）。
    const injected = buildTermuxEnv(
      { ...this._termuxCfg, inheritPath: process.env.PATH, inheritLdPath: process.env.LD_LIBRARY_PATH },
      request?.env ?? {},
    )
    return super.resolve({ ...request, env: injected })
  }

  /**
   * 本执行器不做**路径级**沙箱，故 `sandboxMode` 如实返回 `undefined`。
   *
   * 上游契约：「the sandbox mode this executor applies by default,
   * **or `undefined` when it does not sandbox commands**」。
   *
   * 为什么不返回配置档位：返回它等于宣称「我按 workspace-write 约束了写面」，
   * 而安卓上真实边界是 SELinux 应用域、不是路径 confiner——该宣称会误导工具层
   * （它据 `sandboxMode` 决定是否展示升档提示与沙箱拒绝标记）。参考实现同样声明
   * 「honest app-domain sandbox declaration」。
   *
   * 档位语义（read-only/workspace-write/danger-full-access）仍由
   * `dsh-sandbox-policy` + 审批流承担，不因本执行器而改变。
   */
  get sandboxMode() {
    return undefined
  }

  /** bash 不可执行时以修复指引拒绝，而不是让 spawn 抛含混错误。 */
  _assertBash() {
    const r = checkBashExecutable(this._termuxCfg.bashPath)
    if (!r.ok) throw new Error(r.reason)
  }

  /**
   * 安卓应用域不是路径级 confiner：如实声明 partial（对齐参考实现）。
   *
   * `tool-bash` 消费 `result.sandbox.denied` 生成给模型的拒绝标记；此处恒为 false
   * 是正确的——本执行器不会因"沙箱不可用"而拒绝命令（那正是本插件要消除的
   * fail-closed 行为）。真实边界是 SELinux 应用域，越界由内核以 EACCES 报错，
   * 走普通命令失败路径而非沙箱拒绝标记。
   *
   * `mode` 取 [sandboxMode]（本实现为 `undefined`）：不谎报某个档位已被路径级执行。
   */
  _sandboxFacts() {
    return { mode: this.sandboxMode, denied: false, enforcement: 'partial' }
  }

  async run(spec) {
    this._assertBash()
    const result = await super.run(spec)
    return { ...result, sandbox: this._sandboxFacts() }
  }

  start(spec) {
    this._assertBash()
    const proc = super.start(spec)
    proc.sandbox = this._sandboxFacts()
    return proc
  }

  /** 诊断入口：执行世界状态（永不抛）。 */
  probe() {
    return probeWorld(this._termuxCfg.bashPath, this._termuxCfg.prefix)
  }
}

export const __testing = Object.freeze({
  buildTermuxEnv,
  assertAbsolutePaths,
  checkBashExecutable,
  probeWorld,
  PROBE_BINARIES,
  PKG_FOR_BINARY,
})

export default TermuxBashExecutor
