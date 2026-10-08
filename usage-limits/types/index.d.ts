export type Limit = {
  kind: string
  percent: number
  resetsAt?: string
}

export type Snapshot = {
  limits: Limit[]
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': { snapshot: Snapshot | null }
  }
}
