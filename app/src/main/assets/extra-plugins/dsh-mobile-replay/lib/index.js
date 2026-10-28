// dsh-mobile-replay 服务端半端：**无 host 行为**。
// 两个上游插件的本地重放都是纯浏览器端的东西（CSS 样式表 + 一个 DOM 属性标记），
// 因此这一半只提供一个空 cordis 插件，让 bundle patch 能按 id 插入一行。
export const name = 'dsh-mobile-replay'

export function apply() {
  // 故意留空：样式与标记由 ./client（浏览器半端）注入。
}
