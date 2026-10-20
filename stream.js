/**
 * 纯协议层：WorkBuddy 的 wire 格式 ↔ dsh 的 StreamChunk。
 *
 * 这个文件刻意不 import 任何 dsh 包，只产出符合 dsh 契约的普通对象。
 * 好处是它可以脱离 dsh 运行时被单独测试——dsh 的 `@deepseek-ai/*` 由它
 * 自己的模块 loader 提供，普通 node 环境解析不到。
 *
 * @module dsh-llm-workbuddy/stream
 */

/**
 * 把 harness 消息翻译成 OpenAI Chat Completions 的 messages。
 *
 * `tool-result` 在 dsh 里挂在 user 角色下，转成 OpenAI 时必须拆成独立的
 * `role: 'tool'` 消息，否则服务端认不出调用关联。
 *
 * @param {Array<object>} messages - `GenerateOptions.messages`。
 * @returns {Array<object>} wire messages。
 */
export function toWireMessages(messages) {
  const wire = []
  for (const message of messages ?? []) {
    const blocks = Array.isArray(message?.content) ? message.content : []

    if (message?.role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      const toolCalls = blocks.filter((b) => b?.type === 'tool-call').map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: b.arguments || '{}' },
      }))
      // 既无文本又无工具调用的 assistant 消息对上游无意义，跳过。
      if (text === '' && toolCalls.length === 0) continue
      wire.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
      })
      continue
    }

    const toolResults = blocks.filter((b) => b?.type === 'tool-result')
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        const inner = Array.isArray(block.content) ? block.content : []
        const text = inner.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        wire.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: text === ''
            ? (block.isError === true ? '（工具执行失败，无输出）' : '（无输出）')
            : text,
        })
      }
      // 同一消息里若还夹带文本，作为补充 user 消息继续发。
      const extra = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      if (extra !== '') wire.push({ role: 'user', content: extra })
      continue
    }

    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    if (text !== '') wire.push({ role: 'user', content: text })
  }
  return wire
}

/** 把 wire 的 finish_reason 映射成 harness 的 FinishReason。 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `模型停止原因：${reason}`, code: String(reason).toUpperCase() },
      }
  }
}

/**
 * 把 wire usage 映射成 harness 的 disjoint 计数。
 * OpenAI 风格的 `prompt_tokens` 已包含缓存命中，需要减出来。
 */
export function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  const prompt = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0
  const completion = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0
  return {
    inputTokens: Math.max(0, prompt - (cacheRead ?? 0)),
    outputTokens: completion,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * 解析一个 SSE 事件块，返回其中 data 行拼接后的负载。
 * @param {string} event
 * @returns {string | undefined}
 */
function eventData(event) {
  const parts = []
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).replace(/^ /, ''))
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * 消费 WorkBuddy 的 SSE 字节流，产出 dsh 的 StreamChunk。
 *
 * 分片策略：文本/思考/工具调用增量实时产出（保证 UI 流式），
 * `block-end`、`usage`、`finish` 统一推迟到流结束——这样即使中途出现
 * 空块也不会提前宣告结束。
 *
 * @param {AsyncIterable<Uint8Array>} stream - `response.body`。
 * @param {{ onMalformed?: (payload: string) => Error }} [options]
 *   `onMalformed` 让调用方决定格式错误怎么抛（各运行时的错误类不同）。
 * @returns {AsyncGenerator<object>} StreamChunk 形状的对象。
 */
export async function* parseWorkBuddyStream(stream, { onMalformed } = {}) {
  const decoder = new TextDecoder()
  let buffer = ''

  let nextIndex = 0
  let textBlock
  let reasoningBlock
  /** wire 的 tool_calls[].index → 打开中的块 */
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage

  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '', callId: '', name: '' }
    order.push(block)
    return block
  }

  const separator = /\r?\n\r?\n/

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.search(separator)
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary)
      const width = buffer[boundary] === '\r' ? 4 : 2
      buffer = buffer.slice(boundary + width)
      boundary = buffer.search(separator)

      const data = eventData(event)
      if (data === undefined || data === '') continue
      if (data === '[DONE]') {
        buffer = ''
        boundary = -1
        break
      }

      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        const error = new Error(`SSE 负载不是合法 JSON：${data.slice(0, 160)}`)
        error.code = 'MALFORMED_RESPONSE'
        throw onMalformed?.(data) ?? error
      }

      if (payload?.usage) pendingUsage = mapUsage(payload.usage)

      const choice = payload?.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}

      // 思考内容：不同模型用不同字段名，全都接住。
      const thought = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text
      if (typeof thought === 'string' && thought !== '') {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += thought
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: thought }
      }

      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += delta.content
        yield { type: 'text-delta', index: textBlock.index, text: delta.content }
      }

      for (const call of delta.tool_calls ?? []) {
        const wireIndex = Number.isInteger(call?.index) ? call.index : 0
        let block = toolBlocks.get(wireIndex)
        if (!block) {
          block = open('tool-call')
          block.callId = call?.id ?? `workbuddy-call-${wireIndex}`
          toolBlocks.set(wireIndex, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call?.id) block.callId = call.id
        if (call?.function?.name) block.name = call.function.name
        const args = call?.function?.arguments
        if (typeof args === 'string' && args !== '') {
          block.text += args
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: block.callId,
            name: block.name,
            argumentsDelta: args,
          }
        }
      }

      if (choice.finish_reason) pendingFinish = mapFinishReason(choice.finish_reason)
    }
  }

  for (const block of order) {
    if (block.kind === 'text') {
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
    } else if (block.kind === 'reasoning') {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
    } else {
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.callId,
          name: block.name,
          arguments: block.text === '' ? '{}' : block.text,
        },
      }
    }
  }

  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }

  const reason = pendingFinish ?? { kind: 'stop' }
  yield {
    type: 'finish',
    reason: reason.kind === 'stop' && order.length === 0
      ? { kind: 'error', failure: { message: '模型返回了空响应', code: 'EMPTY_RESPONSE' } }
      : reason,
  }
}
