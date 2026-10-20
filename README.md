# dsh-llm-workbuddy

把 **WorkBuddy / CodeBuddy** 的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。

自己写的适配器，直接实现 dsh 的 `LlmAdapter` 契约，不依赖 `pi-ai` 的内部 API——dsh 升级小版本不会把插件弄坏。

## 支持两种登录方式

| 方式 | 凭据形态 | 是否自动续期 |
|---|---|---|
| **令牌登录** | WorkBuddy 账号 OAuth 令牌（`accessToken` + `refreshToken`） | 是，过期前 60 秒自动刷新 |
| **API Key** | WorkBuddy 后台签发的静态 Key | 不涉及 |

令牌登录还会**自动复用** dsh 凭据服务里已有的 WorkBuddy 会话（如果你之前用别的插件登过），不必重新授权。

## 安装

```sh
# 1) 装进 dsh 的 desktop profile
cd ~/.dsh/profiles/desktop
pnpm add git+https://github.com/M2025-lab/dsh-llm-workbuddy.git

# 本地开发时改用 file:（改代码即时生效）
# pnpm add file:/path/to/dsh-llm-workbuddy

# 2) 在 profile 的 package.json 里注册 bundle
#    "dsh": { "profile": { "bundles": [ ..., "@mirror/dsh-llm-workbuddy" ] } }

# 3) 重启 dsh
```

> ⚠️ loader entry id 必须全局唯一。如果你的 profile 里已经装了别的 WorkBuddy
> provider 插件（例如 `@axiaohungry/dsh-llm-workbuddy`），它可能已经占用了
> `llm-workbuddy` 这个 id，这时 dsh 会因 `duplicate loader entry id` 拒绝启动。
> 本插件的 `cordis.patch.yml` 用 `llm-workbuddy-mirror` 避开了这个冲突。

## 用法

```sh
# 令牌登录（打开浏览器授权，拿令牌并落盘）
node cli.js login

# 查看当前凭据从哪来
node cli.js status

# 列出当前凭据可用的模型
node cli.js models

# 发一个最小请求验证链路
node cli.js test [模型ID]

# 手动触发续期
node cli.js refresh

# 删除本地凭据
node cli.js logout
```

凭据优先级（从高到低）：

1. 插件配置里的 `apiKey` / `accessToken`
2. 环境变量 `WORKBUDDY_API_KEY`（变量名可用 `apiKeyEnv` 改）/ `WORKBUDDY_ACCESS_TOKEN`
3. 本插件落盘的 `~/.dsh/workbuddy-credential.json`
4. dsh 凭据服务里的 `WORKBUDDY_LOGIN_SESSION`

## 配置

```yaml
llm-workbuddy:
  providerId: workbuddy          # 模型选择器里显示的路由名
  apiKeyEnv: WORKBUDDY_API_KEY
  # apiKey: sk-xxx              # 也可以直接写，但建议用环境变量
  # models:                     # 留空则从 /v3/config 自动发现
  #   - id: deepseek-v4.1-flash
  #     name: DeepSeek V4.1 Flash
  #     contextWindow: 1000000
  #     maxTokens: 128000
  #     supportsReasoning: true
```

## 协议实测记录

以下都是在 2026-10-20 用本机账号实测的结论，不是照抄文档：

| 现象 | 结论 |
|---|---|
| `GET /v3/config` + 只发 `Authorization: Bearer <token>` | 200，返回 20 个模型 |
| `POST /v2/chat/completions` + **同时发** `Authorization` 和 `x-api-key` | 401 `{"message":"not_found"}` |
| `POST /v2/chat/completions` + **只发** `Authorization` + `stream: false` | 400 `code 11101 Non-stream chat request is currently not supported` |
| `POST /v2/chat/completions` + **只发** `Authorization` + `stream: true` | **200，正常出文本**（首块 1ms，总 220ms） |
| 缺版本号的 User-Agent 请求 `/v3/config` | 400 `check ua, get coding copilot version error` |

**两条最容易踩的坑**：

1. `Authorization` 和 `x-api-key` 是**互斥**的两条鉴权通道。令牌模式下混发 `x-api-key` 会让网关走错通道，直接 401。API Key 模式下两个都发（对齐 CodeBuddy CLI 行为）。
2. 服务端**不支持非流式**请求，`stream` 必须为 `true`。

模型清单要从 `data.agents[name=cli].models` 取，不是 `data.models`——后者是全平台目录，拿它去请求会因没授权被拒。

## 已知限制

- **图片输入不支持**。WorkBuddy 部分模型支持图片，但适配器层拿不到附件字节，所以声明为纯文本。附件图片会在发送前被 dsh 拦下并点名该模型。
- **User-Agent 带版本号**。服务端会校验，WorkBuddy 升级后如果报 `check ua` 错误，用 `WORKBUDDY_USER_AGENT` 环境变量覆盖成新版本即可。
- **不是公开 API**。路径和字段可能随客户端升级变化。

## 开发

```sh
# 单元测试（不依赖 dsh 运行时）
npm test

# 真实链路自检（需要可用凭据）
npm run test:live
```

`stream.js` 里是纯协议逻辑（消息翻译 + SSE 解析），刻意不 import 任何 dsh 包，所以能脱离 dsh 单独测试。`adapter.js` 只做凭据解析、HTTP 请求和类型包装。

## 许可证

MIT
