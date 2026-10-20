/**
 * 模型目录发现：把 `/v3/config` 的响应收敛成本插件自己的模型清单。
 *
 * 关键点（实测）：`data.models` 是全平台目录，**不是**当前 Key 的授权结果。
 * 真正可用的模型是 `data.agents[name=cli].models` —— 这是按凭据签发的
 * 白名单。把全量 models 直接暴露出去，用户选中了没授权的模型，请求阶段
 * 才会被服务端拒绝，体验更差。
 *
 * @module dsh-llm-workbuddy/discovery
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { authHeaders, baseHeaders, CONFIG_PATH, ENDPOINT } from './protocol.js'

/** 目录缓存有效期：凭据权限可能在后台被调整，不宜缓存太久。 */
const CACHE_TTL_MS = 10 * 60_000

/** 目录缓存路径。 */
export function catalogCachePath() {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'workbuddy-models.json')
}

/**
 * 凭据指纹：缓存按凭据隔离，避免 A 账号的模型出现在 B 账号下。
 * 用 SHA-256 前 16 位，明文永不落盘。
 */
export function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 把服务端目录条目翻译成插件内部结构。 */
function toModel(entry) {
  const contextWindow = entry?.maxInputTokens ?? entry?.maxAllowedSize
  const maxTokens = entry?.maxOutputTokens
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens)) return undefined
  return {
    id: entry.id,
    name: entry.name || entry.id,
    contextWindow,
    maxTokens,
    supportsImages: entry.supportsImages === true,
    supportsReasoning: entry.supportsReasoning === true,
    onlyReasoning: entry.onlyReasoning === true,
    defaultReasoningEffort: entry.reasoning?.effort,
    thinkingLevelMap: entry.thinkingLevelMap,
    thinkingFormat: entry.thinkingFormat,
  }
}

/**
 * 拉取当前凭据可用的模型清单。
 *
 * @param {string} key - API Key 或登录令牌。
 * @param {{ signal?: AbortSignal, timeoutMs?: number, kind?: 'api-key'|'token' }} [options]
 * @returns {Promise<Array<object>>} 按服务端顺序排列的模型。
 */
export async function fetchCatalog(key, { signal, timeoutMs = 20_000, kind = 'api-key' } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(`${ENDPOINT}${CONFIG_PATH}`, {
    headers: { ...baseHeaders(), ...authHeaders(key, kind) },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`模型目录返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    throw new Error(`模型目录请求失败（HTTP ${response.status}）：${body?.msg ?? body?.message ?? text.slice(0, 200)}`)
  }
  if (body?.code !== 0) {
    throw new Error(`模型目录业务错误（code ${body?.code}）：${body?.msg ?? body?.message ?? '未知'}`)
  }

  const data = body?.data ?? {}
  // 不同版本把 agents 放在两处，都兼容。
  const agents = Array.isArray(data.agents) ? data.agents : data?.agent?.agents
  const allowed = agents?.find((agent) => agent?.name === 'cli')?.models
  const catalog = Array.isArray(data.models) ? data.models : []

  // 没有 cli 白名单时退回全量目录：宁可多给，也不要让用户一个模型都看不到。
  const ids = Array.isArray(allowed) && allowed.length > 0
    ? allowed
    : catalog.map((entry) => entry?.id)

  const byId = new Map(catalog.map((entry) => [entry?.id, entry]))
  const models = []
  const seen = new Set()
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue
    const entry = byId.get(id)
    if (!entry) continue
    const model = toModel(entry)
    if (!model) continue
    seen.add(id)
    models.push(model)
  }
  if (models.length === 0) {
    throw new Error('模型目录里没有当前凭据可用的模型（agents[cli].models 为空）')
  }
  return models
}

/** 读取缓存；指纹或结构不符时视为未命中。 */
export function readCatalogCache(key) {
  const file = catalogCachePath()
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.fingerprint !== keyFingerprint(key)) return undefined
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 写入目录缓存（0600）。 */
export function writeCatalogCache(key, models) {
  const file = catalogCachePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const payload = {
      fingerprint: keyFingerprint(key),
      fetchedAt: new Date().toISOString(),
      models,
    }
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // 缓存只是加速，写不进去不影响功能。
  }
}

/**
 * 取目录：优先缓存，过期或强制刷新时回源。
 *
 * @param {string} key - 当前凭据。
 * @param {{ force?: boolean, kind?: 'api-key'|'token' }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function resolveCatalog(key, { force = false, kind = 'api-key' } = {}) {
  if (!force) {
    const cached = readCatalogCache(key)
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
      return cached.models
    }
  }
  const models = await fetchCatalog(key, { kind })
  writeCatalogCache(key, models)
  return models
}
