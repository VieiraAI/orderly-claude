export type Bubble = {
  id: string
  label: string
  status: 'running' | 'done' | 'warn'
  tool: string
  detail: string
}

declare module 'claude-code' {
  interface PluginState {
    'orderly-claude': {
      bubbles: Bubble[]
      declared: string[]
      expanded: string | null
    }
  }
}
