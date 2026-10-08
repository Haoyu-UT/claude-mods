import { atom, read, update } from 'claude-code'
import type { Engine, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-limits', key: 'snapshot' } as const, null)

const BAR = 10
const MINUTE = 60_000

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Week',
  spend_limit: 'Spend',
}

// Session first, then week, then anything else the engine reports.
const ORDER = ['five_hour', 'seven_day']

export function bar(percent: number): string {
  const cells = (Math.min(Math.max(percent, 0), 100) / 100) * BAR
  const full = Math.floor(cells)
  const half = cells - full >= 0.5 ? '▌' : ''

  return `▕${'█'.repeat(full)}${half}${'░'.repeat(BAR - full - half.length)}▏`
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'

  const minutes = Math.ceil(ms / MINUTE)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${mins}m`
  return `${mins}m`
}

export function formatLimit(l: Limit, now: number): string {
  const label = LABELS[l.kind] ?? l.kind
  const pct = `${Math.round(l.percent)}%`
  const reset = l.resetsAt ? ` · resets ${formatCountdown(Date.parse(l.resetsAt) - now)}` : ''

  return `${label} ${bar(l.percent)} ${pct}${reset}`
}

export function formatLine(s: Snapshot): string {
  return s.limits.map(l => formatLimit(l, s.now)).join('   ')
}

function rank(kind: string): number {
  const i = ORDER.indexOf(kind)
  return i === -1 ? ORDER.length : i
}

function toLimits(rateLimits: SessionRateLimit[]): Limit[] {
  return [...rateLimits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(r => ({ kind: r.kind, percent: r.percentUsed, ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}) }))
}

async function store($: Engine, rateLimits: SessionRateLimit[]): Promise<void> {
  const now = await $.clock.now()
  const limits = toLimits(rateLimits)

  await update($, snapshot, () => (limits.length ? { limits, now } : null))
}

async function refresh($: Engine): Promise<void> {
  try {
    const { rateLimits } = await $.session.usage()
    await store($, rateLimits)
  } catch {
    // No session bound yet: keep the last line.
  }
}

// Move the countdowns on while the session sits idle.
async function tick($: Engine): Promise<void> {
  const now = await $.clock.now()
  await update($, snapshot, s => (s ? { ...s, now } : s))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    $.clock.every(MINUTE, () => void tick($))

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await store($, e.rateLimits)

    return next(e)
  })

  // One row stacked on the hint line under the prompt; absent until the
  // first response reports windows (and always on API-key auth).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, snapshot)
    const hint = await next(e)

    if (s === null) return hint

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {formatLine(s)}
        </Text>
        {hint}
      </Box>
    )
  })
}
