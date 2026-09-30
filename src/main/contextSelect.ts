// Selecao DETERMINISTICA do contexto pertinente de uma tarefa para um novo destinatario (troca de provedor, sessao nova, worktree). Sem LLM,
// sem embeddings, sem sumarizador: SQLite, regras fixas e limites explicitos. O resultado e so um CANDIDATO: nada segue sem o usuario aprovar o
// pacote exato para o destinatario exato (consent.ts). Prioridade alta nao autoriza compartilhar nem prova nada; item sem evidencia e rotulado
// como validade desconhecida; o que nao couber e listado para o usuario ajustar (nunca cortado em silencio). Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import { sha } from './artifacts.ts'
import { findGrantId, type HistoryCandidate, type Omitted, type PackageItem, type Recipient } from './consent.ts'
import type { ContextLimits } from './limits.ts'
import { getMemory, validate, type MemoryRow } from './memory.ts'

const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]

// Ordem de prioridade por tipo. Checkpoint fica de fora: ele so resume itens que ja sao candidatos.
const RANK: Record<string, number> = { objective: 0, constraint: 1, decision: 2, todo: 3, validation: 4, finding: 5 }
const REQUIREMENTS = new Set(['objective', 'constraint'])
export const RECENT_VALIDATIONS = 3 // evidencias de teste: so as mais recentes (as antigas sao listadas como nao incluidas)
const MEMORY_SHARE = 0.6 // com historico a transferir, a memoria pertinente usa ate 60% do pacote e o historico bruto completa o resto
const MIN_HISTORY_CHARS = 500
const TITLE_MARGIN = 150 // folga para o titulo do item de historico

export type MemorySelection = { items: PackageItem[]; omitted: Omitted[]; usedChars: number; alreadyDelivered: number }

// Itens que o usuario pode aprovar para o destino: memoria das conversas dele (chat:*) e itens do usuario, ATIVOS e ainda validos. Itens privados de
// filhos (del:*) ficam de fora; o que o destino ja ve (propria identidade) ou ja recebeu CONFIRMADO nesta sessao (identidade + revisao + conteudo) tambem.
export function selectMemory(db: DatabaseSync, o: { taskId: number; recipient: Recipient; sessionId: string | null; cwd: string; limits: ContextLimits; withHistory: boolean }): MemorySelection {
  const mine = findGrantId(db, { taskId: o.taskId, recipient: o.recipient, sessionId: o.sessionId })
  const confirmed = confirmedKeys(db, o.taskId, o.recipient, o.sessionId)
  const omitted: Omitted[] = []
  let alreadyDelivered = 0
  type Cand = { m: MemoryRow; item: PackageItem; requirement: boolean }
  const cands: Cand[] = []
  const rows = all(db, "SELECT id FROM memory_items WHERE task_id=? AND state IN ('active','stale') AND (owner='user' OR lineage LIKE 'chat:%') ORDER BY id", o.taskId).slice(-500)
  const recentValidations = new Set(rows.map(r => getMemory(db, o.taskId, r.id)!).filter(m => m.kind === 'validation').slice(-RECENT_VALIDATIONS).map(m => m.id))
  for (const { id } of rows) {
    const m = getMemory(db, o.taskId, id)!
    if (!(m.kind in RANK)) continue
    if (m.lineage === o.recipient.logicalId && m.grant_id && m.grant_id === mine) continue // o destino ja le o que ele mesmo escreveu
    if (m.kind === 'todo' && m.todo_state === 'done') continue // pendencia concluida nao e contexto
    const requirement = REQUIREMENTS.has(m.kind)
    const skip = (why: string) => omitted.push({ ref: `m:${m.id}`, kind: m.kind, title: m.title, why, ...(requirement ? { requirement: true } : {}) })
    const v = validate(db, m, o.cwd)
    if (v.validity === 'stale') { skip(`desatualizado (arquivos de evidencia mudaram${v.changed.length ? `: ${v.changed.slice(0, 3).join(', ')}` : ''}): revalide antes de compartilhar`); continue }
    if (m.kind === 'validation' && !recentValidations.has(m.id)) { skip(`evidencia de teste mais antiga que as ${RECENT_VALIDATIONS} mais recentes`); continue }
    const suffix = [v.validity === 'unknown' ? 'validade desconhecida: sem evidencia' : '', m.conflict_with ? `CONFLITA com m:${m.conflict_with}` : ''].filter(Boolean)
    const item: PackageItem = { ref: `m:${m.id}`, itemId: m.id, revision: m.revision, kind: m.kind, title: suffix.length ? `${m.title} [${suffix.join('; ')}]` : m.title, content: m.content }
    if (confirmed.has(`${item.ref}@${item.revision}|${sha(item.content)}`)) { alreadyDelivered++; continue }
    cands.push({ m, item, requirement })
  }
  // Ordem estavel: tipo (requisitos primeiro) e, dentro dele, requisitos na ordem original e o resto do mais novo para o mais antigo.
  cands.sort((a, b) => RANK[a.m.kind] - RANK[b.m.kind] || (a.requirement ? a.m.id - b.m.id : b.m.id - a.m.id))
  const lim = o.limits
  const maxItems = lim.packageItems - (o.withHistory ? 1 : 0)
  const budget = Math.floor(lim.packageChars * (o.withHistory ? MEMORY_SHARE : 1))
  const items: PackageItem[] = []
  let used = 0
  for (const c of cands) {
    const size = c.item.title.length + c.item.content.length
    const skip = (why: string) => omitted.push({ ref: c.item.ref, kind: c.item.kind, title: c.item.title, why, ...(c.requirement ? { requirement: true } : {}) })
    if (c.item.content.length > lim.itemChars) skip(`maior que o limite por item (${c.item.content.length} > ${lim.itemChars} caracteres): amplie o limite em Configuracoes`)
    else if (items.length >= maxItems) skip(`nao coube: limite de ${lim.packageItems} itens por pacote`)
    else if (used + size > budget) skip(`nao coube: limite de ${lim.packageChars} caracteres por pacote`)
    else { items.push(c.item); used += size }
  }
  return { items, omitted, usedChars: used, alreadyDelivered }
}

// Chaves `ref@revisao|hash do conteudo` ja CONFIRMADAS para ESTE destinatario completo (provedor, perfil, modelo, esforco, area, escopo) e nesta
// sessao: nada e fundido entre destinos, mesmo que a sessao fisica seja a mesma.
function confirmedKeys(db: DatabaseSync, taskId: number, r0: Recipient, sessionId: string | null): Set<string> {
  const keys = new Set<string>()
  if (!sessionId) return keys
  const sameDest = (r: any) => r.provider === r0.provider && r.profile === r0.profile && (r.model ?? null) === (r0.model ?? null) && (r.effort ?? null) === (r0.effort ?? null)
    && String(r.workspace ?? '').toLowerCase() === r0.workspace.toLowerCase() && JSON.stringify([...JSON.parse(r.scope)].sort()) === JSON.stringify([...r0.scope].sort())
  const rows = all(db, `SELECT p.items, p.provider, p.profile, p.model, p.effort, p.workspace, p.scope, d.revisions FROM context_deliveries d JOIN context_packages p ON p.id = d.package_id
    WHERE p.task_id=? AND p.recipient=? AND d.session_id=? AND d.result='confirmed'`, taskId, r0.logicalId, sessionId).filter(sameDest)
  for (const r of rows) {
    const revs = JSON.parse(r.revisions) as Record<string, number | null>
    for (const i of JSON.parse(r.items) as PackageItem[]) if (i.ref in revs) keys.add(`${i.ref}@${revs[i.ref]}|${sha(i.content)}`)
  }
  return keys
}

export type Selection = { candidate: HistoryCandidate | null; omitted: Omitted[]; requirementsOmitted: boolean }
// Candidato completo: memoria pertinente primeiro; historico bruto so como COMPLEMENTO no espaco que sobrar (as mensagens mais antigas que nao
// couberem sao contadas). `history(maxChars)` devolve o historico transferivel (tasks.contextFor) limitado a maxChars.
export function selectContext(db: DatabaseSync, o: {
  taskId: number; recipient: Recipient; sessionId: string | null; cwd: string; limits: ContextLimits
  history: (maxChars: number) => { body: string; count: number; omitted?: number } | null
}): Selection {
  const probe = o.history(o.limits.packageChars - TITLE_MARGIN)
  // So ha o que transferir quando este destino NAO viu a conversa: historico de outro provedor/conta ou sessao nova. Uma sessao em andamento que ja
  // viu tudo segue sem pedido, mesmo havendo memoria na tarefa (senao toda mensagem viraria uma aprovacao).
  if (!probe && o.sessionId) return { candidate: null, omitted: [], requirementsOmitted: false }
  const mem = selectMemory(db, { ...o, withHistory: !!probe })
  const omitted = [...mem.omitted]
  const items = [...mem.items]
  if (probe) {
    const room = o.limits.packageChars - mem.usedChars - TITLE_MARGIN
    const hist = room >= MIN_HISTORY_CHARS ? o.history(room) : null
    if (hist) {
      items.push({ ref: 'hist', kind: 'history', title: `Historico anterior da tarefa (${hist.count} mensagem(ns))`, content: hist.body })
      if (hist.omitted) omitted.push({ ref: 'hist', kind: 'history', title: 'Historico anterior (mensagens mais antigas)', why: `${hist.omitted} mensagem(ns) mais antiga(s) nao couberam no limite de ${o.limits.packageChars} caracteres do pacote` })
    } else omitted.push({ ref: 'hist', kind: 'history', title: 'Historico anterior da tarefa', why: `sem espaco no pacote (memoria pertinente usou ${mem.usedChars} de ${o.limits.packageChars} caracteres): amplie o limite ou escolha menos itens` })
  }
  return { candidate: items.length ? { items, omitted } : null, omitted, requirementsOmitted: omitted.some(x => x.requirement) }
}
