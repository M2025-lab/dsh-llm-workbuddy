/**
 * dsh 插件入口：把 WorkBuddy 注册成一个 LLM provider 路由。
 *
 * 用法（两选一）：
 *   1) 令牌登录：`npx dsh-workbuddy-login` → 浏览器授权 → 自动续期
 *   2) API Key：设置 `WORKBUDDY_API_KEY`，或在插件配置里写 apiKey
 *
 * @module dsh-llm-workbuddy
 */

import z from '@deepseek-ai/schemastery'
import { WorkBuddyAdapter } from './adapter.js'
import { resolveCredential } from './auth.js'
import { resolveCatalog } from './discovery.js'

export { WorkBuddyAdapter, toWireMessages } from './adapter.js'
export {
  credentialPath,
  login,
  readCredential,
  refreshCredential,
  resolveCredential,
  writeCredential,
} from './auth.js'
export { fetchCatalog, keyFingerprint, resolveCatalog } from './discovery.js'

export const name = 'llm-workbuddy'

/** 依赖 dsh 的 LLM 注册表。 */
export const inject = ['llm']

/** 默认 provider 路由名。与第三方同名插件区分开，避免路由冲突。 */
export const DEFAULT_PROVIDER_ID = 'workbuddy'

/** 插件配置。 */
export const Config = z.object({
  /** provider 路由名，会出现在模型选择器里；注册后不可变更。 */
  providerId: z.string().default(DEFAULT_PROVIDER_ID),
  /** 直接从环境变量取 API Key 时使用的变量名。 */
  apiKeyEnv: z.string().role('credential-ref').default('WORKBUDDY_API_KEY'),
  /** 直接写在配置里的 API Key（优先级最高，建议改用环境变量或登录）。 */
  apiKey: z.string(),
  /** 直接写在配置里的登录令牌（accessToken）。 */
  accessToken: z.string(),
  /**
   * 手动指定模型清单。留空则按当前凭据从 `/v3/config` 自动发现；
   * 自动发现失败时也会退回这里。
   */
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
    supportsReasoning: z.boolean(),
    onlyReasoning: z.boolean(),
    defaultReasoningEffort: z.string(),
  })),
})

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const providerId = settings.providerId?.trim() || DEFAULT_PROVIDER_ID

  /** 目录缓存：一次进程内复用，避免每个请求都打 /v3/config。 */
  let cachedModels
  let inflight

  const manualModels = Array.isArray(settings.models) && settings.models.length > 0
    ? settings.models
    : undefined

  async function resolveModels() {
    if (manualModels) return manualModels
    if (cachedModels) return cachedModels
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const credential = await resolveCredential(settings)
        const models = await resolveCatalog(credential.key, { kind: credential.kind })
        cachedModels = models
        return models
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  const adapter = new WorkBuddyAdapter({
    providerId,
    resolveCredential: () => resolveCredential(settings),
    resolveModels,
    get models() {
      return cachedModels ?? manualModels
    },
  })

  // listModels/resolveModel 是 advisory：目录拉不到时不应该让注册失败，
  // 也不应该让整个会话不可用，所以这里先注册路由，再后台预热目录。
  // 路由的释放由 dsh 的上下文生命周期负责，无需手动挂钩。
  ctx.llm.registerAdapter([providerId], adapter)

  // 后台预热，让模型选择器第一次展开时就有内容。失败只记日志：
  // 没有凭据或网络不通时，dsh 仍应正常启动。
  void resolveModels().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`llm-workbuddy: 模型目录预热失败：${reason}`)
  })
}
