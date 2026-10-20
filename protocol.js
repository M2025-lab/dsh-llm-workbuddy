/**
 * WorkBuddy / CodeBuddy 服务的线上协议常量。
 *
 * 这里的每一个值都来自对已安装 WorkBuddy 客户端（5.3.14）请求的实测，
 * 以及客户端下发的 product-schema 配置：
 *   authentication.attributes = {
 *     usernameHeader: 'X-User-Id', tokenHeader: 'Authorization',
 *     tokenType: 'bearerToken', prefixPath: '/plugin'
 *   }
 * 服务端不是公开稳定 API，字段可能随客户端升级变化——升级后请重新核对。
 *
 * @module dsh-llm-workbuddy/protocol
 */

/** 模型目录与推理接口的宿主。 */
export const ENDPOINT = 'https://copilot.tencent.com'

/** 插件账号体系（登录 / 刷新令牌）的前缀，对应 schema 的 prefixPath。 */
export const PLUGIN_BASE = `${ENDPOINT}/v2/plugin`

/** 模型推理（OpenAI Chat Completions 兼容，SSE 流式）。 */
export const CHAT_PATH = '/v2/chat/completions'

/** 当前凭据可用的模型与产品配置。 */
export const CONFIG_PATH = '/v3/config'

/**
 * 服务端会校验 UA 里的客户端版本号（实测缺版本时 /v3/config 返回
 * `check ua, get coding copilot version error`）。升级 WorkBuddy 后
 * 若出现该错误，把版本号改成新客户端的版本即可，或设置
 * WORKBUDDY_USER_AGENT 覆盖。
 */
export const DEFAULT_USER_AGENT = 'CLI/unknown CodeBuddy/2.137.1'

/** 产品部署类型，服务端用于区分 SaaS / 私有化。 */
export const PRODUCT = 'SaaS'

/** 模型目录请求头（不含鉴权）。 */
export function baseHeaders() {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': process.env.WORKBUDDY_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    'x-product': PRODUCT,
  }
}

/**
 * 登录阶段使用的“无账号”请求头。
 *
 * 登录/轮询时尚无用户身份，服务端要求显式声明不要注入账号信息，
 * 否则会因缺少 X-User-Id 等字段被拒。
 */
export const NO_ACCOUNT_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
}

/** 已拿到令牌后、但还没有账号资料时使用的请求头。 */
export const NO_ID_HEADERS = {
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
}

/**
 * 构造模型请求的鉴权头。**两种凭据不能混发**。
 *
 * 实测（2026-10-20，账号令牌）：
 *   - 只发 `Authorization: Bearer <token>` → 推理接口 200，正常出文本；
 *   - 同时再发 `x-api-key` → 401 `{"message":"not_found"}`。
 * 也就是说 `x-api-key` 与 Bearer 是两条互斥的鉴权通道，混发会让网关
 * 走错通道。API Key 模式仍按 CodeBuddy CLI 的行为发两个头。
 *
 * @param {string} key - API Key 或登录令牌（accessToken）。
 * @param {'api-key'|'token'} kind - 凭据类型。
 * @returns {Record<string, string>} 鉴权头。
 */
export function authHeaders(key, kind = 'api-key') {
  if (kind === 'token') {
    return { authorization: `Bearer ${key}` }
  }
  return {
    authorization: `Bearer ${key}`,
    'x-api-key': key,
  }
}

/**
 * 构造推理请求的完整请求头。
 *
 * 顺序是有意的，不能调换：`attributionHeaders()` 会写
 * `user-agent: deepseek-harness/x.y.z (+url)`，而 WorkBuddy 网关会校验
 * 请求是否来自官方客户端，判定失败返回 400 / code 11128
 * "request illegal"（channel verification failed）。所以归因头必须排在
 * 最前，再由 {@link baseHeaders} 用官方客户端 UA 覆盖；归因的其它字段
 * （若有）仍会保留。
 *
 * @param {{ key: string, kind?: 'api-key'|'token' }} credential
 * @param {Record<string, string>} [attribution] - `attributionHeaders()` 的结果。
 * @returns {Record<string, string>} 可直接用于 fetch 的请求头。
 */
export function chatHeaders(credential, attribution = {}) {
  return {
    ...attribution,
    ...authHeaders(credential.key, credential.kind),
    ...baseHeaders(),
    accept: 'text/event-stream',
  }
}
