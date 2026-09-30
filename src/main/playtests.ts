// Evidência para revisão humana. Nada deste registro entra no chat ou na memória automaticamente.
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { asInt, asStr, inside } from './guard.ts'
import { attachImages, imagesIn, readImage } from './attachments.ts'

export type Playtest = {
  id: number; game: string; title: string; scenario: string; expected: string; observed: string
  outcome: 'pass' | 'fail' | 'mixed'; notes: string; severity: 'low' | 'medium' | 'high'
  state: 'open' | 'resolved'; pin_id: number | null; build_id: number | null; created_at: string; imageCount: number
}
type StoredPlaytest = Omit<Playtest, 'imageCount'> & { images: string }
const text = (v: unknown, field: string, max: number, required = false) => {
  const s = asStr(v ?? '', field, max).trim()
  if (required && !s) throw Error(`${field} obrigatório.`)
  return s
}
const choice = <T extends string>(v: unknown, values: readonly T[], field: string): T => {
  if (!values.includes(v as T)) throw Error(`${field} inválido.`)
  return v as T
}

export function createPlaytestService(db: DatabaseSync, dataDir: string) {
  const root = path.resolve(dataDir, 'playtests')
  const project = (v: unknown) => text(v, 'Projeto', 2048, true)
  const get = (game: string, id: unknown) => {
    const row = db.prepare('SELECT * FROM project_playtests WHERE game=? AND id=?').get(project(game), asInt(id, 'Playtest')) as StoredPlaytest | undefined
    if (!row) throw Error('Playtest não encontrado neste projeto.')
    return row
  }
  const present = (row: StoredPlaytest): Playtest => {
    const { images, ...rest } = row
    return { ...rest, imageCount: (JSON.parse(images) as string[]).length }
  }
  return {
    list(game: string): Playtest[] {
      return (db.prepare('SELECT * FROM project_playtests WHERE game=? ORDER BY id DESC').all(project(game)) as StoredPlaytest[]).map(present)
    },
    add(game: string, raw: unknown): number {
      game = project(game)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Playtest inválido.')
      const r = raw as Record<string, unknown>
      const title = text(r.title, 'Título', 200, true), scenario = text(r.scenario, 'Cenário', 4000)
      const expected = text(r.expected, 'Resultado esperado', 8000), observed = text(r.observed, 'Resultado observado', 8000, true)
      const notes = text(r.notes, 'Notas', 8000)
      const outcome = choice(r.outcome, ['pass', 'fail', 'mixed'] as const, 'Resultado')
      const severity = choice(r.severity ?? 'medium', ['low', 'medium', 'high'] as const, 'Severidade')
      const buildId = r.buildId == null ? null : asInt(r.buildId, 'Build')
      if (buildId !== null && !db.prepare('SELECT id FROM project_builds WHERE game=? AND id=?').get(game, buildId)) throw Error('Build não encontrada neste projeto.')
      const images = r.images ?? []
      if (!Array.isArray(images) || images.length > 6 || images.some(i => typeof i !== 'string' || i.length > 12 * 1024 * 1024)) throw Error('Imagens inválidas (até 6, máximo 8 MB cada).')
      // Cada tentativa possui sua pasta: falha na validação do helper nunca apaga uma captura anterior.
      const dir = path.resolve(root, randomUUID())
      try {
        const files = imagesIn(attachImages(dir, '', images), dir)
        return Number(db.prepare(`INSERT INTO project_playtests (game,title,scenario,expected,observed,outcome,notes,severity,images,build_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(game, title, scenario, expected, observed, outcome, notes, severity, JSON.stringify(files), buildId).lastInsertRowid)
      } catch (e) {
        if (inside(root, dir) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
        throw e
      }
    },
    setState(game: string, id: unknown, state: unknown): void {
      const row = get(game, id)
      const next = choice(state, ['open', 'resolved'] as const, 'Estado')
      db.prepare('UPDATE project_playtests SET state=? WHERE game=? AND id=?').run(next, row.game, row.id)
    },
    images(game: string, id: unknown): string[] {
      const row = get(game, id)
      return (JSON.parse(row.images) as string[]).map(p => readImage(p, [root])).filter((v): v is string => v !== null)
    },
    createIssue(game: string, id: unknown, title: unknown, instruction: unknown): number {
      const name = text(title, 'Título do problema', 200, true), body = text(instruction, 'Ordem de correção', 20_000, true)
      db.exec('BEGIN')
      try {
        const row = get(game, id)
        const linked = row.pin_id && db.prepare('SELECT id FROM pins WHERE game=? AND id=?').get(row.game, row.pin_id)
        if (linked) { db.exec('COMMIT'); return row.pin_id! }
        // Só estes dois campos, digitados pelo usuário, viram a ordem do problema.
        const pinId = Number(db.prepare('INSERT INTO pins (game,title,body) VALUES (?,?,?)').run(row.game, name, body).lastInsertRowid)
        db.prepare('UPDATE project_playtests SET pin_id=? WHERE game=? AND id=?').run(pinId, row.game, row.id)
        db.exec('COMMIT')
        return pinId
      } catch (e) { db.exec('ROLLBACK'); throw e }
    }
  }
}
