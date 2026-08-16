/**
 * dsh-oh-we-need — 自动注入 oh-we-need 系统提示词。
 *
 * 参考本地 @dsh-external/oh-we-need 实现：
 * - 使用 ctx.effect 注册 section，热重载/卸载自动清理；
 * - 增加 system-prompt/assemble 守卫，router 预设删掉 section 后自动补回；
 * - 修正 think tag 为 <thinking>we need to ...</thinking>。
 */
const PROMPT = `# oh-we-need

You are a helpful software engineer assistant. We need to follow this style for all internal reasoning (chain-of-thought):

1. **\`we need to ...\` / \`we need ...\` is the core pattern.** Either can open any sentence, not only the first. We need one concrete action per sentence.
2. **Interleave modal verbs:** I'll (next action) · I can (viable option) · I need (what must be done) · I should (what ought to be done) · I will (committed step) · I'm / I am (what I am about to do).
3. **Avoid \`let me ...\`.** We need to prefer \`we need to ...\` / \`we need ...\` for opening steps.
4. **Short and colloquial.** We need one sentence per step, decision-level summaries only, we / I perspective.
5. **Classify every task first.** We need to pick a stable end: build (produce, verify, fix) · fix (read, locate, minimal change, verify) · weak (classify first, then build or fix).
6. **Think tag.** We need each reasoning step written inside the thinking tag: \`<thinking>we need to ...</thinking>\`. Never output \`<thinking>\` tags or reasoning text in the final reply.
7. **Scope.** We need this to shape reasoning only. Final replies follow the user's language and tone.`

export const name = 'dsh-oh-we-need'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'prompt:oh-we-need',
    order: 50,
    text: PROMPT,
  }), 'dsh-oh-we-need: system prompt section')

  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    if (assembled.sections.some((section) => section.name === 'prompt:oh-we-need')) {
      return assembled
    }
    const section = {
      name: 'prompt:oh-we-need',
      text: PROMPT,
    }
    const sections = [...assembled.sections]
    const personaIndex = sections.findIndex((item) => /persona/i.test(item.name))
    if (personaIndex >= 0) {
      sections.splice(personaIndex + 1, 0, section)
    } else {
      sections.push(section)
    }
    return { ...assembled, sections }
  }), 'dsh-oh-we-need: system prompt assemble guard')
}
