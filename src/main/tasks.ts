import type { TodoBoard } from './planning.ts'
// Tarefas por projeto: identidade, historico unico, sessoes por provedor e transferencia explicita de contexto.
// Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'

export const DEFAULT_TITLE = 'Nova tarefa'
export const TASK_STATES = ['aberta', 'andamento', 'concluida']

export type Task = {
  id: number; game: string; title: string; state: string; legacy: string | null; pin_id: number | null
  branch: string | null; worktree: string | null; created_at: string; updated_at: string; archived_at: string | null
}

const get = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export const getTask = (db: DatabaseSync, id: number): Task => get(db, 'SELECT * FROM tasks WHERE id=?', id)

export function createTask(db: DatabaseSync, game: string, title = DEFAULT_TITLE, pinId?: number | null) {
  return Number(db.prepare("INSERT INTO tasks (game, title, pin_id, created_at, updated_at) VALUES (?,?,?, strftime('%Y-%m-%d %H:%M:%f','now'), strftime('%Y-%m-%d %H:%M:%f','now'))").run(game, title.trim() || DEFAULT_TITLE, pinId ?? null).lastInsertRowid)
}

// Tarefa ligada a um problema (pin): reaproveita a existente; senao cria ja com o vinculo de branch/worktree do pin.
export function taskForPin(db: DatabaseSync, pin: any) {
  const t = get(db, 'SELECT id FROM tasks WHERE pin_id=?', pin.id)
  if (t) return t.id as number
  const id = createTask(db, pin.game, pin.title, pin.id)
  db.prepare('UPDATE tasks SET branch=?, worktree=? WHERE id=?').run(pin.branch, pin.worktree, id)
  return id
}

// Mais recentes primeiro. `search` procura no titulo e no texto das mensagens.
export function listTasks(db: DatabaseSync, game: string, o: { search?: string; archived?: boolean } = {}) {
  const like = o.search?.trim() ? `%${o.search.trim().replace(/[\\%_]/g, m => '\\' + m)}%` : null
  return all(db, `
    SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.task_id=t.id AND m.role<>'system') AS messages
    FROM tasks t
    WHERE t.game=? AND (t.archived_at IS NOT NULL) = ?
      AND (? IS NULL OR t.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.task_id=t.id AND m.text LIKE ? ESCAPE '\\'))
    ORDER BY t.updated_at DESC, t.id DESC`, game, o.archived ? 1 : 0, like, like, like) as (Task & { messages: number })[]
}

export const renameTask = (db: DatabaseSync, id: number, title: string) => {
  const t = title.trim()
  if (!t) throw new Error('Titulo vazio.')
  db.prepare('UPDATE tasks SET title=? WHERE id=?').run(clip(t, 200), id)
}
// Arquivar so esconde da lista: nao apaga mensagens, arquivos nem worktrees.
export const setArchived = (db: DatabaseSync, id: number, archived: boolean) =>
  db.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(archived ? new Date().toISOString() : null, id)
export const setTaskState = (db: DatabaseSync, id: number, state: string) => {
  if (!TASK_STATES.includes(state)) throw new Error('Estado invalido.')
  db.prepare('UPDATE tasks SET state=? WHERE id=?').run(state, id)
}
// Primeira mensagem da tarefa com titulo padrao vira o titulo.
// Devolve o titulo provisorio gravado (ou null se a tarefa ja tinha titulo) para o resumo do agente substitui-lo depois.
export const autoTitle = (db: DatabaseSync, id: number, firstMessage: string) => {
  const t = clip(firstMessage.replace(/\s+/g, ' ').trim(), 60) || DEFAULT_TITLE
  return db.prepare('UPDATE tasks SET title=? WHERE id=? AND title=?').run(t, id, DEFAULT_TITLE).changes ? t : null
}
// Titulo-resumo que o agente escreve na primeira resposta (<titulo>...</titulo>): some do texto, inclusive a tag ainda incompleta no streaming.
const TITLE_TAG = /\s*<titulo>([\s\S]*?)<\/titulo>\s*/i
export const stripTitle = (s: string) => s.replace(TITLE_TAG, '\n').replace(/\s*<(?:t(?:i(?:t(?:u(?:l(?:o(?:>[\s\S]*)?)?)?)?)?)?)?$/i, '').trim()
export const titleIn = (s: string) => s.match(TITLE_TAG)?.[1].replace(/\s+/g, ' ').replace(/^["'“]|["'”.]$/g, '').trim() || null
// So troca se o usuario nao renomeou nesse meio-tempo (o titulo ainda e o provisorio).
export const summaryTitle = (db: DatabaseSync, id: number, title: string, provisional: string) =>
  db.prepare('UPDATE tasks SET title=? WHERE id=? AND title=?').run(clip(title, 60), id, provisional)

// So as colunas que o chat mostra (renderer/api.ts Msg): clean/clean_parts (transferencia de contexto) nao vao a cada abertura.
export const taskMessages = (db: DatabaseSync, id: number) => all(db, 'SELECT id, role, text, status, provider, account_id, model, effort, created_at FROM messages WHERE task_id=? ORDER BY id', id)

// ---- Sessoes nativas: uma por (tarefa, provedor, perfil). Provedores diferentes nunca compartilham sessao.
export const profileOf = (provider: string, accountId?: number | null) => (provider === 'claude' ? String(accountId ?? '') : '')

export const sessionOf = (db: DatabaseSync, taskId: number, provider: string, profile: string): string | undefined =>
  get(db, 'SELECT session_id FROM task_sessions WHERE task_id=? AND provider=? AND profile=?', taskId, provider, profile)?.session_id
export const saveSession = (db: DatabaseSync, taskId: number, provider: string, profile: string, sid: string) =>
  db.prepare('INSERT INTO task_sessions (task_id, provider, profile, session_id) VALUES (?,?,?,?) ON CONFLICT(task_id, provider, profile) DO UPDATE SET session_id=excluded.session_id')
    .run(taskId, provider, profile, sid)

// Nova sessao: esquece a sessao nativa (e a medida de contexto dela) deste provedor/perfil. A proxima mensagem comeca do zero; o historico
// recente so segue como pacote de contexto aprovado pelo usuario (mesmo caminho de quem nunca teve sessao: contextFor + consentimento).
export function resetSession(db: DatabaseSync, taskId: number, provider: string, profile: string): boolean {
  const n = db.prepare('DELETE FROM task_sessions WHERE task_id=? AND provider=? AND profile=?').run(taskId, provider, profile).changes
  db.prepare('DELETE FROM metrics WHERE task_id=? AND provider=? AND profile=?').run(taskId, provider, profile)
  return n > 0
}

// Historicos antigos (sem `clean`) trazem os marcadores de ferramenta (linha inteira entre crases iniciada por "> ") e o aviso de cancelamento.
export const stripActivity = (t: string) => t.replace(/^`> .*`[ \t]*$/gm, '').replace(/^_Execucao cancelada\._[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()

// Resposta do agente como vai na transferencia: sem marcadores de ferramenta nem avisos. Cabendo no limite por mensagem, vai inteira.
// Passando, e havendo falas separadas (CLI sem resposta final marcada), ficam as ULTIMAS falas inteiras que couberem (a resposta costuma
// estar no fim; a narracao intermediaria no comeco), com a contagem das omitidas; o texto integral continua no historico. Sem falas: corte antigo.
const MESSAGE_CHARS = 3000
export function agentBody(m: { text: string; clean?: string | null; clean_parts?: string | null }): string {
  const full = stripActivity(m.clean ?? m.text)
  if (full.length <= MESSAGE_CHARS || !m.clean_parts) return full
  let parts: string[]
  try { parts = (JSON.parse(m.clean_parts) as unknown[]).filter((p): p is string => typeof p === 'string').map(stripActivity).filter(Boolean) } catch { return full }
  if (parts.length < 2) return full
  const note = (n: number) => `(${n} fala(s) anterior(es) do agente nesta resposta omitida(s) por limite; o texto integral esta no historico da tarefa)\n\n`
  const kept: string[] = []
  let size = note(parts.length).length
  for (let i = parts.length - 1; i >= 0; i--) {
    const add = parts[i].length + (kept.length ? 2 : 0)
    if (kept.length && size + add > MESSAGE_CHARS) break
    kept.unshift(parts[i]); size += add // a ultima fala entra sempre (cortada pelo limite geral se sozinha passar dele)
  }
  const omitted = parts.length - kept.length
  return omitted ? `${note(omitted)}${kept.join('\n\n')}` : full
}

// ---- Transferencia de contexto entre sessoes nativas diferentes.
// Sessao nova: envia o historico da tarefa. Sessao existente: envia so o que aconteceu em outros provedores/contas
// depois da ultima resposta dela. Respostas que falharam (so mensagem de erro) nao entram. Vem do historico salvo, nunca da sessao de outra plataforma.
export function contextFor(db: DatabaseSync, taskId: number, provider: string, accountId: number | null | undefined, hasSession: boolean, maxChars = 12_000) {
  let after = 0
  if (hasSession) {
    after = get(db, "SELECT MAX(id) id FROM messages WHERE task_id=? AND role='agent' AND provider=? AND COALESCE(account_id,0)=COALESCE(?,0) AND (status IS NULL OR status IN ('completed','cancelled'))", taskId, provider, accountId ?? null)?.id ?? Infinity
    if (after === Infinity) return null // sessao migrada sem historico proprio: ela ja tem o que precisa
  }
  const where = "task_id=? AND id>? AND role IN ('user','agent') AND text<>'' AND NOT (role='agent' AND status='failed')"
  const lines: string[] = []
  let size = 0, considered = 0, full = 0
  // Do mais novo para o mais antigo, uma linha por vez, ate o limite (janela contigua: nunca pula uma mensagem grande para pegar uma antiga).
  // O historico inteiro nao e carregado: so as mensagens da janela vem com todas as colunas.
  for (const m of db.prepare(`SELECT id, role, provider, text, clean, clean_parts FROM messages WHERE ${where} ORDER BY id DESC`).iterate(taskId, after) as Iterable<any>) {
    const body = m.role === 'agent' ? agentBody(m) : m.text
    if (!body) continue
    considered++ // as que nao couberem continuam contadas: o usuario ve quantas ficaram de fora
    const line = `${m.role === 'user' ? 'Usuario' : `Agente (${m.provider ?? 'desconhecido'})`}: ${clip(body, MESSAGE_CHARS)}`
    if (size + line.length > maxChars && lines.length) { full = m.id; break }
    lines.unshift(line)
    size += line.length + 2 // + separador entre mensagens: o corpo final nunca passa de maxChars
  }
  // Mais antigas que nao couberam: so a contagem (corpo nao vazio = agentBody nao vazio = texto sem marcadores nao vazio).
  if (full) for (const r of db.prepare(`SELECT role, COALESCE(clean, text) AS body FROM messages WHERE ${where} AND id<?`).iterate(taskId, after, full) as Iterable<any>)
    if (r.role === 'user' || stripActivity(r.body)) considered++
  if (!lines.length) return null
  const text = `[Contexto transferido pelo dashboard: esta sessao nao viu a conversa abaixo, que aconteceu antes na mesma tarefa (mais antigo primeiro). Use-a como contexto, sem refazer o que ja foi feito.]\n\n${lines.join('\n\n')}\n\n[Fim do contexto transferido]\n\n`
  return { text, body: lines.join('\n\n'), count: lines.length, omitted: considered - lines.length } // body = so as mensagens (vira o item do pacote); omitted = mensagens mais antigas que nao couberam
}

// ---- Escolha de provedor/perfil/modelo/esforco por tarefa (vale a partir da proxima execucao).
export type TaskSel = { provider: string; accountId?: number; model?: string; effort?: string }
export const getSel = (db: DatabaseSync, taskId: number): TaskSel | null => {
  try { return JSON.parse(get(db, 'SELECT sel FROM tasks WHERE id=?', taskId)?.sel ?? 'null') } catch { return null }
}
export const saveSel = (db: DatabaseSync, taskId: number, s: TaskSel) =>
  db.prepare('UPDATE tasks SET sel=? WHERE id=?').run(JSON.stringify(s), taskId)

// ---- Ultima medida por sessao (tarefa, provedor, perfil). Campo ausente fica NULL: falta de dado nunca vira 0.
export type StoredMetric = {
  model: string | null; effort: string | null; occupied: number | null; capacity: number | null; estimated: boolean
  consumed_in: number | null; consumed_out: number | null; scope: string | null; source: string | null; at: string
}
export function getMetric(db: DatabaseSync, taskId: number, provider: string, profile: string): StoredMetric | null {
  const r = get(db, 'SELECT * FROM metrics WHERE task_id=? AND provider=? AND profile=?', taskId, provider, profile)
  return r ? { ...r, estimated: !!r.estimated } : null
}
// Guarda a medida de uma execucao. Contexto e janela so sao herdados da medida anterior se o MODELO for o mesmo
// (mudar de modelo invalida a janela e o contexto anteriores); consumo sempre e o da execucao mais recente.
export function saveMetric(
  db: DatabaseSync, taskId: number, provider: string, profile: string, model: string | null, effort: string | null,
  m: { occupied?: number; capacity?: number; consumedIn?: number; consumedOut?: number; scope?: string; estimated?: boolean; source: string }
) {
  const prev = getMetric(db, taskId, provider, profile)
  const same = prev && (prev.model ?? null) === (model ?? null)
  const occupied = m.occupied ?? (same ? prev.occupied : null)
  const capacity = m.capacity ?? (same ? prev.capacity : null)
  const estimated = m.occupied !== undefined ? !!m.estimated : same ? prev.estimated : false
  db.prepare(`INSERT INTO metrics (task_id, provider, profile, model, effort, occupied, capacity, estimated, consumed_in, consumed_out, scope, source, at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT(task_id, provider, profile) DO UPDATE SET model=excluded.model, effort=excluded.effort, occupied=excluded.occupied, capacity=excluded.capacity,
      estimated=excluded.estimated, consumed_in=excluded.consumed_in, consumed_out=excluded.consumed_out, scope=excluded.scope, source=excluded.source, at=excluded.at`)
    .run(taskId, provider, profile, model, effort, occupied ?? null, capacity ?? null, estimated ? 1 : 0, m.consumedIn ?? null, m.consumedOut ?? null, m.scope ?? null, m.source)
}

// Exclusao definitiva: a tarefa e tudo que so existe por ela (mensagens, execucoes, sessoes, memoria, pacotes, uso...). Todas as
// tabelas com task_id entram automaticamente (tabela nova nao vira orfa). Arquivos do projeto e worktrees ficam no disco.
export function deleteTask(db: DatabaseSync, taskId: number) {
  const tables = all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name<>'tasks'").map(t => t.name as string)
    .filter(t => all(db, `PRAGMA table_info("${t}")`).some(c => c.name === 'task_id'))
  db.exec('BEGIN')
  try {
    // O build pertence ao projeto; limpar referências antes do SQLite poder reutilizar IDs.
    db.prepare('UPDATE project_builds SET source_task_id=NULL, source_command_id=NULL WHERE source_task_id=? OR source_command_id IN (SELECT id FROM command_runs WHERE task_id=?)').run(taskId, taskId)
    db.prepare('DELETE FROM context_deliveries WHERE package_id IN (SELECT id FROM context_packages WHERE task_id=?)').run(taskId) // sem task_id proprio
    for (const t of tables) db.prepare(`DELETE FROM "${t}" WHERE task_id=?`).run(taskId)
    // IDs INTEGER PRIMARY KEY podem ser reutilizados; limpar vínculos JSON na mesma transação impede abrir outra tarefa por engano.
    const todo = db.prepare("SELECT value FROM settings WHERE key='todoBoard'").get() as { value: string } | undefined
    if (todo) {
      const board = JSON.parse(todo.value) as TodoBoard
      const linked = board.topics.flatMap(t => t.items).filter(i => i.taskId === taskId)
      if (linked.length) { for (const item of linked) delete item.taskId; board.revision++; db.prepare("UPDATE settings SET value=? WHERE key='todoBoard'").run(JSON.stringify(board)) }
    }
    db.prepare('DELETE FROM tasks WHERE id=?').run(taskId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
