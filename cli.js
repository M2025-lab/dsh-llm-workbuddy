#!/usr/bin/env node
/**
 * 命令行：WorkBuddy 登录与自检。
 *
 * 全部命令都不依赖 dsh 运行时，可单独跑：
 *   node cli.js login     用 WorkBuddy 账号授权（令牌方式登录）
 *   node cli.js status    查看当前凭据
 *   node cli.js models    列出当前凭据可用的模型
 *   node cli.js test      发一个最小推理请求验证链路
 *
 * @module dsh-llm-workbuddy/cli
 */

import { existsSync, unlinkSync } from 'node:fs'
import { login, credentialPath, readCredential, refreshCredential, resolveCredential, writeCredential } from './auth.js'
import { fetchCatalog } from './discovery.js'
import { authHeaders, baseHeaders, CHAT_PATH, ENDPOINT } from './protocol.js'

const USAGE = `用法：dsh-workbuddy-login <命令>

  login     用 WorkBuddy 账号授权，拿登录令牌（浏览器授权，自动续期）
  status    查看当前使用的凭据来源
  models    列出当前凭据可用的模型
  test      发一个最小推理请求，验证端到端链路
  logout    删除本地凭据文件
`

/** 打印到标准错误并退出。 */
function fail(message) {
  console.error(`\n错误：${message}\n`)
  process.exitCode = 1
}

/** 登录。 */
async function commandLogin() {
  console.log('正在创建 WorkBuddy 登录会话...\n')
  const credential = await login({
    onAuthUrl: (url, opened) => {
      if (opened) {
        console.log('已在浏览器打开授权页，请在页面里确认登录。')
      } else {
        console.log('没能自动打开浏览器，请手动访问：')
      }
      console.log(`\n  ${url}\n`)
      console.log('等待授权中（最多 10 分钟）...')
    },
  })
  const file = writeCredential(credential)
  const expires = Number.isFinite(credential.expiresAt)
    ? new Date(credential.expiresAt).toLocaleString('zh-CN')
    : '未知'
  console.log(`\n登录成功。`)
  console.log(`  账号：${credential.accountName ?? credential.userId ?? '（未返回）'}`)
  console.log(`  令牌到期：${expires}（过期前自动续期）`)
  console.log(`  凭据文件：${file}`)
  console.log('\n接下来在 dsh 里选择 WorkBuddy 的模型即可。')
}

/** 状态。 */
async function commandStatus() {
  const stored = readCredential()
  console.log(`凭据文件：${credentialPath()} ${existsSync(credentialPath()) ? '（存在）' : '（不存在）'}`)
  if (!stored) {
    console.log('尚未登录。运行 `dsh-workbuddy-login login` 授权，或设置 WORKBUDDY_API_KEY。')
    return
  }
  console.log(`  类型：${stored.kind === 'token' ? '登录令牌' : 'API Key'}`)
  if (stored.kind === 'token') {
    console.log(`  账号：${stored.accountName ?? stored.userId ?? '（未返回）'}`)
    console.log(`  到期：${Number.isFinite(stored.expiresAt) ? new Date(stored.expiresAt).toLocaleString('zh-CN') : '未知'}`)
    console.log(`  续期：${stored.refreshToken ? '可用（refreshToken 已保存）' : '不可用（缺少 refreshToken）'}`)
  }
  try {
    const resolved = await resolveCredential({})
    console.log(`  本次生效来源：${resolved.source}`)
  } catch (error) {
    fail(error.message)
  }
}

/** 列模型。 */
async function commandModels() {
  try {
    const resolved = await resolveCredential({})
    console.log(`凭据来源：${resolved.source}\n`)
    const models = await fetchCatalog(resolved.key, { kind: resolved.kind })
    console.table(models.map((model) => ({
      id: model.id,
      name: model.name,
      上下文: model.contextWindow,
      最大输出: model.maxTokens,
      推理: model.supportsReasoning ? (model.onlyReasoning ? '强制' : '支持') : '不支持',
      默认档位: model.defaultReasoningEffort ?? '-',
    })))
    console.log(`共 ${models.length} 个模型。`)
  } catch (error) {
    fail(error.message)
  }
}

/** 最小推理自检。 */
async function commandTest() {
  let resolved
  try {
    resolved = await resolveCredential({})
  } catch (error) {
    return fail(error.message)
  }
  console.log(`凭据来源：${resolved.source}`)

  let models
  try {
    models = await fetchCatalog(resolved.key, { kind: resolved.kind })
  } catch (error) {
    return fail(`拉模型目录失败：${error.message}`)
  }
  const model = process.argv[3] || models[0].id
  console.log(`使用模型：${model}\n`)

  const started = Date.now()
  let response
  try {
    response = await fetch(`${ENDPOINT}${CHAT_PATH}`, {
      method: 'POST',
      headers: {
        ...baseHeaders(),
        ...authHeaders(resolved.key, resolved.kind),
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '请只回复：连接成功' }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    return fail(`连接失败：${error.message}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return fail(`HTTP ${response.status}：${detail.slice(0, 400)}`)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let thought = ''
  let firstByte

  for await (const chunk of response.body) {
    firstByte ??= Date.now() - started
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.search(/\r?\n\r?\n/)
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2))
      boundary = buffer.search(/\r?\n\r?\n/)
      const data = event.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      const delta = payload.choices?.[0]?.delta ?? {}
      if (typeof delta.content === 'string') {
        answer += delta.content
        process.stdout.write(delta.content)
      }
      const t = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text
      if (typeof t === 'string') thought += t
      if (payload.usage) {
        console.log(`\n\n用量：输入 ${payload.usage.prompt_tokens} / 输出 ${payload.usage.completion_tokens}`)
      }
    }
  }

  console.log(`\n\n首字节：${firstByte ?? '-'}ms  总耗时：${Date.now() - started}ms`)
  if (thought !== '') console.log(`思考内容长度：${thought.length}`)
  if (answer === '') {
    return fail('链路通了，但没有收到任何回答文本')
  }
  console.log('链路正常。')
}

/** 退出登录。 */
function commandLogout() {
  const file = credentialPath()
  if (!existsSync(file)) {
    console.log('本地没有凭据文件，无需退出。')
    return
  }
  unlinkSync(file)
  console.log(`已删除 ${file}`)
  console.log('注意：已签发的令牌在服务端仍然有效，需要的话去 WorkBuddy 账号页撤销。')
}

/** 令牌续期自检。 */
async function commandRefresh() {
  try {
    const stored = readCredential()
    if (!stored?.refreshToken) return fail('本地没有可续期的登录令牌')
    const fresh = await refreshCredential(stored)
    writeCredential(fresh)
    console.log(`续期成功，新到期时间：${Number.isFinite(fresh.expiresAt) ? new Date(fresh.expiresAt).toLocaleString('zh-CN') : '未知'}`)
  } catch (error) {
    fail(error.message)
  }
}

const commands = {
  login: commandLogin,
  status: commandStatus,
  models: commandModels,
  test: commandTest,
  logout: commandLogout,
  refresh: commandRefresh,
}

const command = process.argv[2]
if (!command || command === '-h' || command === '--help') {
  console.log(USAGE)
} else if (!commands[command]) {
  console.error(`未知命令：${command}\n`)
  console.log(USAGE)
  process.exitCode = 1
} else {
  await commands[command]()
}
