import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Bubble } from '../types'

const PANE = 'orderly-claude'

const bubbles = atom({ plugin: 'orderly-claude', key: 'bubbles' } as const, [])
const declared = atom({ plugin: 'orderly-claude', key: 'declared' } as const, [])
const expanded = atom({ plugin: 'orderly-claude', key: 'expanded' } as const, null)

const PLAN_TOOL = 'mcp__orderly-claude__plan'

const base = (p: unknown) => String(p ?? '').split('/').pop() ?? ''

/** Read-only shell commands collapse into one bubble instead of one each. */
const READONLY = /^(ls|cat|head|tail|grep|rg|find|wc|which|echo|pwd|stat|file|jq|sort|uniq|tree|basename|dirname)\b/

function labelOf(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  if (tool === 'Bash') {
    const desc = String(e.description ?? '').trim()
    if (desc) return desc
    return String(e.command ?? '').split('\n')[0].slice(0, 58)
  }
  if (tool === 'Write') return `Wrote ${base(e.file_path)}`
  if (tool === 'Edit' || tool === 'MultiEdit') return `Edited ${base(e.file_path)}`
  if (tool === 'Read') return `Read ${base(e.file_path)}`
  if (tool === 'Glob' || tool === 'Grep') return `Searched for ${String(e.pattern ?? '').slice(0, 36)}`
  if (tool.startsWith('mcp__')) return tool.replace(/^mcp__/, '').replace(/__/g, ' · ')
  return tool
}

function detailOf(e: Record<string, unknown>): string {
  const first = e.command ?? e.file_path ?? e.pattern ?? e.query ?? ''
  return String(first).slice(0, 600)
}

/** Lowercase word overlap, to match a finished step to a declared one. */
function similar(a: string, b: string): number {
  const A = new Set((a.toLowerCase().match(/[a-z0-9]+/g) ?? []))
  const B = new Set((b.toLowerCase().match(/[a-z0-9]+/g) ?? []))
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit++
  return hit / (A.size + B.size - hit)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan',
      description:
        'Declare the steps you are about to take so the person sees them as a checklist that fills in as you work. ' +
        'Call this once at the start of any task that will take more than two or three steps. Keep each label short and plain.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short human-readable step labels, in the order you intend to do them',
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })

    await $.command.register({
      name: 'orderly',
      description: 'Show the Orderly Claude progress pane',
    })
    void $.ui.open({ id: PANE, title: 'Orderly Claude' })

    return next(e)
  })

  on('command.run', { command: 'orderly' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Orderly Claude' })

    return { text: 'Orderly Claude pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === PLAN_TOOL) {
      const steps = Array.isArray(e.steps) ? e.steps.map(String).filter(Boolean) : []
      await update($, declared, () => steps)
      await $.ui.invalidate('ui.render')

      return { result: `Plan recorded: ${steps.length} step${steps.length === 1 ? '' : 's'}.` }
    }

    const id = String(e.tool_use_id)
    const label = labelOf(e)
    const quiet = e.tool === 'Bash' && READONLY.test(String(e.command ?? '').trim())

    await update($, bubbles, list => {
      const last = list[list.length - 1]
      // Consecutive look-around commands fold into the bubble already open.
      if (quiet && last && last.status !== 'running' && last.tool === 'Bash') return list
      const fresh: Bubble = { id, label, status: 'running', tool: String(e.tool), detail: detailOf(e) }

      return [...list, fresh].slice(-250)
    })

    const ran = await next(e)
    const failed = Boolean((ran as { isError?: boolean } | undefined)?.isError)

    await update($, bubbles, list =>
      list.map(b => (b.id === id ? { ...b, status: failed ? 'warn' : 'done' } : b)),
    )

    return ran
  }).catch(($, e, next) => next(e)) // bookkeeping must never block a tool call

  on('ui.press', async ($, e, next) => {
    const key = String((e as { element?: unknown }).element ?? '')
    if (key.startsWith('bubble:')) {
      const id = key.slice('bubble:'.length)
      await update($, expanded, cur => (cur === id ? null : id))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, bubbles)
    const plan = await read($, declared)
    const open = await read($, expanded)

    const room = Math.max(6, (e.viewport?.rows ?? 24) - 6)
    const shown = list.slice(-room)
    const pending = plan.filter(step => !list.some(b => similar(step, b.label) >= 0.34))

    const glyph = (status: Bubble['status']) =>
      status === 'done' ? '●' : status === 'warn' ? '◑' : '○'

    return (
      <Box flexDirection="column">
        {shown.length === 0 && pending.length === 0 && (
          <Text dimColor>Nothing yet — the next step will show here.</Text>
        )}

        {shown.map(b => (
          <Box flexDirection="column" key={b.id}>
            <Button key={`bubble:${b.id}`}>
              <Text color={b.status === 'warn' ? 'yellow' : b.status === 'done' ? 'green' : 'cyan'}>
                {glyph(b.status)}
              </Text>
              <Text> {b.label}</Text>
            </Button>
            {open === b.id && b.detail !== '' && (
              <Box paddingLeft={2}>
                <Text dimColor>{b.detail.slice(0, 400)}</Text>
              </Box>
            )}
          </Box>
        ))}

        {pending.map(step => (
          <Text dimColor key={step}>
            {'○'} {step}
          </Text>
        ))}
      </Box>
    )
  })
}
