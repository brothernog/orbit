// Artefatos: resultado completo de delegacoes, testes e ferramentas, guardado uma vez e recuperavel por referencia.
// Leitura sempre paginada e restrita a tarefa e a linhagem autorizada. Sem dependencia de 'electron'.
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const get = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]

export const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex')

export type ArtifactInput = {
  taskId: number; producer: string; readers?: string[]; kind: string; title?: string; content: string
  runId?: number; delegationId?: number; scope?: string[]; meta?: object
}

// Mesmo conteudo/tipo/produtor na mesma tarefa reaproveita o artefato (os leitores autorizados se juntam). `readers` guarda identidades de
// execucao (grants, consent.ts); o nome do produtor identifica a origem e NAO concede leitura.
export function saveArtifact(db: DatabaseSync, a: ArtifactInput) {
  const hash = sha(a.content)
  const dup = get(db, 'SELECT id, readers FROM artifacts WHERE task_id=? AND kind=? AND producer=? AND hash=?', a.taskId, a.kind, a.producer, hash)
  if (dup) {
    const readers = [...new Set([...JSON.parse(dup.readers), ...(a.readers ?? [])])]
    db.prepare('UPDATE artifacts SET readers=? WHERE id=?').run(JSON.stringify(readers), dup.id)
    return { id: dup.id as number, size: a.content.length, hash, reused: true }
  }
  const id = Number(db.prepare('INSERT INTO artifacts (task_id, run_id, delegation_id, producer, readers, kind, title, content, size, hash, scope, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(a.taskId, a.runId ?? null, a.delegationId ?? null, a.producer, JSON.stringify(a.readers ?? []), a.kind, a.title ?? null, a.content, a.content.length, hash,
      a.scope ? JSON.stringify(a.scope) : null, a.meta ? JSON.stringify(a.meta) : null).lastInsertRowid)
  return { id, size: a.content.length, hash, reused: false }
}

export const canReadArtifact = (row: { readers: string }, reader: string) => (JSON.parse(row.readers) as string[]).includes(reader)

// Pagina por caracteres. `next` = deslocamento da proxima pagina (null = fim). Tarefa e identidade (grant) vem do token, nunca do agente.
export function readArtifact(db: DatabaseSync, o: { taskId: number; reader: string; id: number; offset?: number; limit: number; asUser?: boolean }) {
  const r = get(db, 'SELECT * FROM artifacts WHERE id=? AND task_id=?', o.id, o.taskId)
  if (!r || (!o.asUser && !canReadArtifact(r, o.reader))) return null // inexistente e nao autorizado sao indistinguiveis: nao revela o que existe (asUser: o proprio dono da tarefa, pela interface)
  const offset = Math.max(0, Math.min(o.offset ?? 0, r.size))
  const content = (r.content as string).slice(offset, offset + o.limit)
  const end = offset + content.length
  return { id: r.id as number, kind: r.kind as string, title: r.title as string | null, size: r.size as number, hash: r.hash as string, offset, content, next: end < r.size ? end : null }
}

// Lista sem conteudo (metadados) para a interface e para o indice do agente.
export const listArtifacts = (db: DatabaseSync, taskId: number, reader?: string) =>
  all(db, 'SELECT id, kind, title, size, hash, producer, readers, delegation_id, run_id, created_at FROM artifacts WHERE task_id=? ORDER BY id DESC LIMIT 200', taskId)
    .filter(r => !reader || canReadArtifact(r, reader))
    .map(({ readers: _r, producer: _p, ...r }) => r)
