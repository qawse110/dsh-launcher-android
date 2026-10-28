// Both the intercept packet and advisor output instruct the working model to ask.
// Rendering this text does not itself invoke a tool or collect a user answer.
export const ASK_TOOL_NAME = 'ask_user_question'

export function renderAskInstruction(questions, { english = false, questionsOnly = false } = {}) {
  const items = (Array.isArray(questions) ? questions : []).filter(item =>
    item && typeof item.question === 'string' && item.question.trim())
  if (!items.length) return ''
  if (questionsOnly) {
    const heading = english ? '[Ask user (ask_user_question)]' : '【Ask用户(ask_user_question)】'
    const action = english
      ? 'For these questions that need confirmation, call ask_user_question with suitable options you organize yourself; use the answers to decide the related matters.'
      : '对以下确需确认的问题，请调用 ask_user_question，自行组织合适的选项询问用户，再根据答复决定相关事项。'
    return [heading, action, ...items.map((item, i) => (i + 1) + '. ' + item.question.trim())].join('\n')
  }
  const heading = english
    ? 'Ask the user directly with selectable options:'
    : '需要直接通过 ask 选项询问用户：'
  const action = english
    ? 'Working model: call ' + ASK_TOOL_NAME + ' with the questions and options below. Wait for the user’s answers before deciding the related matters.'
    : '请工作模型调用 ' + ASK_TOOL_NAME + '，带上以下问题和选项；收到用户回答后，再决定相关事项。'
  const rows = items.map((item, i) => {
    const options = (Array.isArray(item.options) ? item.options : [])
      .map(option => typeof option === 'string' ? option : option?.label)
      .filter(option => typeof option === 'string' && option.trim())
      .map(option => option.trim())
    return (i + 1) + '. ' + item.question.trim()
      + (options.length ? '\n   ' + (english ? 'Options: ' : '选项：') + options.join(' / ') : '')
  })
  return [heading, action, ...rows].join('\n')
}
