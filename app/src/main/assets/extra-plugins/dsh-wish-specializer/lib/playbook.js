// 0.7.8 · 任务类 playbook（单轮提升 P1）
//
// 为什么需要：多轮机制管的是"后续不漂移"，而用户看到的交付质量几乎全在**单轮**——
// 模型在没有任何反馈的一次机会里，是否知道"什么算做好"。同一类任务反复出现时，
// 它的**结构性分叉**与**常见失败模式**是稳定的；把它们沉淀下来，此后每次首轮都受益。
//
// 边界（必须守住，来自 0.7.1 的教训）：
//   · 按**任务类**触发，不按单个案例生成全局规则（这里是代码，不是提示词堆积）；
//   · 只写"会改变决策"的内容——每条检查项都点名一个真实失败模式，不写通用正确话；
//   · **不是新增要求**：来源是 `project_convention`（不是 human），永远不能升格成 user_requirement；
//   · 宁可漏发，不要错发：识别要求"单文件意图"与"可视化/交互意图"**同时命中**。
//
// 检查项是"完成前自检"，不是"替用户验收"：它只列出该做什么检查，不改变用户的要求。

/** 单文件意图：明确说要做单个 HTML/文件/自足产物。 */
const SINGLE_FILE = /单\s*(个|一)?\s*(html|HTML|文件|页)|一个\s*html|单个\s*html|single\s*file|one\s*file|self-contained/i

/** 可视化/3D 意图：强信号。故意**不收**"模型"——它在插件自身语境里常指会话模型，会误伤。 */
const VISUAL_3D = /3d|three\.?js|webgl|shader|canvas|渲染|可视化|三维|建模/i

/** 预览/操控意图：坦克那条提示词里没有"3d"字样，但明确要求预览与操控。 */
const PREVIEW_CONTROL = /预览|操控|可操作|交互|旋转|缩放|拖拽|拖动|视角|相机/i

/** 任务类表。第一批只做一类，并把阈值写清楚，方便以后按同样形状扩展。 */
export const TASK_CLASSES = Object.freeze([
  Object.freeze({
    id: 'single-file-3d',
    label: '单文件可交互 3D/可视化程序',
    match: (t) => SINGLE_FILE.test(t) && (VISUAL_3D.test(t) || PREVIEW_CONTROL.test(t)),
    checks: Object.freeze([
      '单文件自足：产物是一个 HTML 文件，双击即可打开，不读取同目录其它文件，也不依赖本地资源路径。',
      '首屏可见：打开后无需额外操作就能看到主体，且主体不被裁切、不过曝、不发黑。',
      '交互闭环：预览与操控真的可用（拖动、缩放、旋转至少可用其一），并有可读的操作提示。',
      '外部依赖可失败：若用 CDN 引库，加载失败时页面不能白屏，至少给出可读提示或内联兜底。',
      '性能有界：几何与材质数量设上限，窗口缩放或长时间运行不卡死、不崩。',
    ]),
  }),
])

/** 各补充程度放几条检查项：minimal 只保必要的节，所以一条都不发。 */
export const CHECKS_BY_DETAIL = Object.freeze({ minimal: 0, standard: 3, detailed: 5 })

/**
 * 识别任务类（纯函数）。
 * @returns {{id:string,label:string}|null}
 */
export function detectTaskClass(userText) {
  const t = typeof userText === 'string' ? userText : ''
  if (!t) return null
  for (const c of TASK_CLASSES) {
    try { if (c.match(t)) return { id: c.id, label: c.label } } catch { /* 单条规则坏掉不影响其它类 */ }
  }
  return null
}

/**
 * 产出本轮的检查项条目（纯函数）。
 *
 * 返回的是**可直接进编译器**的条目：kind 为 `acceptance_check`，来源是 `project_convention`。
 * 不是 human 来源 ⇒ 结构上就不可能被当成用户要求（范围审计会挡）。
 *
 * @param userText 本轮用户原话
 * @param opts { detail?: 'minimal'|'standard'|'detailed', sessionId?: string }
 *   `sessionId` **必填**：来源引用要合规（schema 要求 sourceRef.sessionId），
 *   而且拿不到会话就无法归属——宁可这条不发，也不发一条无主的检查项。
 * @returns {Array<object>}
 */
export function playbookItems(userText, opts = {}) {
  const cls = detectTaskClass(userText)
  if (!cls) return []
  const sessionId = (opts.sessionId === undefined || opts.sessionId === null) ? '' : String(opts.sessionId)
  if (!sessionId) return []
  const detail = String(opts.detail || 'standard')
  const n = CHECKS_BY_DETAIL[detail]
  const count = Number.isFinite(n) ? n : CHECKS_BY_DETAIL.standard
  if (count <= 0) return []
  const def = TASK_CLASSES.find((c) => c.id === cls.id)
  const texts = (def && def.checks ? def.checks : []).slice(0, count)
  return texts.map((text, i) => ({
    id: 'pb-' + cls.id + '-' + (i + 1),
    kind: 'acceptance_check',
    text,
    status: 'active',
    scope: 'turn',
    sourceRefs: [{ kind: 'project_convention', sessionId, uri: 'playbook:' + cls.id }],
    rationale: '任务类 ' + cls.id + ' 的已知失败模式（插件内建检查项，不是用户要求）',
  }))
}
