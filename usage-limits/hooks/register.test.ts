import { expect, mock, test } from 'claude-code/testing'

import { bar, formatCountdown, formatLine } from './register'

const T0 = Date.parse('2026-10-07T12:00:00Z')

test('draws a ten-cell bar with a half cell', () => {
  expect(bar(0)).toBe('▕░░░░░░░░░░▏')
  expect(bar(41)).toBe('▕████░░░░░░▏')
  expect(bar(45)).toBe('▕████▌░░░░░▏')
  expect(bar(100)).toBe('▕██████████▏')
  expect(bar(130)).toBe('▕██████████▏')
})

test('formats countdowns in minutes, hours and days', () => {
  expect(formatCountdown(0)).toBe('now')
  expect(formatCountdown(42 * 60_000)).toBe('42m')
  expect(formatCountdown((2 * 60 + 13) * 60_000)).toBe('2h13m')
  expect(formatCountdown((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
})

test('formats session and week on one line', () => {
  const line = formatLine({
    now: T0,
    limits: [
      { kind: 'five_hour', percent: 41, resetsAt: new Date(T0 + 133 * 60_000).toISOString() },
      { kind: 'seven_day', percent: 28.4, resetsAt: new Date(T0 + 76 * 3_600_000).toISOString() },
    ],
  })

  expect(line).toBe('Session ▕████░░░░░░▏ 41% · resets 2h13m   Week ▕██▌░░░░░░░▏ 28% · resets 3d4h')
})

const hintLine = '⏵⏵ auto mode on (shift+tab to cycle)'

// `$.state` as one value in memory, which the test reads back.
function world(on: any) {
  let value: unknown = null
  let version = 0

  on('state.get', () => ({ value: { value, version } }))
  on('state.set', (_$: unknown, e: { value: unknown }) => {
    value = e.value
    version += 1
    return { value: { isSet: true, version } }
  })
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  // Beneath the plugin: the engine's own hint line, with the mode pill.
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: [hintLine] }))

  return { snapshot: () => value as any }
}

async function drawn($: any) {
  const ui = await $.ui.mount({
    plugin: 'usage-limits',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: hintLine },
  })

  return (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
}

test('draws the windows above the hint line, sorted session first', async ($, on) => {
  mock.clock(on, { now: T0 })
  world(on)

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 28, resetsAt: new Date(T0 + 76 * 3_600_000).toISOString() },
      { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(T0 + 133 * 60_000).toISOString() },
    ],
    changed: ['rateLimits'],
  })

  expect(await drawn($)).toEqual([
    'Session ▕████░░░░░░▏ 41% · resets 2h13m   Week ▕██▌░░░░░░░▏ 28% · resets 3d4h',
    hintLine,
  ])
})

test('draws nothing extra without rate-limit windows (API-key auth)', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on)

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })

  expect(w.snapshot()).toBe(null)
  expect(await drawn($)).toEqual([hintLine])
})
