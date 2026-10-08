import { expect, test } from 'claude-code/testing'

import { formatLine } from './register'

test('formats usage, window and the top categories on one line', () => {
  const line = formatLine({
    tokens: 182_400,
    window: 1_000_000,
    percent: 18.24,
    isEstimate: false,
    top: [
      { name: 'Messages', percent: 12.3 },
      { name: 'System tools', percent: 3.04 },
    ],
  })

  expect(line).toBe('Context 182.4k / 1.0M (18%) · Messages 12% · System tools 3.0%')
})

test('marks a pre-response figure as an estimate', () => {
  const line = formatLine({ tokens: 20_000, window: 200_000, percent: 10, isEstimate: true, top: [] })

  expect(line).toBe('Context ~20.0k / 200.0k (10%)')
})

// A 1M model whose compaction window is 500k, so the two denominators differ.
const usage = (tokens: number | undefined) => ({
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens,
    window: 1_000_000,
    breakdown: {
      categories: [
        { name: 'Messages', tokens: 30_000, color: '', isDeferred: false, kind: 'used' as const },
        { name: 'Free space', tokens: 400_000, color: '', isDeferred: false, kind: 'free' as const },
      ],
      totalTokens: 50_000,
      maxTokens: 500_000,
      rawMaxTokens: 500_000,
      autocompactSource: 'model' as never,
      percentage: 10,
      gridRows: [],
      model: 'm',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
})

const step = (agentId?: string) => ({
  turnId: 't',
  index: 0,
  model: 'm',
  messageCount: 1,
  ...(agentId ? { agentId } : {}),
})

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
  }
}

// The engine beneath the plugin: `$.session.usage` answers `answer`, and
// `$.state` is one value in memory, which the test reads back.
function world(on: any, answer: ReturnType<typeof usage>) {
  let value: unknown
  let version = 0

  on('session.usage', () => ({ value: answer }))
  on('state.get', () => ({ value: { value, version } }))
  on('state.set', (_$: unknown, e: { value: unknown }) => {
    value = e.value
    version += 1
    return { value: { isSet: true, version } }
  })

  return { summary: () => value as any }
}

test('measures categories against the compaction window, as /context does', async ($, on) => {
  const w = world(on, usage(100_000))
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  await $.session.measure({ context: { window: 1_000_000, tokens: 100_000 }, rateLimits: [], changed: ['context'] })

  const s = w.summary()
  expect(s.percent).toBe(10)
  expect(s.top).toEqual([{ name: 'Messages', percent: 6 }])
})

test('refreshes after each main-thread response, not only at turn end', async ($, on) => {
  const w = world(on, usage(100_000))
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 2_000, model: 'm' },
    } as any
  })

  await drain($.turn.step(step() as any))

  const s = w.summary()
  expect(s.tokens).toBe(122_010)
  expect(s.isEstimate).toBe(false)
})

test("leaves the line alone on a subagent's response", async ($, on) => {
  const w = world(on, usage(100_000))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })

  await drain($.turn.step(step('agent-1') as any))

  expect(w.summary()).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws the line directly above the engine's hint line (${surface})`, async ($, on) => {
    world(on, usage(100_000))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    // Beneath the plugin: the engine's own hint line, with the mode pill.
    on('ui.render', { component: 'PromptHint' }, () => ({
      type: 'Text',
      props: {},
      children: ['⏵⏵ auto mode on (shift+tab to cycle)'],
    }))

    await $.session.measure({ context: { window: 1_000_000, tokens: 100_000 }, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({
      plugin: 'context-line',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
    })

    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toEqual(['Context 100.0k / 1.0M (10%) · Messages 6.0%', '⏵⏵ auto mode on (shift+tab to cycle)'])
  })
}

test('refreshes after /clear, which fires no session.start', async ($, on) => {
  const w = world(on, usage(undefined))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'clear' } as any)

  const s = w.summary()
  expect(s.isEstimate).toBe(true)
  expect(s.tokens).toBe(50_000)
})
