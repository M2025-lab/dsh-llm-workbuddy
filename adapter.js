/**
 * WorkBuddy 的 dsh LLM 适配器。
 *
 * 这里只做三件事：解析凭据、构造 HTTP 请求、把协议层的分片包成 dsh 的
 * 类型。真正的消息翻译与 SSE 解析在 `stream.js`——那部分不依赖 dsh，
 * 可以脱离运行时单独测试。
 *
 * 设计取舍：
 * - 不依赖 pi-ai 的内部 API，只依赖 `@deepseek-ai/dsh-llm` 的公开契约，
 *   这样 dsh 小版本升级不会连带把插件弄坏。
 * - 图片输入声明为不支持。WorkBuddy 部分模型支持图片，但要拿到附件
 *   字节需要 attachment 服务，适配器层拿不到——宁可在附加前被拦，
 *   也不要发出去再被服务端拒绝。
 *
 * @module dsh-llm-workbuddy/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { chatHeaders, CHAT_PATH, ENDPOINT } from './protocol.js'
import { parseWorkBuddyStream, toWireMessages } from './stream.js'

export { toWireMessages } from './stream.js'

/** 建连超时。模型长思考时服务端可能长时间不发字节。 */
const CONNECT_TIMEOUT_MS = 60_000

/** 服务端未给出上限时的兜底输出额度。 */
const DEFAULT_MAX_TOKENS = 32_768

/** 服务端未给出上下文容量时的兜底值。 */
const DEFAULT_CONTEXT_WINDOW = 262_144

/**
 * 把 HTTP 状态映射成稳定错误码，便于上层按码做策略。
 * @param {number} status
 */
function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 408) return 'TIMEOUT'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_HTTP_ERROR'
}

/**
 * WorkBuddy 适配器。一个实例可服务多个 provider 路由。
 */
export class WorkBuddyAdapter extends LlmAdapter {
  /**
   * @param {{
   *   providerId: string,
   *   resolveCredential: () => Promise<{ key: string, kind: string, source: string }>,
   *   resolveModels: () => Promise<Array<object>>,
   * }} config
   */
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: 'WorkBuddy' }
  }

  async listModels(provider) {
    const models = await this.config.resolveModels()
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name || model.id,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const models = await this.config.resolveModels()
    const found = models.find((entry) => entry.id === model)
    const contextWindow = found?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    const defaultMaxTokens = found?.maxTokens ?? DEFAULT_MAX_TOKENS
    const base = {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens,
    }
    if (found?.supportsReasoning !== true) return base

    // onlyReasoning 的模型不提供 off 档；其余给四档，默认取服务端给的值。
    const efforts = found.onlyReasoning === true
      ? ['low', 'medium', 'high']
      : ['off', 'low', 'medium', 'high']
    const preferred = found.defaultReasoningEffort
    const defaultEffort = preferred && efforts.includes(preferred)
      ? preferred
      : (found.onlyReasoning === true ? 'medium' : 'off')
    return {
      ...base,
      reasoning: {
        efforts: efforts.map((id) => ({ id, name: id })),
        defaultEffort,
      },
    }
  }

  async * stream(options) {
    const credential = await this.config.resolveCredential()
    const models = await this.config.resolveModels()
    const model = models.find((entry) => entry.id === options.model)

    const maxTokens = Math.min(
      options.maxTokens ?? model?.maxTokens ?? DEFAULT_MAX_TOKENS,
      model?.maxTokens ?? DEFAULT_MAX_TOKENS,
    )

    const body = {
      model: options.model,
      messages: [
        ...options.system ? [{ role: 'system', content: options.system }] : [],
        ...toWireMessages(options.messages),
      ],
      // 服务端明确拒绝非流式请求（code 11101），只能走流式。
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop },
      ...options.tools === undefined || options.tools.length === 0 ? {} : {
        tools: options.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      },
      // 只在模型确实声明支持推理时发送档位，否则服务端会拒绝未知参数。
      ...model?.supportsReasoning === true
        && options.reasoningEffort !== undefined
        && options.reasoningEffort !== 'off'
        ? { reasoning_effort: options.reasoningEffort }
        : {},
    }

    const connect = AbortSignal.timeout(CONNECT_TIMEOUT_MS)
    let response
    try {
      response = await fetch(`${ENDPOINT}${CHAT_PATH}`, {
        method: 'POST',
        headers: chatHeaders(credential, attributionHeaders()),
        body: JSON.stringify(body),
        signal: options.signal === undefined
          ? connect
          : AbortSignal.any([options.signal, connect]),
      })
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('WorkBuddy 请求已被取消', 'ABORTED', { cause: error })
      }
      throw new LlmError(
        `连接 WorkBuddy 失败（凭据来源 ${credential.source}）`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        `WorkBuddy 推理接口返回 ${response.status}：${detail.slice(0, 300)}`,
        httpErrorCode(response.status),
        { cause: new Error(detail.slice(0, 300)) },
      )
    }
    if (!response.body) {
      throw new LlmError('WorkBuddy 推理接口没有返回响应体', 'MALFORMED_RESPONSE')
    }

    for await (const chunk of parseWorkBuddyStream(response.body)) {
      // 工具调用的 id 在 dsh 里是 branded 类型，这里补一道包装。
      if (chunk.type === 'tool-call-delta') {
        yield { ...chunk, id: ToolCallId(chunk.id) }
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        yield { ...chunk, block: { ...chunk.block, id: ToolCallId(chunk.block.id) } }
      } else {
        yield chunk
      }
    }
  }
}
