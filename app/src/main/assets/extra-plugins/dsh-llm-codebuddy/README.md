# DSH CodeBuddy Provider

为 DeepSeek Harness（DSH）增加 `CodeBuddy 中国区` 和 `CodeBuddy 国际版` 两个
Provider。支持 WorkBuddy API Key 和 CodeBuddy 账号令牌两种认证方式，并可在 DSH
WebUI 中获取、选择和调整模型。

> [!IMPORTANT]
> API Key 由 **WorkBuddy** 提供，本插件使用该 Key 调用供 CodeBuddy 使用的模型服务。
> DSH 中的 Provider 名称仍为 `CodeBuddy 中国区` / `CodeBuddy 国际版`。本项目是
> 第三方适配器，并非 WorkBuddy、CodeBuddy 或 DSH 官方插件。

## 区域

| Provider | 区域 | 模型目录 | 推理/登录后端 |
|---|---|---|---|
| `CodeBuddy 中国区` | 中国站（codebuddy.cn） | `https://copilot.tencent.com/v3/config` | `https://copilot.tencent.com/v2` |
| `CodeBuddy 国际版` | 国际站（codebuddy.ai） | `https://www.codebuddy.ai/v3/config` | `https://www.codebuddy.ai/v2` |

两个区域共享同一套 OpenAI Chat Completions 兼容协议与登录流程，仅后端域名不同，
凭据彼此独立保存（`CODEBUDDY_API_KEY` / `CODEBUDDY_LOGIN_SESSION` 与
`CODEBUDDY_INTL_API_KEY` / `CODEBUDDY_INTL_LOGIN_SESSION`）。

## 功能

- **共存模式**：只新增 CodeBuddy Provider，不禁用、不接管内置 `llm-pi-ai` 适配器；
  DeepSeek 与其他自定义 Provider（`llm-pi-ai.providers.*`）不受任何影响；
- WebUI 中直接添加 `CodeBuddy 中国区` / `CodeBuddy 国际版`；
- 支持从 WorkBuddy 获取的 API Key；
- API Key 输入框旁可显式切换 `API Key` / `令牌登录`；
- 支持从 WebUI 拉起浏览器登录 CodeBuddy 中国站 / 国际站，并自动复用、刷新登录令牌；
- 自动获取 CodeBuddy 当前可用模型；
- 支持编辑模型 ID、名称、上下文窗口和最大输出 Token；
- 支持添加、删除模型以及重新同步模型目录；
- 按模型目录声明各模型自己的思考能力、可选档位和默认档位；
- 输入新 API Key 可替换旧值，留空保存则保留原值；
- 模型接口暂时不可用时使用内置目录兜底；
- **用量查询**：设置页新增「CodeBuddy 用量」页面，读取与 CodeBuddy 个人中心
  「套餐与用量」同源的数据（剩余 / 已用 / 总额度、订阅状态、各资源包明细与周期），
  支持中国区与国际版切换；
- 独立安装，不修改 DSH 全局安装目录。

## 配置命名空间

CodeBuddy 的配置存放在**独立命名空间** `llm-codebuddy`（而非 `llm-pi-ai`），
与内置适配器互不干扰：

```yaml
llm-codebuddy:
  providers:
    codebuddy-cn:   # 删除 apiKeyEnv 键 = 令牌模式
      apiKeyEnv: CODEBUDDY_API_KEY
    codebuddy-intl:
      apiKeyEnv: CODEBUDDY_INTL_API_KEY
```

DSH 运行时依赖（`@deepseek-ai/dsh-*`、`@earendil-works/pi-ai`）通过
peerDependencies 声明，直接复用宿主 Profile 的实例，不产生重复副本。


## 环境要求

- Windows、Linux 或 macOS；
- Node.js `>= 22.19.0`；
- 已安装 DSH；
- 已验证 DSH `0.1.0-rc.6`。

安装器已自带 DSH 所需的 `pnpm`，无需全局安装；令牌登录也不需要安装 CodeBuddy CLI。

> DSH 仍处于预发布阶段。未来版本如果调整插件接口，本插件可能需要同步升级；
> DSH 普通更新不会覆盖本插件。

## 安装

推荐使用一键安装命令：

```powershell
npx --yes dsh-llm-codebuddy@latest install
```

该命令会为 DSH 的 `web` 和 `headless` Profile 安装插件。完成后重启 DSH。

也可以分别安装：

```powershell
dsh plugin --profile web add dsh-llm-codebuddy@latest
dsh plugin --profile headless add dsh-llm-codebuddy@latest
```

只使用 WebUI 时，仅执行第一条即可。

## WebUI 配置

### CodeBuddy 账号令牌登录（新用户推荐）

中国区与国际版分别登录：

| 区域 | Provider | 命令行 |
|---|---|---|
| 中国站 | `CodeBuddy 中国区` | `npx --yes dsh-llm-codebuddy@latest login` |
| 国际站 | `CodeBuddy 国际版` | `npx --yes dsh-llm-codebuddy@latest login-intl` |

WebUI 操作（以中国区为例，国际版同理）：

1. 打开“设置 → 模型”。
2. 添加或编辑 `CodeBuddy 中国区`（或 `CodeBuddy 国际版`）。
3. 点击 API Key 输入框右侧的“令牌登录”。
4. 在自动打开的浏览器中完成对应站点登录（中国站 codebuddy.cn / 国际站 codebuddy.ai）。
5. WebUI 显示“令牌已登录”后即可获取模型并保存自定义目录。

插件会调用 CodeBuddy 官方认证流程。完成登录后，插件会自动把该 Provider 切换为
令牌模式，无需 API Key。点击同一行的“API Key”可以切回 API Key 模式；已经保存的
API Key 不会被删除。两种凭据彼此独立保留，之后再次点击“令牌登录”会优先复用已
保存令牌；仅在没有令牌或主动重新登录时才需要再次打开浏览器。

插件直接调用 CodeBuddy 官方网页登录和令牌刷新接口，不依赖本机
`codebuddy` 命令。访问令牌和刷新令牌保存在 DSH 凭据服务中，不会写入
`settings.yaml` 或模型目录。

### WorkBuddy API Key

1. 打开“设置 → 模型”。
2. 点击“添加提供方”。
3. 选择 `CodeBuddy 中国区` 或 `CodeBuddy 国际版`。
4. 输入从 WorkBuddy 获取的对应区域 API Key 并保存。
5. 点击该 Provider 的“编辑”，展开“自定义设置”。
6. 点击“获取可用模型”，选择需要的模型并导入。
7. 按需修改模型参数，然后保存。

再次编辑已配置的 Provider 时，会直接显示上次保存的模型目录。

## API Key 替换

- 输入新的 API Key 并保存：替换原 Key；
- API Key 输入框留空并保存：保留原 Key；
- 更换 Key 后建议重新点击“获取可用模型”，同步新账号的模型权限。

中国区与国际版的 API Key 互相独立：中国区使用 `CODEBUDDY_API_KEY`，国际版使用
`CODEBUDDY_INTL_API_KEY`。API Key 由 DSH 凭据服务保存，不会写入模型目录或插件源码。

## 用量查询

设置页的「CodeBuddy 用量」页面展示账号的额度情况，可在中国区与国际版之间切换：

- 剩余 / 本周期已用 / 总额度，以及订阅状态（免费版 / 付费版）；
- 各资源包的明细进度条，含包名、剩余额度和周期截止时间。

数据来自 CodeBuddy 计费接口（与个人中心「套餐与用量」页面同源）：

```text
POST /billing/meter/get-user-resource          —— 资源包明细（包名、周期）
POST /billing/meter/get-user-resource-summary  —— 额度汇总
```

读取时复用插件已保存的登录令牌，并在过期前自动续期。

> [!NOTE]
> CodeBuddy 官方口径：用量数据存在 **2-3 小时延迟**，不是实时余额。

> [!IMPORTANT]
> 该页面只做**只读**查询，不提供领取礼包、领取补偿或任何扣费操作。

## 模型配置

- 没有自定义目录：使用 CodeBuddy 在线目录，失败时使用内置目录；
- 保存自定义目录：仅向 DSH 提供目录中保留的模型；
- 已知模型字段留空：继承在线目录或内置目录中的值；
- 新模型缺少容量：上下文窗口默认 `262144`，最大输出默认 `32768`；
- 点击“恢复默认模型”：删除自定义目录并恢复适配器目录。

配置值超过服务端真实限制时，CodeBuddy 仍可能拒绝请求。

## 思考程度

DSH 显示的思考程度来自当前模型自身的能力声明，插件把选中的档位转换为
`reasoning_effort` 并发送给 CodeBuddy。模型推理由 CodeBuddy 云端执行。

```text
off / minimal / low / medium / high / xhigh / max
```

实际显示哪些档位由 `/v3/config` 中该模型的 `supportsReasoning`、`onlyReasoning`、
`thinkingLevelMap` 和 `reasoning.effort` 决定，不能跨模型共用一套固定档位。未手动
选择时，使用 CodeBuddy 为该模型返回的默认档位；服务端没有声明时则不强行指定。

## 更新

重新运行安装命令即可更新到最新版：

```powershell
npx --yes dsh-llm-codebuddy@latest install
```

更新完成后重启 DSH。模型配置和 API Key 不会被覆盖。

## 卸载

```powershell
npx --yes dsh-llm-codebuddy@latest uninstall
```

卸载命令会：

1. 备份 `~/.dsh/settings.yaml`；
2. 只删除 `llm-codebuddy.providers.codebuddy-cn` 和 `llm-codebuddy.providers.codebuddy-intl` 配置；
3. 保留其他 Provider 和 DSH 设置；
4. 从 `web`、`headless` Profile 移除插件；
5. 保留 API Key 和登录令牌凭据，方便以后重新安装。

完成后重启 DSH。备份文件名类似：

```text
settings.yaml.codebuddy-backup-2026-08-14T12-00-00-000Z
```

源码仓库、本地安装包和 API Key 不会被删除。

## 常见问题

### 安装后看不到 CodeBuddy

确认已经重启 DSH，并检查 Web Profile：

```powershell
dsh plugin --profile web list --depth 0
```

### 获取模型失败

确认 API Key 来自 WorkBuddy 且仍然有效，然后重新输入 Key 并点击“获取可用模型”。
接口临时不可用时，插件仍会提供内置模型目录。

### 为什么别人能看到某个模型，我这里看不到

模型权限与 API Key 绑定。插件只导入 `/v3/config` 中 `agents[name=cli].models` 为
当前 Key 返回的模型；更换 Key 后请重新点击“获取可用模型”。插件不会强行显示
当前 Key 未授权的模型。

### 调用时报 `500 status code (no body)`

先更新到最新版并重启 DSH：

```powershell
npx --yes dsh-llm-codebuddy@latest install
```

旧版本可能被 DSH 覆盖 CodeBuddy 请求标识，导致服务端拒绝请求；最新版已在插件请求层
恢复 CodeBuddy 官方标识，同时适用于 API Key 和令牌模式。

### 卸载后仍显示旧页面

关闭正在运行的 DSH，再重新启动。已经运行的进程不会自动卸载内存中的插件。

## 开发文档

需要开发其他 Agent 或 Provider 时，请阅读
[反向代理调用 WorkBuddy API 开发文档](./docs/反向代理调用WorkBuddy-API开发文档.md)。

## 工作原理

```text
WorkBuddy 提供 API Key
          ↓
DSH Agent → 本插件 → CodeBuddy /v2/chat/completions
                    ↘ CodeBuddy /v3/config（获取模型）

CodeBuddy 中国站 / 国际站网页登录 → 本插件保存并刷新 DSH 登录凭据
                                        ↓ 当前 access token
DSH Agent → 本插件 → CodeBuddy API（Authorization: Bearer）
```

- 中国区后端：`https://copilot.tencent.com`；国际版后端：`https://www.codebuddy.ai`。
  两者共享同一套 OpenAI Chat Completions 协议与登录流程，插件按 Provider 选择后端；
- DSH：负责 Agent 循环、上下文、工具调用和权限；
- WorkBuddy：提供 API Key；
- 插件：负责 Provider 注册、模型目录转换和请求兼容；
- CodeBuddy：负责模型推理并返回结果。
<img width="1885" height="853" alt="image" src="https://github.com/user-attachments/assets/eda31b48-8412-414d-b552-1b7ce0a7c3a0" />
<img width="711" height="380" alt="屏幕截图 2026-08-20 145322" src="https://github.com/user-attachments/assets/541197e8-ac87-47f8-b7ca-f74239ca7c0f" />

## License

[MIT](./LICENSE)
