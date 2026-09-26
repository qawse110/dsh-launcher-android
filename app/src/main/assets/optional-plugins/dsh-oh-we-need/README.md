# dsh-oh-we-need

DSH 内置 Skill 插件：把 [scp3500/oh-we-need](https://github.com/scp3500/oh-we-need)
的「we need to ...」推理风格制作为可按需调用的 Skill，不再注入系统提示词。

- 通过 `ctx.skills.registerProvider()` 注册 bundled skill provider。
- Skill 名称：`oh-we-need`
- 按需加载：只有模型/用户调用该 skill 时才进入上下文，避免全局提示词污染。
- 零运行时依赖，无外部请求。

## 文件

- `skills/oh-we-need/SKILL.md` — Skill 入口（frontmatter + 完整提示词正文）
- `lib/index.js` — 插件 host 实现（扫描 `skills/` 并懒加载）
- `cordis.patch.yml` — bundle 装配入口

## 许可

MIT（上游 prompt 与 LICENSE 来自 scp3500/oh-we-need）。
