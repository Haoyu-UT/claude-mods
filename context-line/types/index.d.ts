export type Slice = { name: string; percent: number }

export type Summary = {
  tokens: number
  window: number
  percent: number
  isEstimate: boolean
  top: Slice[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-line': { summary: Summary | null }
  }
}
