// Backups locais de dados do app. Nunca copiam perfis das CLIs, cookies ou o cofre.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './db.ts'
import { inside, pathKey, sameKey as same } from './guard.ts'

export type BackupSummary = { path: string; createdAt: string; files: number; bytes: number; schema: number }
type FileEntry = { path: string; size: number; hash: string }
type Manifest = { format: 1; createdAt: string; sourceDataDir: string; schema: number; directories: string[]; files: FileEntry[] }
const ROOTS = ['attachments', 'production', 'linkedin/perfil.md', 'linkedin/rascunhos', 'linkedin/videos']
const REPLACEMENTS = ['dashboard.db', ...ROOTS]
const SWAP_ENTRIES = [...REPLACEMENTS, 'dashboard.db-wal', 'dashboard.db-shm', 'dashboard.db-journal']
const PENDING = '.restore-pending', TRANSACTION = '.restore-transaction', LAST = '.restore-last.json'
function fail(s: string): never { throw Error(s) }
const within = (root: string, file: string) => same(root, file) || inside(root, file)
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`
const owned = (s: string) => s === 'dashboard.db' || ROOTS.some(r => s === r || (r !== 'linkedin/perfil.md' && s.startsWith(r + '/')))
const exists = (s: string) => { try { fs.lstatSync(s); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }

function relative(s: unknown): string {
  if (typeof s !== 'string' || !s || s.length > 4096 || s.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"\\|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('Caminho inválido no backup.')
  if (!owned(s)) fail('Conteúdo fora das pastas de dados permitidas.')
  return s
}
// lstat em todos os ancestrais também rejeita junctions; realpath apenas não basta.
// Exceção: links do sistema pertencentes ao root no macOS/Linux (/var -> /private/var, /tmp): o usuário não os cria nem altera.
// No Windows uid é sempre 0, por isso a exceção não vale lá.
const systemLink = (st: fs.Stats) => process.platform !== 'win32' && st.uid === 0
function noLinks(file: string, allowMissing = false) {
  let p = path.resolve(file)
  while (true) {
    if (exists(p)) { const st = fs.lstatSync(p); if (st.isSymbolicLink() && !systemLink(st)) fail('Links e junctions não são permitidos no backup.') }
    else if (!allowMissing) fail('Arquivo do backup ausente.')
    const up = path.dirname(p); if (up === p) break; p = up
  }
}
function unrelated(a: string, b: string) {
  if (within(a, b) || within(b, a)) fail('O backup deve ficar fora da pasta de dados e não pode contê-la.')
}
function removeOwned(root: string, file: string) {
  if (!within(root, file) || same(root, file)) fail('Remoção fora da área de restauração.')
  noLinks(root); noLinks(file, true)
  fs.rmSync(file, { recursive: true, force: true })
}
function fileHash(file: string, copy?: string): { size: number; hash: string } {
  noLinks(file)
  const before = fs.lstatSync(file)
  if (!before.isFile()) fail('O backup contém um arquivo especial.')
  const input = fs.openSync(file, 'r'); let output: number | undefined
  const hash = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024)
  let size = 0
  try {
    if (copy) output = fs.openSync(copy, 'wx')
    const opened = fs.fstatSync(input)
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) fail('Arquivo alterado durante o backup.')
    for (let n; (n = fs.readSync(input, chunk, 0, chunk.length, null)) > 0;) {
      size += n; hash.update(chunk.subarray(0, n))
      if (output !== undefined) for (let written = 0; written < n;) written += fs.writeSync(output, chunk, written, n - written)
    }
    noLinks(file)
    const after = fs.lstatSync(file)
    if (size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('Arquivo alterado durante o backup.')
    if (output !== undefined) fs.fsyncSync(output)
    return { size, hash: hash.digest('hex') }
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output) }
}
function inventory(root: string, includeDb = true): { files: FileEntry[]; directories: string[] } {
  const files: FileEntry[] = [], directories: string[] = []
  function walk(rel: string) {
    relative(rel)
    const file = path.join(root, rel); noLinks(file)
    const st = fs.lstatSync(file)
    if (st.isDirectory()) { directories.push(rel); for (const name of fs.readdirSync(file).sort()) walk(`${rel}/${name}`) }
    else files.push({ path: rel, ...fileHash(file) })
  }
  for (const r of includeDb ? REPLACEMENTS : ROOTS) if (exists(path.join(root, r))) walk(r)
  return { files, directories }
}
const schemaObjects = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()
const expectedSchemas = new Map<number, string>()
function checkDb(db: DatabaseSync, version: number) {
  if (!Number.isInteger(version) || version < 19 || version > MIGRATIONS.length || (db.prepare('PRAGMA user_version').get() as any).user_version !== version) fail('Versão do banco incompatível com este aplicativo.')
  if (!expectedSchemas.has(version)) {
    const ref = new DatabaseSync(':memory:')
    try { for (const m of MIGRATIONS.slice(0, version)) m(ref); expectedSchemas.set(version, JSON.stringify(schemaObjects(ref))) }
    finally { ref.close() }
  }
  if (JSON.stringify(schemaObjects(db)) !== expectedSchemas.get(version)) fail('Estrutura do banco de backup inválida ou desconhecida.')
  const check = db.prepare('PRAGMA integrity_check').all() as any[]
  if (check.length !== 1 || check[0].integrity_check !== 'ok') fail('Banco de backup corrompido.')
}
function sanitizedDb(source: DatabaseSync, file: string, version: number) {
  checkDb(source, version)
  const dest = new DatabaseSync(file)
  try {
    for (const m of MIGRATIONS.slice(0, version)) m(dest)
    dest.exec(`PRAGMA user_version=${version}; BEGIN`)
    for (const { name } of source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
      const cols = (source.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(c => c.name)
      const select = source.prepare(`SELECT ${cols.map(quote).join(',')} FROM ${quote(name)}${name === 'settings' ? " WHERE key != 'linkedinAuth'" : ''}`)
      const insert = dest.prepare(`INSERT INTO ${quote(name)} (${cols.map(quote).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      for (const row of select.iterate() as Iterable<Record<string, any>>) insert.run(...cols.map(c => row[c]))
    }
    dest.exec('COMMIT')
  } finally { dest.close() }
}
function references(db: DatabaseSync, source: string, entries: FileEntry[]) {
  const files = new Map(entries.map(e => [e.path.toLowerCase(), e]))
  const requireFile = (p: string, root: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !within(path.join(source, root), p)) fail('Referência de anexo inválida no banco.')
    const rel = relative(path.relative(source, p).split(path.sep).join('/'))
    if (!files.has(rel.toLowerCase())) fail('O backup está incompleto: anexo referenciado ausente.')
  }
  for (const table of ['messages', 'pending_sends']) for (const { text } of db.prepare(`SELECT text FROM ${table}`).iterate() as Iterable<{ text: string }>) {
    for (const m of text.matchAll(/\[imagem anexada: ([^\]\r\n]+)\]/g)) if (within(path.join(source, 'attachments'), m[1].trim())) requireFile(m[1].trim(), 'attachments')
  }
  for (const { images } of db.prepare('SELECT images FROM project_playtests').iterate() as Iterable<{ images: string }>) {
    let imageFiles: unknown; try { imageFiles = JSON.parse(images) } catch { fail('Referência de screenshot inválida.') }
    if (!Array.isArray(imageFiles)) fail('Referência de screenshot inválida.')
    for (const p of imageFiles) requireFile(p, 'production/playtests')
  }
  const version = (db.prepare('PRAGMA user_version').get() as any).user_version
  for (const table of ['asset_versions', 'project_builds']) for (const r of db.prepare(`SELECT hash,size FROM ${table}${table === 'asset_versions' && version >= 20 ? ' WHERE pruned_at IS NULL' : ''}`).iterate() as Iterable<{ hash: string; size: number }>) {
    const e = files.get(`production/blobs/${r.hash}`)
    if (!/^[a-f0-9]{64}$/.test(r.hash) || !e || e.hash !== r.hash || e.size !== r.size) fail('O backup está incompleto: snapshot ausente ou corrompido.')
  }
}
function writeJson(file: string, data: unknown) {
  noLinks(file, true)
  const temp = `${file}-${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx' })
  const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
}
function manifestAt(folder: string): Manifest {
  noLinks(folder); if (!fs.statSync(folder).isDirectory()) fail('Selecione a pasta do backup.')
  const p = path.join(folder, 'manifest.json'); noLinks(p)
  if (!fs.statSync(p).isFile() || fs.statSync(p).size > 32 * 1024 * 1024) fail('Manifesto de backup inválido.')
  let m: any; try { m = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { fail('Manifesto de backup inválido.') }
  if (m?.format !== 1 || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt)) || typeof m.sourceDataDir !== 'string' || !path.isAbsolute(m.sourceDataDir) || !Number.isInteger(m.schema) || m.schema < 19 || m.schema > MIGRATIONS.length || !Array.isArray(m.files) || !Array.isArray(m.directories) || m.files.length + m.directories.length > 200_000) fail('Manifesto de backup incompatível ou inválido.')
  const seen = new Set<string>()
  for (const r of [...m.directories, ...m.files.map((e: any) => e?.path)]) { relative(r); const key = r.toLowerCase(); if (seen.has(key)) fail('Caminho duplicado no backup.'); seen.add(key) }
  if (m.directories.some((d: string) => d === 'dashboard.db' || d === 'linkedin/perfil.md') || m.files.some((e: any) => ROOTS.filter(r => r !== 'linkedin/perfil.md').includes(e.path))) fail('Tipo de entrada inválido no backup.')
  if (!m.files.some((e: any) => e.path === 'dashboard.db')) fail('Banco de backup ausente.')
  for (const e of m.files) if (!Number.isSafeInteger(e.size) || e.size < 0 || typeof e.hash !== 'string' || !/^[a-f0-9]{64}$/.test(e.hash)) fail('Arquivo inválido no manifesto.')
  if (!Number.isSafeInteger(m.files.reduce((n: number, e: FileEntry) => n + e.size, 0))) fail('Tamanho do backup inválido.')
  return m
}
function validate(folder: string): Manifest {
  const m = manifestAt(folder)
  function checkTree(dir: string, rel = '') {
    for (const name of fs.readdirSync(dir)) {
      const entry = rel ? `${rel}/${name}` : name
      if (entry === 'manifest.json') continue
      const file = path.join(dir, name); noLinks(file)
      if (entry === 'linkedin') { if (!fs.statSync(file).isDirectory()) fail('Pasta LinkedIn inválida.'); checkTree(file, entry); continue }
      relative(entry)
      if (fs.statSync(file).isDirectory()) { if (!m.directories.includes(entry)) fail('Pasta não declarada no backup.'); checkTree(file, entry) }
      else if (!m.files.some(e => e.path === entry)) fail('Arquivo não declarado no backup.')
    }
  }
  checkTree(folder)
  for (const d of m.directories) { const p = path.join(folder, d); noLinks(p); if (!fs.statSync(p).isDirectory()) fail('Pasta de backup ausente.') }
  for (const e of m.files) { const got = fileHash(path.join(folder, e.path)); if (got.size !== e.size || got.hash !== e.hash) fail('Backup corrompido: tamanho ou hash não corresponde.') }
  const db = new DatabaseSync(path.join(folder, 'dashboard.db'), { readOnly: true })
  try {
    db.exec('PRAGMA trusted_schema=OFF')
    checkDb(db, m.schema)
    if (db.prepare("SELECT 1 FROM settings WHERE key='linkedinAuth'").get()) fail('Backup contém um cofre que não pode ser importado.')
    references(db, m.sourceDataDir, m.files)
  } finally { db.close() }
  return m
}
const summary = (folder: string, m: Manifest): BackupSummary => ({ path: path.resolve(folder), createdAt: m.createdAt, files: m.files.length, bytes: m.files.reduce((n, f) => n + f.size, 0), schema: m.schema })
export function inspectBackup(folder: string): BackupSummary & { sourceDataDir: string } {
  const m = validate(path.resolve(folder)); return { ...summary(folder, m), sourceDataDir: m.sourceDataDir }
}
function copyManifest(source: string, dest: string, m: Manifest) {
  fs.mkdirSync(dest)
  for (const d of [...m.directories].sort((a, b) => a.length - b.length)) fs.mkdirSync(path.join(dest, d), { recursive: true })
  for (const e of m.files) {
    const file = path.join(dest, e.path); fs.mkdirSync(path.dirname(file), { recursive: true })
    const got = fileHash(path.join(source, e.path), file)
    if (got.size !== e.size || got.hash !== e.hash) fail('O backup mudou durante a preparação.')
  }
  writeJson(path.join(dest, 'manifest.json'), m)
}
function create(db: DatabaseSync, dataDir: string, parent: string, internal = false): BackupSummary {
  dataDir = path.resolve(dataDir); parent = path.resolve(parent)
  noLinks(dataDir); noLinks(parent); if (!fs.statSync(parent).isDirectory()) fail('Destino do backup inválido.')
  const name = `orbita-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
  const dest = path.join(parent, name), temp = path.join(parent, `.${name}.tmp`)
  if (!internal) unrelated(dataDir, dest)
  fs.mkdirSync(temp)
  let reading = false
  try {
    db.exec('BEGIN'); reading = true
    const schema = (db.prepare('PRAGMA user_version').get() as any).user_version
    sanitizedDb(db, path.join(temp, 'dashboard.db'), schema)
    const content = inventory(dataDir, false)
    for (const d of content.directories.sort((a, b) => a.length - b.length)) fs.mkdirSync(path.join(temp, d), { recursive: true })
    for (const e of content.files) {
      const file = path.join(temp, e.path); fs.mkdirSync(path.dirname(file), { recursive: true })
      const copied = fileHash(path.join(dataDir, e.path), file)
      if (copied.size !== e.size || copied.hash !== e.hash) fail('Dados alterados durante o backup.')
    }
    db.exec('COMMIT'); reading = false
    const m: Manifest = { format: 1, createdAt: new Date().toISOString(), sourceDataDir: dataDir, schema, ...inventory(temp) }
    writeJson(path.join(temp, 'manifest.json'), m); validate(temp)
    fs.renameSync(temp, dest)
    return summary(dest, m)
  } catch (e) { if (reading) db.exec('ROLLBACK'); removeOwned(parent, temp); throw e }
}
export function createBackup(db: DatabaseSync, dataDir: string, parent: string): BackupSummary { return create(db, dataDir, parent) }

function rebase(db: DatabaseSync, oldDir: string, newDir: string) {
  // `within` compara sem caixa e v pode vir em minusculas (chave commands:): corta pelo tamanho, pois path.relative diferencia caixa no Linux.
  const move = (v: string, root: string) => typeof v === 'string' && within(path.join(oldDir, root), v) ? path.join(newDir, root, path.resolve(v).slice(path.resolve(oldDir, root).length)) : v
  db.exec('BEGIN')
  try {
    for (const table of ['messages', 'pending_sends']) for (const r of db.prepare(`SELECT id,text FROM ${table}`).iterate() as Iterable<{ id: number; text: string }>) {
      const text = r.text.replace(/\[imagem anexada: ([^\]\r\n]+)\]/g, (all, p) => { const moved = move(p.trim(), 'attachments'); return moved === p.trim() ? all : `[imagem anexada: ${moved}]` })
      if (text !== r.text) db.prepare(`UPDATE ${table} SET text=? WHERE id=?`).run(text, r.id)
    }
    for (const r of db.prepare('SELECT id,images FROM project_playtests').iterate() as Iterable<{ id: number; images: string }>) db.prepare('UPDATE project_playtests SET images=? WHERE id=?').run(JSON.stringify((JSON.parse(r.images) as string[]).map(p => move(p, 'production/playtests'))), r.id)
    for (const [table, cols] of [['tasks', ['game', 'worktree']], ['pins', ['game', 'worktree']], ['project_assets', ['game']], ['project_playtests', ['game']], ['project_builds', ['game']], ['permission_rules', ['project']]] as [string, string[]][]) {
      for (const col of cols) for (const r of db.prepare(`SELECT id,${col} value FROM ${table} WHERE ${col} IS NOT NULL`).iterate() as Iterable<{ id: number; value: string }>) {
        const v = move(r.value, 'linkedin'); if (v !== r.value) db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=?`).run(v, r.id)
      }
    }
    for (const r of db.prepare("SELECT key,value FROM settings WHERE key IN ('extraGames','hiddenGames','projectNames','projectGroups','todoBoard') OR key LIKE 'commands:%'").all() as { key: string; value: string }[]) {
      let value = JSON.parse(r.value), key = r.key
      if (key === 'extraGames' || key === 'hiddenGames') value = value.map((p: string) => move(p, 'linkedin'))
      if (key === 'projectNames') value = Object.fromEntries(Object.entries(value).map(([p, n]) => [move(p, 'linkedin'), n]))
      if (key === 'projectGroups') for (const g of value) g.games = g.games.map((p: string) => move(p, 'linkedin'))
      if (key === 'todoBoard') for (const t of value.topics) for (const i of t.items) if (i.project) i.project = move(i.project, 'linkedin')
      if (key.startsWith('commands:')) key = 'commands:' + pathKey(move(key.slice(9), 'linkedin'))
      db.prepare('DELETE FROM settings WHERE key=?').run(r.key)
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
    }
    // Sessões externas não fazem parte do backup e podem ter avançado desde a cópia.
    db.exec('DELETE FROM task_sessions; DELETE FROM metrics; UPDATE chats SET session_id=NULL; UPDATE delegations SET session_id=NULL; COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
export function stageRestore(dataDir: string, folder: string): void {
  dataDir = path.resolve(dataDir); folder = path.resolve(folder); noLinks(dataDir)
  if (!within(path.join(dataDir, 'backups'), folder) || same(path.join(dataDir, 'backups'), folder)) unrelated(dataDir, folder)
  const pending = path.join(dataDir, PENDING), temp = path.join(dataDir, `${PENDING}-${crypto.randomUUID()}.tmp`)
  if (exists(pending) || exists(path.join(dataDir, TRANSACTION))) fail('Já existe uma restauração pendente.')
  const m = validate(folder)
  // Rejeita antes de reiniciar: a cópia de segurança precisa dos dados atuais íntegros.
  const liveFile = path.join(dataDir, 'dashboard.db')
  if (exists(liveFile)) {
    noLinks(liveFile)
    const live = new DatabaseSync(liveFile, { readOnly: true })
    try {
      live.exec('PRAGMA trusted_schema=OFF; BEGIN')
      checkDb(live, (live.prepare('PRAGMA user_version').get() as any).user_version)
      references(live, dataDir, inventory(dataDir, false).files)
      live.exec('COMMIT')
    } finally { live.close() }
  }
  try {
    copyManifest(folder, temp, m)
    const db = new DatabaseSync(path.join(temp, 'dashboard.db'))
    try { checkDb(db, m.schema); rebase(db, m.sourceDataDir, dataDir) } finally { db.close() }
    const rebased: Manifest = { ...m, sourceDataDir: dataDir, ...inventory(temp) }
    writeJson(path.join(temp, 'manifest.json'), rebased); validate(temp)
    fs.renameSync(temp, pending)
  } catch (e) { removeOwned(dataDir, temp); throw e }
}

type Journal = { format: 1; state: 'applying' | 'committed'; had: string[]; restoredAt: string; safetyPath: string }
function recover(dataDir: string) {
  const tx = path.join(dataDir, TRANSACTION)
  if (!exists(tx)) return
  noLinks(tx)
  const file = path.join(tx, 'journal.json')
  // Antes do diário nenhum dado vivo foi movido.
  if (!exists(file)) { removeOwned(dataDir, tx); return }
  noLinks(file)
  const j: Journal = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (j.format !== 1 || !['applying', 'committed'].includes(j.state) || !Array.isArray(j.had) || j.had.some(p => !SWAP_ENTRIES.includes(p)) || new Set(j.had).size !== j.had.length || typeof j.restoredAt !== 'string' || !Number.isFinite(Date.parse(j.restoredAt)) || typeof j.safetyPath !== 'string' || (j.safetyPath && !within(path.join(dataDir, 'backups'), j.safetyPath))) fail('Diário de restauração inválido; dados originais preservados.')
  if (j.state === 'applying') for (const p of [...SWAP_ENTRIES].reverse()) {
    const target = path.join(dataDir, p), old = path.join(tx, 'old', p)
    noLinks(target, true); noLinks(old, true)
    if (exists(old)) { removeOwned(dataDir, target); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(old, target) }
    else if (!j.had.includes(p)) removeOwned(dataDir, target)
  }
  if (j.state === 'committed') { writeJson(path.join(dataDir, LAST), { restoredAt: j.restoredAt, safetyPath: j.safetyPath }); removeOwned(dataDir, path.join(dataDir, PENDING)) }
  removeOwned(dataDir, tx)
}
export function backupInfo(dataDir: string): { restoredAt: string; safetyPath: string } | null {
  const file = path.join(dataDir, LAST)
  try {
    if (!exists(file)) return null
    noLinks(file)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 8192) return null
    const info = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof info?.restoredAt !== 'string' || !Number.isFinite(Date.parse(info.restoredAt)) || typeof info.safetyPath !== 'string' || (info.safetyPath && (!path.isAbsolute(info.safetyPath) || !within(path.join(dataDir, 'backups'), info.safetyPath) || same(path.join(dataDir, 'backups'), info.safetyPath)))) return null
    return { restoredAt: info.restoredAt, safetyPath: info.safetyPath }
  } catch { return null } // Recibo de exibição não pode bloquear a abertura dos dados.
}
export function applyPendingRestore(dataDir: string): { restoredAt: string; safetyPath: string } | null {
  dataDir = path.resolve(dataDir); noLinks(dataDir, true); fs.mkdirSync(dataDir, { recursive: true }); recover(dataDir)
  const pending = path.join(dataDir, PENDING)
  if (!exists(pending)) return backupInfo(dataDir)
  const m = validate(pending), tx = path.join(dataDir, TRANSACTION), safetyParent = path.join(dataDir, 'backups')
  noLinks(safetyParent, true); fs.mkdirSync(safetyParent, { recursive: true })
  let safetyPath = ''
  if (exists(path.join(dataDir, 'dashboard.db'))) {
    noLinks(path.join(dataDir, 'dashboard.db'))
    const db = new DatabaseSync(path.join(dataDir, 'dashboard.db'), { readOnly: true })
    try { safetyPath = create(db, dataDir, safetyParent, true).path } finally { db.close() }
  }
  const j: Journal = { format: 1, state: 'applying', had: SWAP_ENTRIES.filter(p => exists(path.join(dataDir, p))), restoredAt: new Date().toISOString(), safetyPath }
  fs.mkdirSync(tx); fs.mkdirSync(path.join(tx, 'old'))
  // ponytail: um diário e renames locais; um único processo aplica antes de abrir o SQLite.
  try {
    copyManifest(pending, path.join(tx, 'new'), m)
    writeJson(path.join(tx, 'journal.json'), j)
    for (const p of SWAP_ENTRIES) {
      const target = path.join(dataDir, p), old = path.join(tx, 'old', p), next = path.join(tx, 'new', p)
      noLinks(target, true); noLinks(next, true)
      if (exists(target)) { fs.mkdirSync(path.dirname(old), { recursive: true }); fs.renameSync(target, old) }
      if (exists(next)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(next, target) }
    }
    j.state = 'committed'; writeJson(path.join(tx, 'journal.json'), j)
    recover(dataDir)
    return { restoredAt: j.restoredAt, safetyPath }
  } catch (e) {
    if (exists(path.join(tx, 'journal.json'))) recover(dataDir)
    else removeOwned(dataDir, tx)
    throw e
  }
}
