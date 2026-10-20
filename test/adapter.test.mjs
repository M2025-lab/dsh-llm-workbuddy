/**
 * 适配器单元测试：验证 parseStream 产出的 StreamChunk 序列符合 dsh 契约。
 *
 * 契约要点（见 dsh 的 StreamChunk 文档）：
 *   - 每个 block-start 都有配对的 block-end；
 *   - index 从 0 开始递增；
 *   - usage 在 finish 之前，finish 必须是最后一个分片。
 *
 * 运行：node --test test/adapter.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkBuddyStream, toWireMessages } from '../stream.js'
import { chatHeaders } from '../protocol.js'

/** 把若干段 SSE 文本拼成一个可读流。 */
function sseStream(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** 把一个 wire chunk 包成 SSE 事件。 */
function evt(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 收齐 parseStream 产出的全部分片。 */
async function collect(chunks) {
  const out = []
  for await (const chunk of parseWorkBuddyStream(sseStream(chunks))) out.push(chunk)
  return out
}

/** 断言分片序列的通用合法性。 */
function assertWellFormed(chunks) {
  const opened = new Set()
  const closed = new Set()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      assert.ok(!opened.has(chunk.index), `block ${chunk.index} 被重复打开`)
      opened.add(chunk.index)
    }
    if (chunk.type === 'block-end') {
      assert.ok(opened.has(chunk.index), `block ${chunk.index} 未打开就结束`)
      closed.add(chunk.index)
    }
  }
  assert.deepEqual([...opened].sort(), [...closed].sort(), 'block-start 与 block-end 必须一一配对')

  const finishes = chunks.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1, '必须恰好有一个 finish')
  assert.equal(chunks.at(-1).type, 'finish', 'finish 必须是最后一个分片')

  const finishAt = chunks.findIndex((c) => c.type === 'finish')
  const usageAt = chunks.findIndex((c) => c.type === 'usage')
  if (usageAt !== -1) assert.ok(usageAt < finishAt, 'usage 必须在 finish 之前')
}

test('纯文本响应', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: { role: 'assistant' } }] }),
    evt({ choices: [{ delta: { content: '连接' } }] }),
    evt({ choices: [{ delta: { content: '成功' }, finish_reason: 'stop' }] }),
    evt({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ])

  assertWellFormed(chunks)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, '连接成功')

  const blockEnd = chunks.find((c) => c.type === 'block-end')
  assert.deepEqual(blockEnd.block, { type: 'text', text: '连接成功' })

  const usage = chunks.find((c) => c.type === 'usage')
  assert.equal(usage.usage.inputTokens, 9)
  assert.equal(usage.usage.outputTokens, 2)

  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('思考内容走 reasoning 块', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: { reasoning_content: '先想一下' } }] }),
    evt({ choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ])

  assertWellFormed(chunks)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, '先想一下')
  const reasoningBlock = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.deepEqual(reasoningBlock.block, { type: 'reasoning', text: '先想一下' })
})

test('工具调用分片累积成完整参数', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"comm' } }] } }] }),
    evt({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
    evt({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])

  assertWellFormed(chunks)
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(blockEnd.block.id, 'call_1')
  assert.equal(blockEnd.block.name, 'bash')
  assert.equal(blockEnd.block.arguments, '{"command":"ls"}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('多个工具调用各自成块且 index 不冲突', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_a', function: { name: 'read', arguments: '{}' } },
      { index: 1, id: 'call_b', function: { name: 'write', arguments: '{}' } },
    ] } }] }),
    evt({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])

  assertWellFormed(chunks)
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call').map((c) => c.block.id)
  assert.deepEqual(calls, ['call_a', 'call_b'])
})

test('空响应判为错误而不是成功空消息', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ])

  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('长度截断映射为 max-tokens', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: { content: '半句' }, finish_reason: 'length' }] }),
    'data: [DONE]\n\n',
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('缓存命中的 token 从输入里扣掉', async () => {
  const chunks = await collect([
    evt({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }),
    evt({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } }),
    'data: [DONE]\n\n',
  ])
  const usage = chunks.find((c) => c.type === 'usage')
  assert.equal(usage.usage.inputTokens, 20)
  assert.equal(usage.usage.cacheReadTokens, 80)
})

test('SSE 事件跨网络分片也能正确拼回来', async () => {
  const whole = evt({ choices: [{ delta: { content: '跨块' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
  // 故意在 JSON 中间切断
  const chunks = await collect([whole.slice(0, 17), whole.slice(17, 31), whole.slice(31)])
  assertWellFormed(chunks)
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '跨块')
})

test('消息翻译：工具结果拆成 tool 角色', () => {
  const wire = toWireMessages([
    { id: '1', role: 'user', content: [{ type: 'text', text: '查一下' }] },
    {
      id: '2',
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
    },
    {
      id: '3',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] }],
    },
  ])

  assert.equal(wire[0].role, 'user')
  assert.equal(wire[0].content, '查一下')
  assert.equal(wire[1].role, 'assistant')
  assert.equal(wire[1].tool_calls[0].id, 'call_1')
  assert.equal(wire[2].role, 'tool')
  assert.equal(wire[2].tool_call_id, 'call_1')
  assert.equal(wire[2].content, 'a.txt')
})

test('消息翻译：空的 assistant 消息不发', () => {
  const wire = toWireMessages([
    { id: '1', role: 'assistant', content: [] },
    { id: '2', role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ])
  assert.equal(wire.length, 1)
  assert.equal(wire[0].content, 'hi')
})

test('渠道校验：dsh 归因头不能覆盖官方客户端 UA', () => {
  // 这是线上真实回归：attributionHeaders() 把 UA 写成 deepseek-harness/...
  // 后，WorkBuddy 网关返回 400 / code 11128 "request illegal"。
  const attribution = {
    'user-agent': 'deepseek-harness/0.1.0-rc.5 (+https://github.com/deepseek-ai/deepseek-harness)',
  }
  const headers = chatHeaders({ key: 'tok', kind: 'token' }, attribution)

  assert.ok(!headers['user-agent'].includes('deepseek-harness'), 'UA 不能被归因头覆盖')
  assert.match(headers['user-agent'], /CodeBuddy/, 'UA 必须是官方客户端形态')
  assert.equal(headers['x-product'], 'SaaS')
})

test('渠道校验：归因头的其它字段应当保留', () => {
  const headers = chatHeaders(
    { key: 'tok', kind: 'token' },
    { 'user-agent': 'deepseek-harness/x', 'x-attribution': 'keep-me' },
  )
  assert.equal(headers['x-attribution'], 'keep-me')
})

test('令牌模式只发 Authorization，不混发 x-api-key', () => {
  const token = chatHeaders({ key: 'tok', kind: 'token' })
  assert.equal(token.authorization, 'Bearer tok')
  assert.equal(token['x-api-key'], undefined, '混发 x-api-key 会 401 not_found')

  const apiKey = chatHeaders({ key: 'sk-1', kind: 'api-key' })
  assert.equal(apiKey.authorization, 'Bearer sk-1')
  assert.equal(apiKey['x-api-key'], 'sk-1')
})
