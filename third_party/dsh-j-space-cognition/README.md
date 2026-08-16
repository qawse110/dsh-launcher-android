# dsh-j-space-cognition

将 [Tiger3807861189/J-Space-Cognition-Suite-V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)
制作为 DeepSeek Harness Skill 插件。

- Skill 名称：`j-space`
- 通过 `ctx.skills.registerProvider()` 注册 bundled skill provider。
- `skills/j-space/` 完整保留上游入口、modules、references、scripts。
- 零运行时依赖，无外部请求；SKILL.md 按需懒加载。

## 安装

```sh
pnpm dsh plugin --profile web add third_party/dsh-j-space-cognition
```

## 许可

Apache License 2.0（上游仓库许可）。