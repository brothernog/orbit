// Texto do bloco de atividade sob a resposta do agente (so exibicao). Tipos espelham main/steps.ts.
export type Step = { kind: 'edit' | 'read' | 'run' | 'search' | 'web' | 'other'; tool: string; target?: string; ok?: boolean; added?: number; removed?: number }
export type Steps = {
  ms?: number; total: number; items: Step[]
  totals: { edit: number; read: number; run: number; search: number; web: number; other: number; failed: number; added: number; removed: number; files: number }
}

export const parseSteps = (json: string | null | undefined): Steps | null => {
  if (!json) return null
  try { const s = JSON.parse(json); return s && Array.isArray(s.items) && s.totals ? s : null } catch { return null }
}

export const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60)
  return m ? `${m} min ${s % 60} s` : `${s} s`
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)

// "Executou 11 comandos (1 falha), editou 3 arquivos, leu um arquivo +105 −9"
export function summary(s: Steps): string {
  const t = s.totals, parts: string[] = []
  if (t.run) parts.push(`executou ${count(t.run, 'um comando', 'comandos')}${t.failed ? ` (${count(t.failed, '1 falha', 'falhas')})` : ''}`)
  if (t.files || t.edit) parts.push(`editou ${count(t.files || t.edit, 'um arquivo', 'arquivos')}`)
  if (t.read) parts.push(`leu ${count(t.read, 'um arquivo', 'arquivos')}`)
  if (t.search) parts.push(`buscou ${count(t.search, 'uma vez', 'vezes')}`)
  if (t.web) parts.push(`consultou a web ${count(t.web, 'uma vez', 'vezes')}`)
  if (t.other) parts.push(`${count(t.other, 'outra ação', 'outras ações')}`)
  const text = parts.join(', ')
  const lines = t.added || t.removed ? ` +${t.added} −${t.removed}` : ''
  return (text ? text[0].toUpperCase() + text.slice(1) : 'Sem ações') + lines
}

const VERB: Record<Step['kind'], string> = { edit: 'Editado', read: 'Lido', run: 'Executado', search: 'Busca', web: 'Web', other: '' }
export function stepLabel(s: Step): { verb: string; target: string } {
  const target = s.target || (s.kind === 'run' ? s.tool : s.kind === 'other' ? s.tool : '')
  return { verb: VERB[s.kind], target }
}
