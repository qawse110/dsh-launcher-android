// One return contract for success, failure, cancellation and truncated output.
export function renderBashOutput(g, { elapsedMs = 0, prepareMs = 0, command = '', note = '', mapPath = x => x, maxChars = 16000 } = {}) {
  const parts = []
  const code = g.outcome?.exitCode
  const bad = g.reason !== 'exit' || code !== 0 || g.ok === false
  if (bad) {
    const label = g.reason === 'timeout' ? '命令到达截止时间，已请求终止并等待收尾。'
      : g.reason === 'cancelled' ? '调用已取消，已请求终止并等待收尾。'
      : g.reason === 'spawn-error' ? '命令启动失败：' + (g.spawnError || '未知启动错误')
      : '命令结束：退出码 ' + String(code) + '。'
    parts.push('【发生了什么】' + label)
  }
  if (g.ok === false) parts.push('[收尾未确认完成，请勿把这次结果当作干净结束]')
  if (g.diagnostics?.cleanup?.releaseError) parts.push('[资源释放失败：' + g.diagnostics.cleanup.releaseError + ']')
  if (g.reason !== 'exit' && g.diagnostics?.orphanCheck?.status === 'not-evaluated') parts.push('[收尾观测：' + g.diagnostics.orphanCheck.note + ']')
  for (const name of ['stdout', 'stderr']) {
    const stream = g.streams?.[name] || {}
    const text = String(stream.text || '')
    const truncated = stream.truncated || text.length > maxChars
    if (truncated) parts.push('[' + name + ' 输出已截断：保留末尾 ' + maxChars + ' 字符；完整输出' + (stream.spillPath ? '：' + mapPath(stream.spillPath) : '路径不可用') + ']')
    if (text) parts.push((name === 'stderr' ? '[stderr]\n' : '') + text.slice(-maxChars))
    if (stream.encoding?.status && !['clean', 'utf8', 'valid-utf8', 'not-evaluated', 'ascii'].includes(stream.encoding.status)) {
      parts.push('[' + name + ' 编码诊断：' + stream.encoding.status + '，解码结果可能含替换字符]')
    }
  }
  parts.push('[调用耗时 ' + (elapsedMs / 1000).toFixed(2) + 's；准备 ' + (prepareMs / 1000).toFixed(2) + 's；执行与收尾 ' + (Math.max(0, elapsedMs - prepareMs) / 1000).toFixed(2) + 's]')
  if (note) parts.push(note)
  // The client parser requires the marker to be LAST, after every diagnostic note.
  if (g.outcome?.signal) parts.push('[killed by signal: ' + g.outcome.signal + ']')
  else if (typeof code === 'number') parts.push('[exit code: ' + code + ']')
  return parts.join('\n')
}
