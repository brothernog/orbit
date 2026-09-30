// Passagem entre contas Claude quando a cota acaba no meio de uma resposta. O resumo da retomada e montado por software (sem IA, zero tokens)
// a partir do que o proprio app viu na execucao: pedido, arquivos editados/lidos, comandos e testes, fim da resposta parcial. Ele vira uma
// pendencia da tarefa (memoria) e so chega a outra conta pelo pedido de contexto aprovado (consent.ts), como qualquer historico.
import type { DatabaseSync } from 'node:sqlite'
import { addMemory } from './memory.ts'
import type { Act } from './notify.ts'
import { saveSel, profileOf, type TaskSel } from './tasks.ts'
import { usedPercent } from './automations.ts'
import type { AccountUsage } from './accountUsage.ts'

export type HandoverMode = 'off' | 'prepare' | 'auto'
export const MODES: HandoverMode[] = ['off', 'prepare', 'auto']
export const normalizeHandover = (raw: any): { mode: HandoverMode } => ({ mode: MODES.includes(raw?.mode) ? raw.mode : 'off' })
export const HANDOVER_TAG = '[Retomada automatica]'
export const HANDOVER_TITLE = 'Retomar pedido interrompido pelo limite de uso'
const ORIGINAL = '\n\nPedido original:\n'

const uniq = (xs: string[]) => [...new Set(xs.map(x => x.trim()).filter(Boolean))]
// Pedido original mesmo depois de varias retomadas seguidas.
export const originalOf = (text: string) => text.startsWith(HANDOVER_TAG) && text.includes(ORIGINAL) ? text.slice(text.indexOf(ORIGINAL) + ORIGINAL.length) : text

// Resumo deterministico. Ordem = importancia; cada secao e cortada antes de estourar o limite, nunca o pedido.
export function handoverNote(o: { request: string; acts: Act[]; partial: string; from: string }, max = 1800): string {
  const pick = (re: RegExp) => uniq(o.acts.map(a => re.exec(a.line)?.[1] ?? ''))
  const edited = pick(/^(?:Edit|Write|MultiEdit|NotebookEdit)\s+(.+)/)
  const read = pick(/^Read\s+(.+)/).filter(f => !edited.includes(f))
  const cmds = uniq(o.acts.filter(a => /^Bash\s/.test(a.line)).map(a => `${a.line.slice(5, 160)}${a.ok === true ? ' [ok]' : a.ok === false ? ' [falhou]' : ''}${a.summary ? ` (${a.summary.slice(0, 80)})` : ''}`))
  const list = (title: string, xs: string[], n: number) => xs.length ? `${title}:\n${xs.slice(-n).map(x => `- ${x}`).join('\n')}${xs.length > n ? `\n- (+${xs.length - n} anteriores)` : ''}` : ''
  const tail = o.partial.replace(/`> [^`]*`/g, '').trim().slice(-500)
  const parts = [
    `A conta ${o.from} atingiu o limite de uso no meio desta resposta. Confira o estado atual dos arquivos antes de editar.`,
    `Pedido: ${o.request.slice(0, 400)}`,
    list('Arquivos ja editados', edited, 15), list('Comandos rodados', cmds, 8), list('Arquivos lidos', read, 10),
    tail && `Fim da resposta parcial:\n${tail}`
  ].filter(Boolean)
  let out = ''
  for (const p of parts) if (out.length + p.length + 2 <= max) out += (out ? '\n\n' : '') + p
  return out
}

type Deps = {
  db: DatabaseSync; mode: () => HandoverMode; itemChars: () => number // limite por item do pacote (Configuracoes)
  peers: (accountId: number) => number[]; usage: (accountId: number) => AccountUsage | null; accountName: (accountId: number) => string
  sendTask: (taskId: number, sel: TaskSel, text: string) => Promise<unknown>
  note: (taskId: number, text: string) => void; emit: (ev: object) => void; now?: () => number
}
export function createHandover(d: Deps) {
  // Conta com menos uso conhecido; esgotada fica de fora; desconhecida vale como meio termo.
  const next = (from: number) => {
    const now = (d.now ?? Date.now)()
    return d.peers(from).map(id => ({ id, used: usedPercent(d.usage(id), now) })).filter(x => (x.used ?? 0) < 100).sort((a, b) => (a.used ?? 50) - (b.used ?? 50))[0]?.id
  }
  return function onFinished(o: { taskId: number; sel: TaskSel; text: string; status: string; category?: string; partial: string; acts: Act[] }) {
    if (o.status === 'completed' && o.text.startsWith(HANDOVER_TAG)) { // retomada concluida: a pendencia sai dos proximos pacotes
      d.db.prepare("UPDATE memory_items SET todo_state='done' WHERE task_id=? AND kind='todo' AND title=? AND todo_state='open'").run(o.taskId, HANDOVER_TITLE)
      return
    }
    const mode = d.mode()
    if (mode === 'off' || o.category !== 'limit' || o.sel.provider !== 'claude' || !o.sel.accountId) return
    const from = d.accountName(o.sel.accountId), to = next(o.sel.accountId)
    const request = originalOf(o.text)
    addMemory(d.db, { taskId: o.taskId, owner: 'run', lineage: `chat:${o.taskId}:claude:${profileOf('claude', o.sel.accountId)}`, kind: 'todo', title: HANDOVER_TITLE,
      content: handoverNote({ request, acts: o.acts, partial: o.partial, from }, Math.min(1800, d.itemChars())) })
    if (to == null) { d.note(o.taskId, `↳ Passagem: ${from} atingiu o limite e nenhuma outra conta Claude tem uso livre. O resumo da retomada ficou nas pendencias da tarefa.`); return }
    const sel = { ...o.sel, accountId: to }
    saveSel(d.db, o.taskId, sel)
    d.emit({ taskId: o.taskId, refresh: true })
    // No maximo uma retomada automatica seguida: se a propria retomada estourou, so prepara.
    if (mode === 'prepare' || o.text.startsWith(HANDOVER_TAG)) {
      d.note(o.taskId, `↳ Passagem: ${from} atingiu o limite. ${d.accountName(to)} ficou selecionada e o resumo da retomada esta pronto; envie "continuar" quando quiser.`)
      return
    }
    d.note(o.taskId, `↳ Passagem: ${from} atingiu o limite. Continuando por ${d.accountName(to)}; o historico e o resumo so seguem se voce aprovar o contexto.`)
    const text = `${HANDOVER_TAG} A execucao anterior parou no limite de uso da conta ${from}. Continue o pedido abaixo a partir do estado atual dos arquivos; o resumo do que ja foi feito esta na pendencia "${HANDOVER_TITLE}".${ORIGINAL}${request}`
    d.sendTask(o.taskId, sel, text).catch(e => d.note(o.taskId, `↳ Passagem nao iniciada: ${String(e?.message ?? e).slice(0, 300)}`))
  }
}
