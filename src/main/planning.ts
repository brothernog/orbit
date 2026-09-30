// To-do persistida: importação única e revisão otimista impedem sobrescrever mudanças de outra tela.
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createTask, getTask } from './tasks.ts'

export type TodoItem = { id: string; text: string; done: boolean; images: string[]; project?: string; agent?: string; taskId?: number }
export type TodoTopic = { id: string; title: string; open: boolean; items: TodoItem[] }
export type TodoBoard = { revision: number; topics: TodoTopic[] }
const KEY = 'todoBoard'
const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error(field + ' inválido.')
  return v
}
export function normalizeTodo(raw: unknown): TodoTopic[] {
  if (!Array.isArray(raw) || raw.length > 200 || JSON.stringify(raw).length > 32 * 1024 * 1024) throw Error('Lista inválida ou grande demais (32 MB).')
  const ids = new Set<string>(); let count = 0
  const id = (v: unknown) => { const s = str(v, 80, 'ID'); if (ids.has(s)) throw Error('ID repetido.'); ids.add(s); return s }
  return raw.map(t => {
    if (!Array.isArray(t?.items)) throw Error('Itens inválidos.')
    return { id: id(t.id), title: str(t.title, 200, 'Tópico'), open: t.open !== false, items: t.items.map((i: any) => {
      if (++count > 2000 || !Array.isArray(i?.images) || i.images.length > 100 || i.images.some((s: unknown) => typeof s !== 'string' || s.length > 12 * 1024 * 1024 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s))) throw Error('Itens ou imagens inválidos.')
      const taskId = i.taskId == null ? undefined : Number(i.taskId)
      if (taskId !== undefined && (!Number.isSafeInteger(taskId) || taskId < 1)) throw Error('Tarefa inválida.')
      return { id: id(i.id), text: str(i.text, 20000, 'Item'), done: i.done === true, images: i.images,
        ...(i.project ? { project: str(i.project, 2000, 'Projeto') } : {}), ...(i.agent ? { agent: str(i.agent, 80, 'Agente') } : {}), ...(taskId ? { taskId } : {}) }
    }) }
  })
}
export function todoBoard(db: DatabaseSync, legacy?: unknown): TodoBoard {
  let row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as { value: string } | undefined
  if (!row) {
    const topics = legacy == null ? [] : normalizeTodo(legacy)
    const value = JSON.stringify({ revision: 0, topics: topics.length ? topics : [{ id: randomUUID(), title: 'Entrada', open: true, items: [] }] })
    db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(KEY, value)
    row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as { value: string }
  }
  return JSON.parse(row.value)
}
export function saveTodo(db: DatabaseSync, revision: unknown, raw: unknown): TodoBoard {
  const prev = todoBoard(db)
  if (revision !== prev.revision) throw Error('A lista mudou em outra tela. Recarregue e tente novamente.')
  const topics = normalizeTodo(raw)
  if (!topics.length) throw Error('Mantenha ao menos um tópico na lista.')
  const links = new Map(prev.topics.flatMap(t => t.items).map(i => [i.id, i]))
  for (const item of topics.flatMap(t => t.items)) {
    const old = links.get(item.id)
    if (item.taskId !== old?.taskId || (item.taskId && item.project !== old?.project)) throw Error('O vínculo de tarefa só pode ser criado pelo dashboard.')
  }
  const next = { revision: prev.revision + 1, topics }
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(next), KEY)
  return next
}
export function todoTask(db: DatabaseSync, topicId: string, itemId: string, game: string) {
  todoBoard(db)
  db.exec('BEGIN')
  try {
    const board = todoBoard(db), item = board.topics.find(t => t.id === topicId)?.items.find(i => i.id === itemId)
    if (!item || item.done) throw Error('Item inexistente ou já concluído.')
    if (!item.project || item.project.toLowerCase() !== game.toLowerCase()) throw Error('Escolha o projeto do item antes de preparar a tarefa.')
    const linked = item.taskId && getTask(db, item.taskId)
    if (linked && linked.game.toLowerCase() !== game.toLowerCase()) throw Error('Tarefa vinculada a outro projeto.')
    const created = !linked
    const taskId = linked ? linked.id : createTask(db, game, item.text.replace(/\s+/g, ' ').slice(0, 200))
    item.taskId = taskId; board.revision++
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(board), KEY)
    db.exec('COMMIT')
    return { board, taskId, game, created, text: item.text, images: item.images, agent: item.agent }
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
