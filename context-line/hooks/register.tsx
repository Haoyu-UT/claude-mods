import { atom, read, update } from 'claude-code'
import type { Engine, ModelUsage, Register } from 'claude-code'

import type { Slice, Summary } from '../types'

const summary = atom({ plugin: 'context-line', key: 'summary' } as const, null)

const TOP = 5

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function formatPercent(p: number): string {
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`
}

export function formatLine(s: Summary): string {
  const used = `${s.isEstimate ? '~' : ''}${formatTokens(s.tokens)}`
  const head = `Context ${used} / ${formatTokens(s.window)} (${formatPercent(s.percent)})`
  const parts = s.top.map(c => `${c.name} ${formatPercent(c.percent)}`)

  return [head, ...parts].join(' · ')
}

// Input tokens a response was answered over, counted as the status line
// counts them: uncached, cache-written and cache-read together.
function inputTokens(u: ModelUsage): number {
  return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
}

async function measure($: Engine, fresh?: number): Promise<Summary | null> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  const window = context.window

  if (!window) return null

  // The status line's figure is exact once a response came back; before
  // that, fall back to the breakdown's local estimate. A response just in
  // hand (`fresh`) beats both, in case the session has not recorded it yet.
  const reported = fresh ?? context.tokens
  const isEstimate = reported === undefined
  const tokens = reported ?? breakdown?.totalTokens ?? 0

  // The breakdown measures against the compaction window, which may be
  // smaller than the model's: divide by the same figure /context does.
  const against = breakdown?.rawMaxTokens || window

  const top: Slice[] = (breakdown?.categories ?? [])
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP)
    .map(c => ({ name: c.name, percent: (c.tokens / against) * 100 }))

  return { tokens, window, percent: (tokens / window) * 100, isEstimate, top }
}

async function refresh($: Engine, fresh?: number): Promise<void> {
  try {
    const next = await measure($, fresh)
    await update($, summary, () => next)
  } catch {
    // No session bound yet, or the breakdown failed: keep the last line.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  // `/clear` fires no `session.start`; the classic SessionStart hook does
  // fire, with `source: 'clear'`.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') await refresh($)

    return result
  })

  // `session.measure` waits for the whole turn; a turn of many tool calls
  // would show the last turn's figure throughout. Refresh after each of the
  // main thread's responses instead (a subagent's fills its own window).
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      await refresh($, result.usage ? inputTokens(result.usage) : undefined)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refresh($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  // Drawn as one row stacked on the hint line under the prompt (the one with
  // the permission-mode pill), which stays the engine's own drawing.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, summary)
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
