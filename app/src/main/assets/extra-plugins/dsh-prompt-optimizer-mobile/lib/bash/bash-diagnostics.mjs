import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const SEPARATORS = new Set(['&&', '||', '|', ';'])

// This conservative lexer keeps nested shell code opaque; it is not a shell parser.
function scan(command) {
  const s = String(command || '')
  const parts = []
  let cur = '', visible = '', quote = '', depth = 0, comment = false
  const flush = (separator) => {
    if (cur.trim()) parts.push(cur.trim())
    if (separator) parts.push(separator)
    cur = ''
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i], next = s[i + 1] || ''
    if (comment) {
      visible += ' '
      if (c === '\n') { comment = false; if (!depth) flush(';'); else cur += c }
      continue
    }
    if (quote) {
      cur += c; visible += '\x01'
      if (c === '\\' && quote !== "'" && next) {
        cur += next; visible += '\x01'; i++
      } else if (c === quote) quote = ''
      continue
    }
    if (c === '\\' && next) {
      if (next !== '\n') cur += c + next
      visible += next === '\n' ? '' : '\x01\x01'; i++; continue
    }
    if (c === '"' || c === "'" || c === '\x60') {
      quote = c; cur += c; visible += '\x01'; continue
    }
    if (c === '#' && (i === 0 || /[\s;|&()]/.test(s[i - 1]))) {
      comment = true; visible += ' '; continue
    }
    // Heredoc bodies and case terminators need a full parser: abstain.
    if (c === '<' && next === '<') return { parts: [s.trim()].filter(Boolean), visible: '' }
    if (c === '(' || (c === '{' && (i === 0 || s[i - 1] === '$' || /[\s;|&]/.test(s[i - 1])))) depth++
    if (depth) {
      cur += c; visible += '\x01'
      if (c === ')' || c === '}') depth = Math.max(0, depth - 1)
      continue
    }
    const two = c + next
    if (two === '&&' || two === '||') {
      flush(two); visible += two; i++; continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      if (c === ';' && next === ';') return { parts: [s.trim()].filter(Boolean), visible: '' }
      flush(c === '\n' ? ';' : c); visible += c
      if (c === '|' && next === '&') { visible += '&'; i++ }
      continue
    }
    cur += c; visible += c
  }
  flush()
  if (quote || depth || s.endsWith('\\')) return { parts: [s.trim()].filter(Boolean), visible: '' }
  if (SEPARATORS.has(parts.at(-1))) parts.pop()
  return { parts, visible }
}

export function splitStages(command) { return scan(command).parts }

export function chainFinding(command) {
  const parts = splitStages(command)
  const commands = parts.filter(p => !SEPARATORS.has(p))
  const risky = [...new Set(parts.filter(p => p === ';' || p === '|' || p === '||'))]
  if (commands.length < 3 || !risky.length) return ''
  return '这条链有 ' + commands.length + ' 段，连接符（' + risky.join(' ') + '）存在中间失败被后续状态覆盖的风险；'
    + 'pipefail、set -e、条件恢复及具体 shell 上下文会影响结果，不能仅凭链结构断言吞错。失败时可分步运行并检查各段状态。'
}

const HEAVY = [
  [/puppeteer|playwright|selenium|--headless/i, '无头浏览器', '先验证加载和尺寸；已有 JSON/像素统计足够时复用它们。需要真实渲染时保留浏览器验证，将结果落盘复用。'],
  [/\bnpx\b|\bnpm\s+(?:i|install|ci)\b|\bpnpm\s+(?:i|install)\b|\byarn(?:\s+install)?\b/i, '装包/拉依赖', '网络步骤可单独运行并确认可达，优先复用已有依赖。'],
  [/\bgit\s+clone\b|\bcurl\s|\bwget\s/i, '网络下载', '先确认可达，再决定下载范围，保留结果供后续复用。'],
  [/\bdocker\s+(?:build|compose)\b|\bmsbuild\b|\bdotnet\s+build\b|\bcargo\s+build\b|\bwebpack\b|\bvite\s+build\b/i, '重构建', '先验证小目标工具链，完整构建可与取图或测试分步运行。'],
]

export function heavyFindings(command) {
  return HEAVY.filter(([re]) => re.test(String(command || '')))
    .map(([, name, alt]) => '（重武器：' + name + '）更便宜的路：' + alt)
}

function count(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0 }
function stdoutDiscarded(command) {
  // Quoted text and stderr-only 2>/dev/null are not stdout redirection evidence.
  return /(?:&>|(?<![0-9>&])>{1,2}|(?<![\w])1>{1,2})\s*\/dev\/null(?=$|[\s;|&])/.test(scan(command).visible)
}
function header(ms, outLen, opt = {}) {
  const bytes = opt.stdoutBytes != null && opt.stderrBytes != null
    ? '，累计stdout+stderr ' + (count(opt.stdoutBytes) + count(opt.stderrBytes)) + '字节' : ''
  return '[本次耗时 ' + Math.round(count(ms) / 1000) + 's，返回' + count(outLen) + '字符' + bytes
    + (opt.timedOut ? '，超时' : opt.cancelled ? '，已取消' : opt.failed ? '，失败' : '') + ']'
}

export function costNote(ms, command, outLen) {
  if (count(ms) < 60000 || count(outLen) >= 400) return ''
  return '\n' + header(ms, outLen) + '\n少量可读输出本身不代表失败或纯损失；本次等待较久，下一步可先检查退出状态和预期产物。'
    + (stdoutDiscarded(command) ? '\n- 检测到 stdout 重定向到 /dev/null；若需要排障，可保留相关日志。' : '')
}

export function usageNote(o) {
  const opt = o || {}, ms = count(opt.ms), outLen = count(opt.outLen)
  if (!(opt.failed === true || opt.timedOut === true || (ms >= 60000 && outLen < 400))) return ''
  const lines = ['', header(ms, outLen, opt)]
  if (ms >= 60000 && outLen < 400) lines.push('少量可读输出本身不代表失败或纯损失；本次等待较久，可检查退出状态和预期产物后再决定是否扩大运行。')
  if (stdoutDiscarded(opt.command)) lines.push('- 检测到 stdout 重定向到 /dev/null；排障时可保留相关日志。')
  const chain = chainFinding(opt.command)
  if (chain) lines.push('- ' + chain)
  for (const finding of heavyFindings(opt.command)) lines.push('- ' + finding)
  return lines.join('\n')
}

function confirmedDead(pid) {
  try { process.kill(pid, 0); return false }
  catch (error) { return error.code === 'ESRCH' }
}
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i

/** Diagnostics must never turn storage failures into command failures. */
export function beginInvocation({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), sessionId, command } = {}) {
  const token = { id: randomUUID(), path: null, sessionId, ownerPID: process.pid, startedAt: Date.now(), command: String(command || ''), previous: [], note: '' }
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    token.storageError = 'sessionId is required for session-scoped invocation records'
    return token
  }
  try {
    const directory = join(home, 'po06-bash-invocations')
    mkdirSync(directory, { recursive: true })
    for (const filename of readdirSync(directory)) {
      if (!UUID_FILE.test(filename)) continue
      try {
        const path = join(directory, filename)
        const record = JSON.parse(readFileSync(path, 'utf8'))
        if (record.version !== 1 || record.id + '.json' !== filename || record.sessionId !== sessionId
          || !Number.isSafeInteger(record.ownerPID) || record.ownerPID <= 0 || record.ownerPID === process.pid
          || typeof record.command !== 'string' || !Number.isFinite(record.startedAt)) continue
        if (!confirmedDead(record.ownerPID)) continue
        // Only the matching, confirmed-dead owner can be claimed. Other records remain untouched.
        rmSync(path)
        token.previous.push(record)
      } catch { /* Missing, malformed, inaccessible or concurrently claimed records are not evidence. */ }
    }
    const path = join(directory, token.id + '.json')
    writeFileSync(path, JSON.stringify({ version: 1, id: token.id, sessionId, ownerPID: process.pid, startedAt: token.startedAt, command: token.command }), { flag: 'wx', mode: 0o600 })
    token.path = path
  } catch (error) { token.storageError = String(error.message || error) }
  if (token.previous.length) token.note = '\n[同session有 ' + token.previous.length + ' 次调用记录未正常收尾，且ownerPID已确认不存在；这不证明命令失败，可能是进程退出或被终止。]'
  return token
}

/** Call in finally, including cancellation, timeout, and shutdown paths. Idempotent. */
export function endInvocation(token) {
  if (!token?.path || basename(token.path) !== token.id + '.json' || token.ownerPID !== process.pid) return false
  try {
    const record = JSON.parse(readFileSync(token.path, 'utf8'))
    if (record.id !== token.id || record.ownerPID !== process.pid || record.sessionId !== token.sessionId) return false
    rmSync(token.path)
    token.path = null
    return true
  } catch (error) {
    if (error.code === 'ENOENT') token.path = null
    else token.storageError = String(error.message || error)
    return false
  }
}
