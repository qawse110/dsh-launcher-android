# dsh-oh-we-need

DSH 内置插件：自动把 [scp3500/oh-we-need](https://github.com/scp3500/oh-we-need)
的「we need to ...」提示词注入 DeepSeek Harness 系统提示词。

- 纯提示词层，零运行时依赖。
- 使用 `ctx.systemPrompt.section()` 注册固定 section（order -90），
  位于 harness identity（-100）之后、persona（0）之前。
- 静态文本、顺序靠前，不引入动态系统提示词变化，保持会话缓存友好。
- 只对 DeepSeek V4 系列（`deepseek-v4-pro` / `deepseek-v4-flash`）设计，
  R1 / V3.x 未验证，其他厂商模型不适用。

## 文件

- `prompt.md` — 上游完整提示词
- `lib/index.js` — 插件 host 实现（内嵌同一段提示词）
- `cordis.patch.yml` — bundle 装配入口

## 许可

MIT（上游 prompt 与 LICENSE 来自 scp3500/oh-we-need）。