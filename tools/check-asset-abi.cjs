#!/usr/bin/env node
/**
 * check-asset-abi.cjs — 内置 node 运行时的 ABI/ELF 门禁。
 *
 * 背景（对齐参考项目 `scripts/elf-check.mjs`，其坑 18 与坑 30 是两次真机重大事故）：
 *   - 坑 18：debug APK 里打包了 x86_64 快照，装到 arm64 真机覆盖后引擎崩——
 *     `error: ".../usr/bin/node" is for EM_X86_64 (62) instead of EM_AARCH64 (183)`。
 *   - 坑 30：双 ABI 循环打包，assets 停在循环最后一个 ABI，之后直接 assembleDebug
 *     的产物即错 ABI；铁律是「真机安装只用对应 ABI 命名产物」。
 *
 * 本项目同样通过 LFS 分发 `app/src/main/assets/node/termux-node-aarch64.tar.gz`
 * （文件名写死 aarch64，但 **文件名不是事实**）。本门禁读归档内 `bin/node` 的
 * ELF 头 e_machine，与文件名声明及期望 ABI 双向核对，把该类事故挡在打包之前。
 *
 * 用法：
 *   node tools/check-asset-abi.cjs              # 门禁模式：校验内置 node 归档
 *   node tools/check-asset-abi.cjs <归档...>    # 额外校验指定归档（自测/临时核对用）
 *   node tools/check-asset-abi.cjs --verbose    # 额外打印归档内条目统计
 *
 * 退出码：0 = 通过；1 = 不匹配/缺失/非 ELF（拒绝打包）；2 = 参数错误。
 *
 * 重要：**未拉取 LFS 时跳过而非失败**。CI 的 `actions/checkout` 未开 `lfs: true`
 * 时拿到的是 133 字节指针文件；把它当错 ABI 报错会制造假警报。门禁显式识别
 * LFS 指针并给出 SKIP + 提示（拉取与否由调用方负责，CI 已开 lfs: true）。
 */
const { readFileSync, existsSync, openSync, readSync, closeSync, statSync } = require('node:fs')
const { join, resolve, isAbsolute } = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = resolve(__dirname, '..')
const VERBOSE = process.argv.includes('--verbose')

// ELF e_machine 取值（EM_*）→ ABI 名
const MACHINES = {
  0x03: 'i386',
  0x28: 'arm',
  0x3e: 'x86_64',
  0xb7: 'aarch64',
}
// 文件名声明 → 期望 e_machine
const EXPECT = {
  aarch64: 0xb7,
  arm64: 0xb7,
  x86_64: 0x3e,
  x64: 0x3e,
}

/** 待校验的 node 运行时归档（文件名即 ABI 声明来源）。 */
const DEFAULT_ASSETS = [
  'app/src/main/assets/node/termux-node-aarch64.tar.gz',
  'app/src/main/assets/node/termux-node-aarch64.tar',
]

/** 命令行附加的归档路径（可绝对或相对仓库根）。 */
const EXTRA_ASSETS = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--'))

const ASSETS = [...DEFAULT_ASSETS, ...EXTRA_ASSETS]

const ELF_MAGIC = 0x464c457f

function isLfsPointer(buf) {
  return buf.length < 1024 && buf.toString('utf8', 0, 40).startsWith('version https://git-lfs.github.com/spec/')
}

/**
 * 是否为 ELF 魔数开头。
 */
function isElf(buf) {
  return !!buf && buf.length >= 4 && buf.readUInt32LE(0) === ELF_MAGIC
}

/** 取归档内 `bin/node` 的前 20 字节；不存在或失败返回 null。 */
function tryExtractBinNode(path) {
  try {
    const out = execFileSync("tar", ["-xOf", path, "bin/node"], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out.subarray(0, 20)
  } catch {
    return null
  }
}

/** 列出归档条目名（gzip 由 tar 自动处理）。失败返回空数组。 */
function listEntries(path) {
  try {
    return execFileSync("tar", ["-tf", path], {
      maxBuffer: 96 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 从归档中抽取 `bin/node` 的前 20 字节（ELF 头 + e_machine 所在偏移）。
 *
 * **归档是两层**（真机实测，2026-09-10）：`termux-node-aarch64.tar.gz` 解出的是
 * 单个内层 `termux-node-aarch64.tar`，真正的 `bin/node` 在**内层**。这与
 * `NodeRuntime.ensureExtracted` 的处理一致——它解完外层后若发现 `bin/node` 不在场，
 * 会把唯一的 `*.tar` 再解一次（「外层 tar 包着真实 node tar」的兼容分支）。
 *
 * 初版门禁漏了这一层，直接找外层 `bin/node` → CI 上（LFS 已拉取，非指针文件）
 * 报「归档内未找到 bin/node」。**门禁自己抓出了自己的错误假设**——这正是
 * 「门禁必须在真实输入上跑过」的价值：仅用自造的扁平 tar 自测会漏掉。
 */
function extractNodeHeader(path) {
  // 形态一：扁平归档，外层直接有 bin/node
  const direct = tryExtractBinNode(path)
  if (isElf(direct)) return direct

  // 形态二：外层含内层 tar → tar|tar 管道流式取内层 bin/node，全程不落盘
  const innerTar = listEntries(path).find((n) => n.endsWith(".tar") && !n.endsWith("/"))
  if (innerTar) {
    try {
      const out = execFileSync(
        "sh",
        ["-c", `tar -xOf "$1" "$2" | tar -xOf - bin/node`, "sh", path, innerTar],
        { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      )
      if (out && out.length >= 4) return out.subarray(0, 20)
    } catch {
      /* 落到下方统一返回 */
    }
  }

  return direct
}

function checkOne(relPath) {
  const abs = isAbsolute(relPath) ? relPath : join(ROOT, relPath)
  if (!existsSync(abs)) return { status: 'missing', relPath }

  const head = readFileSync(abs).subarray(0, 64)
  if (isLfsPointer(head)) return { status: 'lfs', relPath }

  // 文件名声明的 ABI：termux-node-<abi>.tar[.gz]
  const m = /termux-node-([a-z0-9_]+)\.tar(\.gz)?$/.exec(relPath)
  const declared = m ? m[1] : null
  if (!declared || EXPECT[declared] === undefined) {
    return { status: 'unknown-abi-name', relPath, declared }
  }

  let hdr
  try {
    hdr = extractNodeHeader(abs)
  } catch (e) {
    return { status: 'extract-failed', relPath, error: e.message }
  }

  if (!hdr || hdr.length < 20) {
    return { status: 'not-elf', relPath, got: hdr ? hdr.length : 0 }
  }
  if (hdr.readUInt32LE(0) !== ELF_MAGIC) {
    return { status: 'not-elf', relPath, got: hdr.length }
  }
  const machine = hdr.readUInt16LE(18)
  const name = MACHINES[machine] || '0x' + machine.toString(16)
  return {
    status: machine === EXPECT[declared] ? 'ok' : 'abi-mismatch',
    relPath,
    declared,
    want: EXPECT[declared],
    got: machine,
    gotName: name,
    elfClass: hdr[4],
    size: statSync(abs).size,
  }
}

function main() {
  const results = ASSETS.map(checkOne)
  const present = results.filter((r) => r.status !== 'missing')

  if (present.length === 0) {
    console.error('  FAIL 未找到任何内置 node 运行时归档：')
    for (const r of results) console.error('    - ' + r.relPath)
    process.exit(1)
  }

  let failed = 0
  for (const r of results) {
    switch (r.status) {
      case 'missing':
        console.log(`  --   ${r.relPath}（不存在，跳过）`)
        break
      case 'lfs':
        console.log(`  SKIP ${r.relPath}（LFS 指针未拉取——CI 需 checkout lfs: true）`)
        break
      case 'ok':
        console.log(
          `  OK   ${r.relPath}\n` +
            `       e_machine=0x${r.got.toString(16)} (${r.gotName}) elf${r.elfClass === 2 ? '64' : '32'}` +
            ` 声明=${r.declared} 一致，${(r.size / 1048576).toFixed(1)}MB`,
        )
        break
      case 'abi-mismatch':
        failed++
        console.error(
          `  FAIL ${r.relPath}\n` +
            `       归档内 bin/node 实际 e_machine=0x${r.got.toString(16)} (${r.gotName})` +
            ` ≠ 文件名声明 ${r.declared} (0x${r.want.toString(16)})\n` +
            `       参考坑 18/30：错 ABI 运行时装到真机 = 引擎启动即崩`,
        )
        break
      case 'not-elf':
        failed++
        console.error(`  FAIL ${r.relPath}\n       归档内 bin/node 非 ELF（仅取到 ${r.got} 字节）`)
        break
      case 'extract-failed':
        failed++
        console.error(`  FAIL ${r.relPath}\n       无法从归档提取 bin/node：${r.error}`)
        break
      case 'unknown-abi-name':
        failed++
        console.error(
          `  FAIL ${r.relPath}\n       无法从文件名推断 ABI（期望 termux-node-<arm64|x86_64>.tar[.gz]）`,
        )
        break
      default:
        failed++
        console.error(`  FAIL ${r.relPath}（未知状态 ${r.status}）`)
    }
  }

  if (failed > 0) {
    console.error(`\n  ABI 门禁未通过：${failed} 项。`)
    process.exit(1)
  }
  console.log('  ABI 门禁通过（内置 node 运行时架构与声明一致）')
  process.exit(0)
}

main()
