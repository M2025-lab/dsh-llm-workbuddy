/**
 * WorkBuddy 凭据：两种认证方式与生命周期管理。
 *
 * 方式一 API Key —— 用户在 WorkBuddy 后台签发的静态 Key，不刷新。
 * 方式二 登录令牌 —— 复用 WorkBuddy 账号授权，拿到 accessToken +
 * refreshToken，过期前自动续期。这就是「用令牌登录」。
 *
 * 凭据落盘在 `~/.dsh/workbuddy-credential.json`（0600），与 dsh 自己的
 * `.credentials.yaml` 分开，避免两个系统互相覆盖。
 *
 * @module dsh-llm-workbuddy/auth
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  baseHeaders,
  NO_ACCOUNT_HEADERS,
  NO_ID_HEADERS,
  PLUGIN_BASE,
} from './protocol.js'

/** 距过期多少毫秒就提前续期。 */
const REFRESH_SKEW_MS = 60_000

/** 登录轮询总时长上限。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000

/** 凭据文件路径。 */
export function credentialPath() {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'workbuddy-credential.json')
}

/** dsh 自己的凭据服务文件。 */
export function dshCredentialsPath() {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * 读取 dsh 凭据服务里已有的 WorkBuddy 登录会话。
 *
 * 如果用户之前用别的插件登过 WorkBuddy，会话就躺在 dsh 的凭据文件里。
 * 直接复用能省掉一次浏览器授权——这是「令牌登录」最省事的形态。
 *
 * yaml 是可选依赖：装不上就跳过这条路，不影响 API Key 与自带登录。
 *
 * @returns {Promise<{ key: string, kind: 'token', source: string, credential: object } | undefined>}
 */
export async function readDshSession() {
  const file = dshCredentialsPath()
  if (!existsSync(file)) return undefined
  let parse
  try {
    ({ parse } = await import('yaml'))
  } catch {
    return undefined
  }
  try {
    const doc = parse(readFileSync(file, 'utf8'))
    const raw = doc?.refs?.WORKBUDDY_LOGIN_SESSION
    if (!raw) return undefined
    const session = typeof raw === 'string' ? JSON.parse(raw) : raw
    const auth = session?.auth
    if (!auth?.accessToken) return undefined
    if (Number.isFinite(auth.expiresAt) && auth.expiresAt <= Date.now()) return undefined
    return {
      key: auth.accessToken,
      kind: 'token',
      source: `dsh-credentials:${file}`,
      credential: {
        kind: 'token',
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresAt: auth.expiresAt,
        userId: session?.account?.userId,
        accountName: session?.account?.displayName,
      },
    }
  } catch {
    return undefined
  }
}

/** 读取落盘凭据；不存在或损坏时返回 undefined。 */
export function readCredential() {
  const file = credentialPath()
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 以 0600 权限写入凭据文件。 */
export function writeCredential(credential) {
  const file = credentialPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // 文件系统不支持时忽略：内容本身仍受目录权限保护。
  }
  return file
}

/** 把服务端返回的 expiresIn 折算成绝对时间戳。 */
function withExpiry(payload, now = Date.now()) {
  const result = { ...payload }
  if (!result.expiresAt && Number.isFinite(result.expiresIn)) {
    result.expiresAt = now + result.expiresIn * 1000
  }
  return result
}

/** 带超时的 JSON 请求；非 2xx 或 code!==0 抛出可读错误。 */
async function requestJson(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 20_000 } = {}) {
  const composite = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, {
    method,
    headers: { ...baseHeaders(), ...headers },
    ...body === undefined ? {} : { body },
    signal: signal === undefined ? composite : AbortSignal.any([signal, composite]),
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${url} 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    throw new Error(`${url} 请求失败（HTTP ${response.status}）：${payload?.msg ?? payload?.message ?? text.slice(0, 200)}`)
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(`${url} 业务错误（code ${payload.code}）：${payload.msg ?? payload.message ?? '未知'}`)
  }
  return payload?.data ?? payload
}

/** 等一段时间，可被 signal 打断。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }, { once: true })
  })
}

/**
 * 轮询一个端点到成功。
 * @param {string} url - 绝对地址。
 * @param {Record<string,string>} headers - 每次轮询携带的请求头。
 * @param {string} action - 出现在错误信息里的动作名。
 * @param {AbortSignal} [signal] - 取消信号。
 */
async function poll(url, headers, action, signal) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    await delay(1000, signal)
    try {
      return await requestJson(url, { headers, signal })
    } catch (error) {
      last = error
      if (signal?.aborted) throw new Error(`${action}已取消`, { cause: error })
      // 401/403 表示这次授权确实被拒，继续轮询没有意义。
      if (/HTTP 40[13]/.test(error.message)) throw error
    }
  }
  throw new Error(`${action}超时${last ? `（最后一次：${last.message}）` : ''}`)
}

/** 用系统默认浏览器打开授权页。 */
export function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

/**
 * 走 WorkBuddy 账号授权，换取令牌。
 *
 * 流程（实测）：创建登录会话 → 打开 authUrl 让用户确认 → 轮询令牌 →
 * 拉账号资料。全程走 `/v2/plugin`，与桌面端插件登录同一条链路。
 *
 * @param {{ onAuthUrl?: (url: string, opened: boolean) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<object>} 可直接落盘的凭据对象。
 */
export async function login({ onAuthUrl, signal } = {}) {
  const state = await requestJson(`${PLUGIN_BASE}/auth/state?platform=CLI`, {
    method: 'POST',
    headers: NO_ACCOUNT_HEADERS,
    body: '{}',
    signal,
  })
  if (!state?.state || !state?.authUrl) {
    throw new Error('WorkBuddy 登录接口没有返回登录地址')
  }

  let opened = false
  try {
    await openBrowser(state.authUrl)
    opened = true
  } catch {
    opened = false
  }
  onAuthUrl?.(state.authUrl, opened)

  const auth = withExpiry(await poll(
    `${PLUGIN_BASE}/auth/token?state=${encodeURIComponent(state.state)}`,
    NO_ACCOUNT_HEADERS,
    '等待 WorkBuddy 授权',
    signal,
  ))
  if (!auth?.accessToken || !auth?.refreshToken) {
    throw new Error('WorkBuddy 登录接口没有返回完整令牌')
  }

  let account = {}
  try {
    account = await poll(
      `${PLUGIN_BASE}/login/account?state=${encodeURIComponent(state.state)}`,
      { ...authHeadersQuiet(auth.accessToken), ...NO_ID_HEADERS },
      '获取 WorkBuddy 账号',
      signal,
    ) ?? {}
  } catch {
    // 账号资料只用于展示；拿不到不影响推理。
  }

  return {
    kind: 'token',
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAt: auth.expiresAt,
    userId: account?.userId ?? auth.userId,
    accountName: account?.name ?? account?.nickname ?? account?.userName,
    createdAt: new Date().toISOString(),
  }
}

/** 避免循环依赖的本地小工具：只取 Authorization。 */
function authHeadersQuiet(token) {
  return { authorization: `Bearer ${token}` }
}

/**
 * 刷新登录令牌。
 * @param {object} credential - 含 refreshToken 的凭据。
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} 合并后的新凭据。
 */
export async function refreshCredential(credential, signal) {
  if (!credential?.refreshToken) {
    throw new Error('凭据没有 refreshToken，无法自动续期；请重新登录')
  }
  const fresh = withExpiry(await requestJson(`${PLUGIN_BASE}/auth/token/refresh`, {
    method: 'POST',
    headers: {
      'X-Refresh-Token': credential.refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
    },
    body: '{}',
    signal,
  }))
  if (!fresh?.accessToken) {
    throw new Error('WorkBuddy 刷新接口没有返回访问令牌')
  }
  return {
    ...credential,
    kind: 'token',
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken ?? credential.refreshToken,
    expiresAt: fresh.expiresAt ?? credential.expiresAt,
    refreshedAt: new Date().toISOString(),
  }
}

/**
 * 判断令牌是否该续期。
 * @param {object} credential
 */
export function needsRefresh(credential) {
  if (credential?.kind !== 'token') return false
  if (!Number.isFinite(credential.expiresAt)) return false
  return credential.expiresAt - Date.now() <= REFRESH_SKEW_MS
}

/**
 * 解析出本次请求可用的凭据。
 *
 * 优先级：显式配置 > 环境变量 > 落盘凭据。返回的 `key` 直接进鉴权头，
 * `source` 用于诊断信息（永远不含密钥本身）。
 *
 * @param {{ apiKey?: string, accessToken?: string, apiKeyEnv?: string }} config
 * @returns {Promise<{ key: string, kind: 'api-key'|'token', source: string, credential?: object }>}
 */
export async function resolveCredential(config = {}) {
  const apiKeyEnv = config.apiKeyEnv?.trim() || 'WORKBUDDY_API_KEY'

  if (config.apiKey?.trim()) {
    return { key: config.apiKey.trim(), kind: 'api-key', source: 'plugin-config' }
  }
  const envKey = process.env[apiKeyEnv]?.trim()
  if (envKey) {
    return { key: envKey, kind: 'api-key', source: `env:${apiKeyEnv}` }
  }
  const envToken = process.env.WORKBUDDY_ACCESS_TOKEN?.trim()
  if (envToken) {
    return { key: envToken, kind: 'token', source: 'env:WORKBUDDY_ACCESS_TOKEN' }
  }
  if (config.accessToken?.trim()) {
    return { key: config.accessToken.trim(), kind: 'token', source: 'plugin-config' }
  }

  const stored = readCredential()
  if (stored) {
    if (stored.kind === 'api-key' && stored.apiKey) {
      return { key: stored.apiKey, kind: 'api-key', source: `file:${credentialPath()}`, credential: stored }
    }
    if (stored.accessToken) {
      if (!needsRefresh(stored)) {
        return { key: stored.accessToken, kind: 'token', source: `file:${credentialPath()}`, credential: stored }
      }
      const refreshed = await refreshCredential(stored)
      writeCredential(refreshed)
      return { key: refreshed.accessToken, kind: 'token', source: 'file:refreshed', credential: refreshed }
    }
  }

  // 最后一招：复用 dsh 凭据服务里已有的 WorkBuddy 登录会话。
  const fromDsh = await readDshSession()
  if (fromDsh) return fromDsh

  throw new Error(
    `没有可用的 WorkBuddy 凭据。任选一种：\n`
    + `  1) 运行 npx dsh-workbuddy-login login 用 WorkBuddy 账号授权（令牌登录）\n`
    + `  2) 设置环境变量 ${apiKeyEnv}=<API Key>\n`
    + `  3) 在插件配置里写 apiKey`,
  )
}
