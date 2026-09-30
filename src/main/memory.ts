// Memoria estruturada por tarefa: itens curtos com origem, escopo, evidencia e validade. Nada cruza task_id e nenhum item
// e distribuido automaticamente (isso e o consentimento, em consent.ts). Sem LLM, sem embeddings: SQLite e hashes de arquivo.
// Sem dependencia de 'electron'.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sha } from './artifacts.ts'
import { safeJoin } from './guard.ts'

const get = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]

export const KINDS = ['objective', 'constraint', 'decision', 'todo', 'finding', 'validation', 'checkpoint'] as const
export type Kind = (typeof KINDS)[number]
export const TODO_STATES = ['open', 'doing', 'done', 'blocked']
export const MAX_TITLE = 200
export const MAX_CONTENT = 4000 // itens sao curtos e identificaveis; transcricao integral nao e memoria

export type FileEvidence = { path: string; hash: string; size: number }
// source: agent_reported = o agente DISSE que rodou (o dashboard so recebeu o texto); executor_observed = o proprio dashboard executou/capturou.
// Registros antigos nao tem source/roots/configs: nunca sao tratados como observados nem como cobertura completa.
export type EvidenceSource = 'agent_reported' | 'executor_observed'
export type TestEvidence = {
  command: string; cwd: string; exitCode: number; durationMs?: number; hermetic: boolean; network: boolean; env: string | null; summary: string
  source?: EvidenceSource
  roots?: string[] // dependencias DECLARADAS (arquivos/pastas relativos a area): reenumeradas a cada consulta
  configs?: string[] // configuracoes/lockfiles pertinentes encontrados na raiz da area quando foi registrado
  depsComplete?: boolean; depsNote?: string // false = nao foi possivel enumerar/cobrir as dependencias: validade desconhecida
}
export type Evidence = { files?: FileEvidence[]; artifacts?: number[]; test?: TestEvidence }

export type MemoryInput = {
  taskId: number; owner: 'user' | 'run' | 'delegation'; originId?: number; lineage: string
  grantId?: string | null // identidade de execucao que escreveu (consent.ts): so ela le o item sem pacote aprovado; ausente (usuario/legado) = nenhum agente
  kind: string; title: string; content: string
  paths?: string[] // escopo: caminhos relativos a que o item se aplica (nao e evidencia)
  evidence?: Evidence
  todoState?: string; deps?: number[]; supersedes?: number
}

// Texto normalizado para busca: minusculas, sem acentos, espacos colapsados.
export const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const bad = (m: string): never => { throw new Error(m) }

export type MemoryRow = {
  id: number; task_id: number; owner: string; origin_id: number | null; lineage: string; grant_id: string | null; kind: string; title: string; content: string
  paths: string[]; evidence: Evidence; revision: number; hash: string; state: string; todo_state: string | null; deps: number[]
  conflict_with: number | null; supersedes: number | null; created_at: string; updated_at: string
}
const load = (r: any): MemoryRow => ({ ...r, paths: JSON.parse(r.paths), evidence: JSON.parse(r.evidence), deps: JSON.parse(r.deps) })
export const getMemory = (db: DatabaseSync, taskId: number, id: number): MemoryRow | null => {
  const r = get(db, 'SELECT * FROM memory_items WHERE id=? AND task_id=?', id, taskId)
  return r ? load(r) : null
}

// Hash de conteudo dos arquivos que sustentam um item. Caminho relativo a area de trabalho e validado (links para fora sao recusados).
export function fileEvidence(workspace: string, rels: string[]): FileEvidence[] {
  return rels.map(rel => {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) bad(`Caminho fora da area de trabalho: "${rel}".`)
    const abs = safeJoin(workspace, rel)
    if (!fs.statSync(abs).isFile()) bad(`Evidencia precisa ser um arquivo: "${rel}".`)
    return { path: path.relative(fs.realpathSync(workspace), abs).split(path.sep).join('/'), hash: sha(fs.readFileSync(abs)), size: fs.statSync(abs).size }
  })
}

export function addMemory(db: DatabaseSync, i: MemoryInput): { id: number; deduped: boolean; conflictWith?: number; revision: number } {
  if (!(KINDS as readonly string[]).includes(i.kind)) bad(`kind invalido. Opcoes: ${KINDS.join(', ')}.`)
  const title = i.title.trim(), content = i.content.trim()
  if (!title || title.length > MAX_TITLE) bad(`title obrigatorio (ate ${MAX_TITLE} caracteres).`)
  if (!content || content.length > MAX_CONTENT) bad(`content obrigatorio (ate ${MAX_CONTENT} caracteres; guarde texto longo como artefato).`)
  const paths = i.paths ?? []
  if (paths.length > 20 || paths.some(p => !p || p.length > 300 || /[\0\r\n]/.test(p))) bad('paths: ate 20 caminhos relativos.')
  if (i.todoState !== undefined && (i.kind !== 'todo' || !TODO_STATES.includes(i.todoState))) bad(`todoState so vale para kind todo (${TODO_STATES.join(', ')}).`)
  const deps = i.deps ?? []
  for (const d of deps) if (!getMemory(db, i.taskId, d)) bad(`Dependencia #${d} nao existe nesta tarefa.`)
  const hash = sha([i.kind, title, content].join('\0'))
  const pathsJson = JSON.stringify(paths)
  // Identico (conteudo + origem + escopo): nao duplica.
  const grantId = i.grantId ?? null
  const dup = get(db, "SELECT id, revision FROM memory_items WHERE task_id=? AND kind=? AND hash=? AND lineage=? AND grant_id IS ? AND paths=? AND state<>'superseded'", i.taskId, i.kind, hash, i.lineage, grantId, pathsJson)
  if (dup) return { id: dup.id, deduped: true, revision: dup.revision }

  let revision = 1, supersedes: number | null = null
  if (i.supersedes) {
    const old = getMemory(db, i.taskId, i.supersedes) ?? bad(`Item #${i.supersedes} nao existe nesta tarefa.`)
    // Substituir e escrever: so a mesma identidade de execucao (mesma linhagem E mesmo grant) altera o que escreveu; itens alheios ou do usuario nao.
    if (i.owner !== 'user' && (old.lineage !== i.lineage || old.grant_id !== grantId)) bad('So a propria linhagem substitui seus itens.')
    revision = old.revision + 1; supersedes = old.id
    db.prepare("UPDATE memory_items SET state='superseded', updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?").run(old.id)
  } else if (i.kind === 'checkpoint') {
    // Um checkpoint vigente por identidade de execucao: o novo substitui o anterior (a proveniencia do antigo continua no banco).
    const prev = get(db, "SELECT id, revision FROM memory_items WHERE task_id=? AND kind='checkpoint' AND lineage=? AND grant_id IS ? AND state<>'superseded' ORDER BY id DESC LIMIT 1", i.taskId, i.lineage, grantId)
    if (prev) { revision = prev.revision + 1; supersedes = prev.id; db.prepare("UPDATE memory_items SET state='superseded' WHERE id=?").run(prev.id) }
  }
  // Fato conflitante (mesmo tipo e titulo, conteudo diferente) DA MESMA identidade: os dois ficam ativos e sinalizados; nada e sobrescrito em
  // silencio. Itens de outras identidades nao entram (o aviso nao pode revelar que existem nem seus IDs).
  const clash = supersedes || i.kind === 'todo' || i.kind === 'checkpoint' ? null
    : all(db, "SELECT id, title FROM memory_items WHERE task_id=? AND kind=? AND state='active' AND hash<>? AND lineage=? AND grant_id IS ?", i.taskId, i.kind, hash, i.lineage, grantId).find(r => normalize(r.title) === normalize(title))
  const id = Number(db.prepare(`INSERT INTO memory_items (task_id, owner, origin_id, lineage, grant_id, kind, title, content, paths, evidence, revision, hash, norm, todo_state, deps, conflict_with, supersedes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(i.taskId, i.owner, i.originId ?? null, i.lineage, grantId, i.kind, title, content, pathsJson, JSON.stringify(i.evidence ?? {}), revision, hash,
      normalize(`${title} ${content} ${paths.join(' ')}`), i.kind === 'todo' ? i.todoState ?? 'open' : null, JSON.stringify(deps), clash?.id ?? null, supersedes).lastInsertRowid)
  return { id, deduped: false, conflictWith: clash?.id, revision }
}

export function setTodoState(db: DatabaseSync, taskId: number, id: number, state: string) {
  const m = getMemory(db, taskId, id)
  if (!m || m.kind !== 'todo') bad('Item nao e um todo desta tarefa.')
  if (!TODO_STATES.includes(state)) bad('Estado de todo invalido.')
  db.prepare("UPDATE memory_items SET todo_state=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?").run(state, id)
}
// Todo pronto = aberto com todas as dependencias concluidas.
export const todoReady = (db: DatabaseSync, m: MemoryRow) => m.kind === 'todo' && m.todo_state === 'open' && m.deps.every(d => getMemory(db, m.task_id, d)?.todo_state === 'done')

export type Validity = { validity: 'valid' | 'stale' | 'unknown' | 'superseded'; changed: string[] }
// Confere os arquivos declarados como evidencia. Tamanho diferente prova mudanca sem ler; tamanho igual ainda exige o hash
// (mtime/tamanho sozinhos nao fundamentam validade). Sem evidencia declarada a validade e desconhecida, nao "valida".
export function validate(db: DatabaseSync, m: MemoryRow, workspace: string): Validity {
  if (m.state === 'superseded') return { validity: 'superseded', changed: [] }
  const files = m.evidence.files ?? []
  if (!files.length) return { validity: m.state === 'stale' ? 'stale' : 'unknown', changed: [] }
  const changed: string[] = []
  for (const f of files) {
    try {
      const abs = safeJoin(workspace, f.path)
      const st = fs.statSync(abs)
      if (st.size !== f.size || sha(fs.readFileSync(abs)) !== f.hash) changed.push(f.path)
    } catch { changed.push(f.path) } // sumiu ou saiu da area: nao ha como confirmar
  }
  if (changed.length && m.state === 'active') db.prepare("UPDATE memory_items SET state='stale', updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?").run(m.id)
  return { validity: changed.length || m.state === 'stale' ? 'stale' : 'valid', changed }
}

export type SearchOpts = { taskId: number; lineages?: string[]; grantId?: string; kind?: string; path?: string; text?: string; state?: string; afterId?: number; limit?: number }
// Ordem estavel por id. Texto: todos os termos (normalizados) precisam aparecer. Caminho: item cujo escopo contem/esta contido.
export function searchMemory(db: DatabaseSync, o: SearchOpts): { items: MemoryRow[]; next: number | null } {
  const where = ['task_id=?', 'id>?']
  const args: any[] = [o.taskId, o.afterId ?? 0]
  if (o.lineages) { where.push(`lineage IN (${o.lineages.map(() => '?').join(',') || "''"})`); args.push(...o.lineages) }
  if (o.grantId) { where.push('grant_id=?'); args.push(o.grantId) }
  if (o.kind) { where.push('kind=?'); args.push(o.kind) }
  where.push(o.state ? 'state=?' : "state<>'superseded'"); if (o.state) args.push(o.state)
  for (const term of normalize(o.text ?? '').split(' ').filter(Boolean)) { where.push("norm LIKE ? ESCAPE '\\'"); args.push(`%${term.replace(/[\\%_]/g, m => '\\' + m)}%`) }
  const limit = Math.max(1, o.limit ?? 10)
  const want = o.path ? normalize(o.path).replace(/\/$/, '') : ''
  const out: MemoryRow[] = []
  let next: number | null = null
  for (const r of all(db, `SELECT * FROM memory_items WHERE ${where.join(' AND ')} ORDER BY id`, ...args)) {
    const m = load(r)
    if (want && !m.paths.some(p => { const x = normalize(p).replace(/\/$/, ''); return x === want || x === '.' || want.startsWith(x + '/') || x.startsWith(want + '/') })) continue
    if (out.length === limit) { next = out[out.length - 1].id; break }
    out.push(m)
  }
  return { items: out, next }
}

// Checkpoint DETERMINISTICO (sem LLM): reune o que a linhagem ja registrou (objetivo, restricoes, decisoes, evidencias, pendencias e
// proxima acao). Chamado so em conclusao de unidade de trabalho / troca de responsavel / compactacao observada, nunca por mensagem.
// O que nao couber e contado e continua no indice: nada e apagado para economizar.
export function buildCheckpoint(db: DatabaseSync, taskId: number, lineage: string, grantId: string | null = null): number | null {
  const items = all(db, "SELECT * FROM memory_items WHERE task_id=? AND lineage=? AND grant_id IS ? AND state='active' AND kind<>'checkpoint' ORDER BY id", taskId, lineage, grantId).map(load)
  if (!items.length) return null
  const line = (m: MemoryRow) => `- m:${m.id} ${m.title}${m.conflict_with ? ` (CONFLITA com m:${m.conflict_with})` : ''}`
  const sec = (label: string, xs: MemoryRow[]) => (xs.length ? [`${label}:`, ...xs.map(line)] : [])
  const of = (k: string) => items.filter(m => m.kind === k)
  const open = of('todo').filter(m => m.todo_state !== 'done')
  const next = open.find(m => todoReady(db, m))
  const body = [
    ...sec('Objetivo', of('objective')), ...sec('Restricoes', of('constraint')), ...sec('Decisoes', of('decision')), ...sec('Evidencias (validacoes)', of('validation')),
    ...sec('Pendencias', open), `Descobertas registradas: ${of('finding').length} (ver indice)`, next ? `Proxima acao: m:${next.id} ${next.title}` : 'Proxima acao: nao ha todo pronto'
  ]
  let content = body.join('\n')
  if (content.length > MAX_CONTENT) {
    let cut = body.length
    while (cut > 1 && body.slice(0, cut).join('\n').length > MAX_CONTENT - 80) cut--
    content = `${body.slice(0, cut).join('\n')}\n… (${body.length - cut} linhas omitidas: consulte o indice)`
  }
  return addMemory(db, { taskId, owner: 'run', lineage, grantId, kind: 'checkpoint', title: 'Checkpoint da linhagem', content }).id
}
