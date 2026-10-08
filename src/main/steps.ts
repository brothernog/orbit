// Passos do agente numa execucao (o que o chat mostra sob a resposta). So exibicao: nunca entra em prompt, memoria ou contexto.
// Sem dependencia de 'electron'.
import type { Activity } from './agentActivity.ts'
import { sanitize } from './providers.ts'

export type StepKind = 'edit' | 'read' | 'run' | 'search' | 'web' | 'other'
export type Step = { kind: StepKind; tool: string; target?: string; ok?: boolean; added?: number; removed?: number; ref?: string }
export type StepTotals = { edit: number; read: number; run: number; search: number; web: number; other: number; failed: number; added: number; removed: number; files: number }
export type StepSnapshot = { ms?: number; total: number; totals: StepTotals; items: Step[] }

const MAX_ITEMS = 100, MAX_TARGET = 140
const EDIT = /^(edit|multiedit|write|notebookedit|replace|write_file|apply_patch|file_change)$/i
const READ = /^(read|read_file|read_file_range|view_image|open_image)$/i
const SEARCH = /^(grep|glob|search|find|search_files|list_directory|ls)$/i
const WEB = /^(webfetch|websearch|web_search|web_fetch)$/i
const SHELL = /^(bash|powershell|shell|command|run_shell_command)$/i

export function classifyTool(tool: string): StepKind {
  const name = tool.split('__').pop() ?? tool
  if (EDIT.test(name)) return 'edit'
  if (READ.test(name)) return 'read'
  if (SEARCH.test(name)) return 'search'
  if (WEB.test(name)) return 'web'
  if (SHELL.test(name) || /\s/.test(name.trim())) return 'run' // Codex informa o proprio comando como nome da ferramenta
  return 'other'
}

const clip = (s: string | undefined) => s ? sanitize(s.replace(/\s+/g, ' ').trim()).slice(0, MAX_TARGET) : undefined
const empty = (): StepTotals => ({ edit: 0, read: 0, run: 0, search: 0, web: 0, other: 0, failed: 0, added: 0, removed: 0, files: 0 })

export function createStepLog(now: () => number = Date.now) {
  const steps: Step[] = [], byRef = new Map<string, Step>(), startedAt = now()
  const push = (step: Step) => { steps.push(step); if (step.ref) byRef.set(step.ref, step); return step }
  const clean = (step: Step): Step => { const { ref: _ref, ...rest } = step; return rest }

  function totals(): StepTotals {
    const t = empty(), edited = new Set<string>()
    for (const s of steps) {
      t[s.kind]++
      if (s.ok === false) t.failed++
      t.added += s.added ?? 0; t.removed += s.removed ?? 0
      if (s.kind === 'edit' && s.target) edited.add(s.target)
    }
    t.files = edited.size
    return t
  }

  return {
    tool(tool: string, detail?: string, ref?: string) {
      const found = ref ? byRef.get(ref) : undefined
      if (found) { found.tool = found.tool || tool; found.target ??= clip(detail); return }
      push({ kind: classifyTool(tool), tool: clip(tool)?.slice(0, 80) ?? '', target: clip(detail), ...(ref ? { ref } : {}) })
    },
    result(ref: string, ok: boolean | null) {
      const step = byRef.get(ref)
      if (step && ok !== null) step.ok = ok
    },
    // Arquivos lidos/editados (e as linhas +/-) chegam como atividade; casam com a ferramenta pelo ref.
    activity(a: Activity) {
      if (a.kind !== 'edit' && a.kind !== 'read' && a.kind !== 'image') return
      const kind: StepKind = a.kind === 'edit' ? 'edit' : 'read'
      const step = (a.ref ? byRef.get(a.ref) : undefined) ?? (a.path ? push({ kind, tool: a.tool ?? kind, ref: a.ref }) : undefined)
      if (!step) return
      step.kind = kind
      if (a.path) step.target = clip(a.path)
      if (a.added !== undefined) step.added = a.added
      if (a.removed !== undefined) step.removed = a.removed
    },
    snapshot(finished = false): StepSnapshot {
      return { ...(finished ? { ms: now() - startedAt } : {}), total: steps.length, totals: totals(), items: steps.slice(-MAX_ITEMS).map(clean) }
    },
    // null: nada a gravar (execucao sem ferramentas).
    json(): string | null { return steps.length ? JSON.stringify(this.snapshot(true)) : null }
  }
}
export type StepLog = ReturnType<typeof createStepLog>

// Chamada final garantida: no maximo uma por `ms`, a ultima nunca se perde.
export function throttle(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => { if (!timer) timer = setTimeout(() => { timer = undefined; fn() }, ms) }
}
