// Produção local: versões imutáveis e revisão humana. Nada daqui entra em prompts ou executa arquivos.
import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { asInt, asStr, inside, safeJoin } from './guard.ts'
import type { CommandRun } from './commands.ts'

export type ReviewState = 'pending' | 'approved' | 'rejected'
export type AssetVersion = { id: number; asset_id: number; hash: string; size: number; file_name: string; note: string; state: ReviewState; created_at: string; reviewed_at: string | null }
export type Asset = { id: number; game: string; title: string; path: string; kind: string; license: string; source: string; tags: string; created_at: string; versions: AssetVersion[] }
export type BuildCommand = CommandRun & { task_title: string }
export type Build = { id: number; game: string; title: string; version: string; platform: string; hash: string; size: number; file_name: string; notes: string; state: ReviewState; source_task_id: number | null; source_command_id: number | null; command: string; created_at: string; reviewed_at: string | null }
type Snapshot = { hash: string; size: number; file_name: string }
type BuildSource = BuildCommand & { task_created_at: string; task_worktree: string | null; ended_at: string | null }
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const text = (v: unknown, label: string, max: number, required = false) => {
  const result = asStr(v ?? '', label, max).trim()
  if (result.includes('\0') || (required && !result)) throw Error(`${label} inválido.`)
  return result
}
const relativeFile = (v: unknown) => {
  const rel = text(v, 'Arquivo relativo', 2000, true)
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.includes(':')) throw Error('Use um arquivo relativo à pasta indicada.')
  return path.normalize(rel)
}
const validHash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : (() => { throw Error('Hash inválido.') })()
const decision = (v: unknown) => {
  if (v !== 'approved' && v !== 'rejected') throw Error('Decisão de revisão inválida.')
  return v
}
// ponytail: um arquivo de até 512 MiB por versão/build; pacotes maiores pedem armazenamento dedicado.
const MAX_FILE = 512 * 1024 * 1024
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

export function createProductionService(db: DatabaseSync, dataDir: string) {
  const blobs = path.join(dataDir, 'blobs')
  fs.mkdirSync(blobs, { recursive: true })
  const blobPath = (hash: string) => safeJoin(blobs, validHash(hash))
  async function verifyFile(file: string, snapshot: Snapshot) {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() || stat.size !== snapshot.size || stat.size > MAX_FILE) throw Error('Snapshot ausente ou corrompido.')
    const hash = crypto.createHash('sha256'); let size = 0
    for await (const chunk of fs.createReadStream(file)) {
      size += chunk.length
      if (size > MAX_FILE) throw Error('Snapshot corrompido: excedeu 512 MiB.')
      hash.update(chunk)
    }
    if (size !== snapshot.size || hash.digest('hex') !== snapshot.hash) throw Error('Snapshot corrompido: o hash não corresponde à versão.')
  }
  async function verify(snapshot: Snapshot) {
    const file = blobPath(snapshot.hash)
    await verifyFile(file, snapshot)
    return file
  }
  async function capture(root: string, rel: string): Promise<Snapshot> {
    const file = safeJoin(root, rel), input = await fs.promises.open(file, 'r')
    const temp = safeJoin(blobs, `.capture-${crypto.randomUUID()}`)
    try {
      const before = await input.stat(), checked = await fs.promises.stat(safeJoin(root, rel))
      if (!before.isFile() || before.size > MAX_FILE) throw Error('Escolha um arquivo de até 512 MiB.')
      if (before.ino !== checked.ino || before.dev !== checked.dev) throw Error('O arquivo mudou durante a captura. Tente novamente.')
      let size = 0
      const hash = crypto.createHash('sha256')
      await pipeline(input.createReadStream({ autoClose: false }), new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > MAX_FILE) { callback(Error('Arquivo excedeu 512 MiB durante a captura.')); return }
        hash.update(chunk); callback(null, chunk)
      } }), fs.createWriteStream(temp, { flags: 'wx' }))
      const after = await input.stat(), current = await fs.promises.stat(safeJoin(root, rel))
      if (before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== current.ino || after.dev !== current.dev) throw Error('O arquivo mudou durante a captura. Tente novamente.')
      const snapshot = { hash: hash.digest('hex'), size, file_name: path.basename(file) }
      try { await fs.promises.link(temp, blobPath(snapshot.hash)) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await verify(snapshot) }
      return snapshot
    } finally { await input.close(); await fs.promises.rm(temp, { force: true }) }
  }
  function asset(game: string, id: unknown) {
    const row = db.prepare('SELECT * FROM project_assets WHERE id=? AND game=?').get(asInt(id, 'Asset'), game) as Omit<Asset, 'versions'> | undefined
    if (!row) throw Error('Asset de outro projeto ou inexistente.')
    return row
  }
  function assetVersion(game: string, id: unknown) {
    const row = db.prepare('SELECT v.* FROM asset_versions v JOIN project_assets a ON a.id=v.asset_id WHERE v.id=? AND a.game=?').get(asInt(id, 'Versão'), game) as AssetVersion | undefined
    if (!row) throw Error('Versão de outro projeto ou inexistente.')
    return row
  }
  function build(game: string, id: unknown) {
    const row = db.prepare('SELECT * FROM project_builds WHERE id=? AND game=?').get(asInt(id, 'Build'), game) as Build | undefined
    if (!row) throw Error('Build de outro projeto ou inexistente.')
    return row
  }
  function saveVersion(assetId: number, snapshot: Snapshot, note: string) {
    db.prepare('INSERT OR IGNORE INTO asset_versions(asset_id,hash,size,file_name,note) VALUES (?,?,?,?,?)').run(assetId, snapshot.hash, snapshot.size, snapshot.file_name, note)
    return (db.prepare('SELECT id FROM asset_versions WHERE asset_id=? AND hash=?').get(assetId, snapshot.hash) as { id: number }).id
  }
  function buildSource(game: string, id: unknown): BuildSource {
    const run = db.prepare("SELECT c.*,t.title task_title,t.created_at task_created_at,t.worktree task_worktree FROM command_runs c JOIN tasks t ON t.id=c.task_id WHERE c.id=? AND t.game=? AND c.status='completed' AND c.exit_code=0").get(asInt(id, 'Comando'), game) as BuildSource | undefined
    if (!run) throw Error('Selecione um comando concluído com exit 0 deste projeto.')
    const gameReal = fs.realpathSync(game), workspaceReal = fs.realpathSync(run.workspace)
    if (!same(workspaceReal, gameReal)) {
      if (!run.task_worktree || !same(run.workspace, run.task_worktree) || !inside(path.join(gameReal, '.worktrees'), workspaceReal)) throw Error('Workspace do comando não corresponde ao projeto ou à worktree atual da tarefa.')
    }
    return run
  }
  const commandSnapshot = (run: BuildSource) => JSON.stringify({ id: run.id, task_id: run.task_id, task_title: run.task_title, task_created_at: run.task_created_at, workspace: run.workspace, name: run.name, program: run.program, args: run.args, status: run.status, exit_code: run.exit_code, duration_ms: run.duration_ms, started_at: run.started_at, ended_at: run.ended_at })
  const listAssets = (game: string): Asset[] => (db.prepare('SELECT * FROM project_assets WHERE game=? ORDER BY id DESC').all(game) as Omit<Asset, 'versions'>[]).map(a => ({ ...a, versions: db.prepare('SELECT * FROM asset_versions WHERE asset_id=? ORDER BY id DESC').all(a.id) as AssetVersion[] }))
  async function captureAsset(game: string, raw: any) {
    const title = text(raw?.title, 'Título', 300, true), rel = relativeFile(raw?.path)
    const fields = ['kind', 'license', 'source', 'tags'].map(k => text(raw?.[k], k, k === 'kind' ? 50 : 1000))
    const note = text(raw?.note, 'Nota da versão', 5000), snapshot = await capture(game, rel)
    db.exec('BEGIN')
    try {
      let id = (db.prepare('SELECT id FROM project_assets WHERE game=? AND path=?').get(game, rel) as { id: number } | undefined)?.id
      if (!id) id = Number(db.prepare('INSERT INTO project_assets(game,title,path,kind,license,source,tags) VALUES (?,?,?,?,?,?,?)').run(game, title, rel, ...fields).lastInsertRowid)
      saveVersion(id, snapshot, note); db.exec('COMMIT'); return id
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  async function captureAssetVersion(game: string, id: unknown, note: unknown) {
    const a = asset(game, id), cleanNote = text(note, 'Nota da versão', 5000), snapshot = await capture(game, relativeFile(a.path))
    asset(game, a.id) // A captura é assíncrona: conferir novamente antes da gravação.
    return saveVersion(a.id, snapshot, cleanNote)
  }
  async function reviewAssetVersion(game: string, id: unknown, hash: unknown, review: unknown) {
    const v = assetVersion(game, id), expected = validHash(hash), state = decision(review)
    if (v.hash !== expected) throw Error('A versão mudou. Atualize a lista antes de revisar.')
    await verify(v)
    db.prepare('UPDATE asset_versions SET state=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND hash=?').run(state, v.id, expected)
  }
  function readAssetImage(game: string, id: unknown) {
    const v = assetVersion(game, id), mime = MIME[path.extname(v.file_name).toLowerCase()]
    if (!mime || v.size > 10 * 1024 * 1024) return null
    try {
      const file = blobPath(v.hash), stat = fs.statSync(file)
      if (!stat.isFile() || stat.size !== v.size || stat.size > 10 * 1024 * 1024) return null
      const bytes = fs.readFileSync(file)
      return crypto.createHash('sha256').update(bytes).digest('hex') === v.hash ? `data:${mime};base64,${bytes.toString('base64')}` : null
    } catch { return null }
  }
  const listBuildCommands = (game: string) => db.prepare("SELECT c.*,t.title task_title FROM command_runs c JOIN tasks t ON t.id=c.task_id WHERE t.game=? AND c.status='completed' AND c.exit_code=0 ORDER BY c.id DESC LIMIT 50").all(game) as BuildCommand[]
  const listBuilds = (game: string) => db.prepare('SELECT * FROM project_builds WHERE game=? ORDER BY id DESC').all(game) as Build[]
  async function registerBuild(game: string, raw: any) {
    const title = text(raw?.title, 'Título', 300, true), version = text(raw?.version, 'Versão', 100, true), platform = text(raw?.platform, 'Plataforma', 100, true), notes = text(raw?.notes, 'Notas', 5000), rel = relativeFile(raw?.path)
    const run = buildSource(game, raw?.commandId), command = commandSnapshot(run), snapshot = await capture(run.workspace, rel)
    if (commandSnapshot(buildSource(game, run.id)) !== command) throw Error('O comando mudou durante a captura. Atualize a lista.')
    const existing = db.prepare('SELECT id FROM project_builds WHERE game=? AND source_command_id=? AND hash=? AND title=? AND version=? AND platform=?').get(game, run.id, snapshot.hash, title, version, platform) as { id: number } | undefined
    if (existing) return existing.id
    return Number(db.prepare('INSERT INTO project_builds(game,title,version,platform,hash,size,file_name,notes,source_task_id,source_command_id,command) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(game, title, version, platform, snapshot.hash, snapshot.size, snapshot.file_name, notes, run.task_id, run.id, command).lastInsertRowid)
  }
  async function reviewBuild(game: string, id: unknown, hash: unknown, review: unknown) {
    const b = build(game, id), expected = validHash(hash), state = decision(review)
    if (b.hash !== expected) throw Error('O build mudou. Atualize a lista antes de revisar.')
    await verify(b)
    db.prepare('UPDATE project_builds SET state=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND hash=?').run(state, b.id, expected)
  }
  async function exportFile(game: string, kind: unknown, id: unknown, target: unknown) {
    if (kind !== 'asset' && kind !== 'build') throw Error('Tipo de arquivo inválido.')
    const snapshot = kind === 'asset' ? assetVersion(game, id) : build(game, id)
    if (snapshot.state !== 'approved') throw Error('Aprove esta versão antes de exportar.')
    const destination = text(target, 'Destino', 2000, true)
    if (!path.isAbsolute(destination)) throw Error('Destino absoluto obrigatório.')
    const source = await verify(snapshot)
    const temp = path.join(path.dirname(destination), `.export-${crypto.randomUUID()}`)
    try {
      await fs.promises.copyFile(source, temp, fs.constants.COPYFILE_EXCL)
      await verifyFile(temp, snapshot)
      const current = kind === 'asset' ? assetVersion(game, id) : build(game, id)
      if (current.hash !== snapshot.hash || current.state !== 'approved') throw Error('A revisão mudou durante a exportação.')
      // COPYFILE_EXCL também funciona em pendrives FAT/ExFAT; a cópia nunca sobrescreve o destino.
      await fs.promises.copyFile(temp, destination, fs.constants.COPYFILE_EXCL)
    } finally { await fs.promises.rm(temp, { force: true }) }
    return destination
  }
  return { listAssets, captureAsset, captureAssetVersion, reviewAssetVersion, readAssetImage, listBuildCommands, listBuilds, registerBuild, reviewBuild, exportFile }
}
