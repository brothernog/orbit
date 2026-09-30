import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDb, MIGRATIONS } from './db.ts'
import { attachImages } from './attachments.ts'
import { createTask } from './tasks.ts'
import { createProductionService } from './production.ts'
import { createPlaytestService } from './playtests.ts'
import { createBackup, inspectBackup, stageRestore, applyPendingRestore, backupInfo } from './backups.ts'
import { pathKey } from './guard.ts'

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/UAAAAAASUVORK5CYII='
const secret = 'DO-NOT-COPY-LINKEDIN-SECRET-' + 'x'.repeat(200)
function fixture(version = MIGRATIONS.length) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-backups-')), data = path.join(root, 'data'), backups = path.join(root, 'backups'), game = path.join(root, 'game')
  fs.mkdirSync(backups); fs.mkdirSync(game)
  fs.mkdirSync(data)
  const db = new DatabaseSync(path.join(data, 'dashboard.db'))
  for (const migration of MIGRATIONS.slice(0, version)) migration(db)
  db.exec(`PRAGMA user_version=${version}`)
  return { root, data, backups, game, db, cleanup() { try { db.close() } catch {} fs.rmSync(root, { recursive: true, force: true }) } }
}
const row = (db: DatabaseSync, q: string) => db.prepare(q).get() as any
const set = (db: DatabaseSync, k: string, v: any) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(k, JSON.stringify(v))
const manifest = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
function updateManifest(folder: string, edit: (m: any) => void) { const m = manifest(folder); edit(m); fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(m)) }
function rehashDb(folder: string) {
  updateManifest(folder, m => { const b = fs.readFileSync(path.join(folder, 'dashboard.db')), e = m.files.find((e: any) => e.path === 'dashboard.db'); e.size = b.length; e.hash = crypto.createHash('sha256').update(b).digest('hex') })
}
async function populated(f: ReturnType<typeof fixture>) {
  const { db, data, game } = f, linkedin = path.join(data, 'linkedin')
  const task = createTask(db, game, 'Jogo'), liTask = createTask(db, linkedin, 'LinkedIn')
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('linkedinAuth', secret)
  const imageText = attachImages(path.join(data, 'attachments', String(task)), 'Imagem', [pixel])
  db.prepare('INSERT INTO messages(chat_key,task_id,role,text) VALUES (?,?,?,?)').run('', task, 'user', imageText)
  db.prepare('INSERT INTO pending_sends(task_id,text,sel,state) VALUES (?,?,?,?)').run(task, imageText, '{}', 'expired')
  db.prepare('INSERT INTO task_sessions(task_id,provider,profile,session_id) VALUES (?,?,?,?)').run(task, 'codex', '', 'native-id')
  db.prepare('INSERT INTO metrics(task_id,provider,profile,at,occupied) VALUES (?,?,?,?,?)').run(task, 'codex', '', 'now', 100)
  db.prepare('INSERT INTO usage_records(task_id,provider,input,output) VALUES (?,?,?,?)').run(task, 'codex', null, 25)
  db.prepare('INSERT INTO delegations(task_id,provider,mode,objective,status,session_id,workspace) VALUES (?,?,?,?,?,?,?)').run(task, 'codex', 'execute', 'Histórico', 'completed', 'delegated-id', linkedin)
  fs.mkdirSync(path.join(linkedin, 'rascunhos', 'publicados'), { recursive: true }); fs.mkdirSync(path.join(linkedin, 'videos'))
  fs.writeFileSync(path.join(linkedin, 'perfil.md'), 'Perfil humano'); fs.writeFileSync(path.join(linkedin, 'rascunhos', 'publicados', 'post.md'), 'Publicado'); fs.writeFileSync(path.join(linkedin, 'videos', 'video.mp4'), 'video')
  fs.mkdirSync(path.join(linkedin, '.claude')); fs.writeFileSync(path.join(linkedin, '.claude', 'credentials.json'), secret)
  fs.writeFileSync(path.join(data, 'Cookies'), secret)
  set(db, 'extraGames', [game, linkedin]); set(db, 'hiddenGames', [linkedin]); set(db, 'projectNames', { [linkedin]: 'Minha mesa' }); set(db, 'projectGroups', [{ games: [linkedin] }]); set(db, 'todoBoard', { revision: 1, topics: [{ items: [{ project: linkedin }] }] }); set(db, 'commands:' + pathKey(linkedin), [])
  db.prepare('UPDATE tasks SET worktree=? WHERE id=?').run(linkedin, liTask)
  const production = createProductionService(db, path.join(data, 'production'))
  fs.writeFileSync(path.join(game, 'sprite.png'), Buffer.from(pixel.split(',')[1], 'base64'))
  await production.captureAsset(game, { title: 'Sprite', path: 'sprite.png', kind: 'sprite', license: 'Própria', source: 'Autoral', tags: '', note: '' })
  const asset = production.listAssets(game)[0].versions[0]; await production.reviewAssetVersion(game, asset.id, asset.hash, 'approved')
  const command = Number(db.prepare('INSERT INTO command_runs(task_id,workspace,name,program,args,status,exit_code) VALUES (?,?,?,?,?,?,?)').run(task, game, 'Build', process.execPath, '[]', 'completed', 0).lastInsertRowid)
  fs.writeFileSync(path.join(game, 'build.zip'), 'build immutable')
  await production.registerBuild(game, { title: 'Demo', path: 'build.zip', commandId: command, version: '0.1', platform: 'Windows', notes: '' })
  const build = production.listBuilds(game)[0]; await production.reviewBuild(game, build.id, build.hash, 'approved')
  const playtests = createPlaytestService(db, path.join(data, 'production'))
  playtests.add(game, { title: 'Movimento', scenario: 'Mover', expected: 'Mover', observed: 'Move', outcome: 'pass', notes: '', severity: 'low', images: [pixel], buildId: build.id })
  return { task, imageText, asset, build }
}

test('backup completo: restaura em outro diretório, preserva evidência/NULL e não copia credenciais ou sessões externas', async () => {
  const f = fixture()
  try {
    const records = await populated(f), backup = createBackup(f.db, f.data, f.backups)
    assert.equal(backup.schema, MIGRATIONS.length); assert.ok(backup.files >= 7); assert.ok(backup.bytes > 0)
    assert.equal(inspectBackup(backup.path).sourceDataDir, f.data)
    const bytes = fs.readFileSync(path.join(backup.path, 'dashboard.db'))
    assert.equal(bytes.includes(Buffer.from(secret)), false)
    assert.equal(fs.existsSync(path.join(backup.path, 'Cookies')), false); assert.equal(fs.existsSync(path.join(backup.path, 'linkedin', '.claude')), false)
    const other = path.join(f.root, 'relocated'), previous = openDb(path.join(other, 'dashboard.db'))
    previous.prepare("INSERT INTO settings(key,value) VALUES ('before','original')").run(); previous.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('linkedinAuth', secret)
    previous.close(); fs.mkdirSync(path.join(other, 'attachments')); fs.writeFileSync(path.join(other, 'attachments', 'old.txt'), 'original')
    stageRestore(other, backup.path)
    // A preparação é independente do original, que pode ser removido/adulterado.
    fs.writeFileSync(path.join(backup.path, 'dashboard.db'), 'adulterado')
    const applied = applyPendingRestore(other)!; assert.ok(applied.safetyPath)
    assert.deepEqual(backupInfo(other), applied); assert.deepEqual(applyPendingRestore(other), applied)
    assert.equal(inspectBackup(applied.safetyPath).sourceDataDir, other)
    assert.equal(fs.existsSync(path.join(other, 'attachments', 'old.txt')), false)
    const restored = openDb(path.join(other, 'dashboard.db'))
    try {
      assert.equal(row(restored, "SELECT value FROM settings WHERE key='linkedinAuth'"), undefined)
      assert.equal(row(restored, 'SELECT input,output FROM usage_records').input, null); assert.equal(row(restored, 'SELECT input,output FROM usage_records').output, 25)
      assert.equal(row(restored, 'SELECT COUNT(*) n FROM task_sessions').n, 0); assert.equal(row(restored, 'SELECT COUNT(*) n FROM metrics').n, 0)
      assert.equal(row(restored, 'SELECT session_id FROM delegations').session_id, null)
      assert.equal(row(restored, 'SELECT workspace FROM delegations').workspace, path.join(f.data, 'linkedin'))
      const text = row(restored, 'SELECT text FROM messages').text
      assert.ok(text.includes(path.join(other, 'attachments'))); assert.ok(!text.includes(f.data)); assert.equal(row(restored, 'SELECT text FROM pending_sends').text, text)
      const img = JSON.parse(row(restored, 'SELECT images FROM project_playtests').images)[0]
      assert.ok(img.startsWith(path.join(other, 'production', 'playtests'))); assert.ok(fs.existsSync(img))
      const s = createProductionService(restored, path.join(other, 'production'))
      assert.equal(s.listAssets(f.game)[0].versions[0].state, 'approved'); assert.equal(s.listBuilds(f.game)[0].hash, records.build.hash)
      assert.equal(row(restored, "SELECT game FROM tasks WHERE title='LinkedIn'").game, path.join(other, 'linkedin'))
      assert.deepEqual(JSON.parse(row(restored, "SELECT value FROM settings WHERE key='extraGames'").value), [f.game, path.join(other, 'linkedin')])
      assert.equal(JSON.parse(row(restored, "SELECT value FROM settings WHERE key='todoBoard'").value).topics[0].items[0].project, path.join(other, 'linkedin'))
      assert.ok(restored.prepare('SELECT value FROM settings WHERE key=?').get('commands:' + pathKey(path.join(other, 'linkedin'))))
      assert.equal(fs.readFileSync(path.join(other, 'linkedin', 'rascunhos', 'publicados', 'post.md'), 'utf8'), 'Publicado')
      assert.equal(fs.existsSync(path.join(other, '.restore-transaction')), false)
    } finally { restored.close() }
    const safetyDb = new DatabaseSync(path.join(applied.safetyPath, 'dashboard.db'), { readOnly: true })
    try { assert.equal(row(safetyDb, "SELECT value FROM settings WHERE key='before'").value, 'original'); assert.equal(row(safetyDb, "SELECT value FROM settings WHERE key='linkedinAuth'"), undefined) } finally { safetyDb.close() }
    // A própria cópia de segurança automática pode ser escolhida para desfazer.
    stageRestore(other, applied.safetyPath); assert.ok(applyPendingRestore(other))
    const undone = new DatabaseSync(path.join(other, 'dashboard.db'), { readOnly: true })
    try { assert.equal(row(undone, "SELECT value FROM settings WHERE key='before'").value, 'original'); assert.equal(row(undone, 'SELECT COUNT(*) n FROM messages').n, 0) } finally { undone.close() }
    assert.equal(fs.readFileSync(path.join(other, 'attachments', 'old.txt'), 'utf8'), 'original')
  } finally { f.cleanup() }
})

test('backup v20: retenção lógica não exige bytes removidos e preserva tombstones na restauração', async () => {
  const f = fixture(), s = createProductionService(f.db, path.join(f.data, 'production'))
  try {
    fs.writeFileSync(path.join(f.game, 'sprite.png'), 'antiga')
    const id = await s.captureAsset(f.game, { title: 'Asset', path: 'sprite.png', note: 'Original' }), old = s.listAssets(f.game)[0].versions[0]
    await s.reviewAssetVersion(f.game, old.id, old.hash, 'rejected')
    fs.writeFileSync(path.join(f.game, 'sprite.png'), 'nova'); await s.captureAssetVersion(f.game, id, '')
    s.setAssetArchived(f.game, id, 1, true)
    const plan = s.previewRetention(f.game, 1); assert.equal(s.pruneRetention(f.game, 1, plan.token).files, 1)
    const backup = createBackup(f.db, f.data, f.backups)
    assert.equal(inspectBackup(backup.path).schema, MIGRATIONS.length)
    const target = path.join(f.root, 'restored'); fs.mkdirSync(target)
    stageRestore(target, backup.path); applyPendingRestore(target)
    const db = openDb(path.join(target, 'dashboard.db'))
    try {
      assert.ok((db.prepare('SELECT pruned_at FROM asset_versions WHERE id=?').get(old.id) as any).pruned_at)
      const restored = createProductionService(db, path.join(target, 'production'))
      assert.ok(restored.listAssets(f.game)[0].archived_at); assert.equal(restored.listAssets(f.game)[0].versions.length, 1)
      assert.equal(fs.existsSync(path.join(target, 'production', 'blobs', old.hash)), false)
      fs.writeFileSync(path.join(f.game, 'sprite.png'), 'antiga')
      assert.equal(await restored.captureAssetVersion(f.game, id, 'Novo texto'), old.id)
      const version = restored.listAssets(f.game)[0].versions.find(v => v.id === old.id)!
      assert.equal(version.note, 'Original'); assert.equal(version.state, 'rejected')
    } finally { db.close() }
  } finally { f.cleanup() }
})

test('backup v19 continua exigindo todos os snapshots e migra para v20 depois da restauração', () => {
  const f = fixture(19)
  try {
    const bytes = Buffer.from('versão legada'), hash = crypto.createHash('sha256').update(bytes).digest('hex'), blobs = path.join(f.data, 'production', 'blobs')
    fs.mkdirSync(blobs, { recursive: true }); fs.writeFileSync(path.join(blobs, hash), bytes)
    f.db.prepare('INSERT INTO project_assets(game,title,path,kind,license,source,tags) VALUES (?,?,?,?,?,?,?)').run(f.game, 'Legado', 'asset.txt', '', '', '', '')
    f.db.prepare('INSERT INTO asset_versions(asset_id,hash,size,file_name,note,state) VALUES (?,?,?,?,?,?)').run(1, hash, bytes.length, 'asset.txt', 'Nota legada', 'approved')
    const backup = createBackup(f.db, f.data, f.backups)
    assert.equal(backup.schema, 19); assert.equal(inspectBackup(backup.path).schema, 19)
    fs.unlinkSync(path.join(blobs, hash))
    assert.throws(() => createBackup(f.db, f.data, f.backups), /snapshot ausente/)
    const target = path.join(f.root, 'legacy-restored'); fs.mkdirSync(target)
    stageRestore(target, backup.path); applyPendingRestore(target)
    const db = openDb(path.join(target, 'dashboard.db'))
    try {
      assert.equal(row(db, 'PRAGMA user_version').user_version, MIGRATIONS.length)
      const restored = createProductionService(db, path.join(target, 'production')), a = restored.listAssets(f.game)[0]
      assert.deepEqual([a.title, a.revision, a.archived_at, a.versions[0].state, a.versions[0].pinned, a.versions[0].pruned_at], ['Legado', 1, null, 'approved', 0, null])
    } finally { db.close() }
  } finally { f.cleanup() }
})

test('backup: rejeita estrutura desconhecida, referência ausente, sobreposição e junctions sem publicar cópia parcial', async () => {
  const f = fixture()
  try {
    await populated(f)
    assert.throws(() => createBackup(f.db, f.data, f.data), /fora da pasta/)
    const images = JSON.parse(row(f.db, 'SELECT images FROM project_playtests').images); fs.unlinkSync(images[0])
    assert.throws(() => createBackup(f.db, f.data, f.backups), /anexo referenciado ausente/); assert.deepEqual(fs.readdirSync(f.backups), [])
    fs.writeFileSync(images[0], Buffer.from(pixel.split(',')[1], 'base64'))
    const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.symlinkSync(external, path.join(f.data, 'production', 'junction'), 'junction')
    assert.throws(() => createBackup(f.db, f.data, f.backups), /Links e junctions/); fs.unlinkSync(path.join(f.data, 'production', 'junction'))
    f.db.exec('CREATE TRIGGER unexpected AFTER INSERT ON settings BEGIN SELECT 1; END')
    assert.throws(() => createBackup(f.db, f.data, f.backups), /Estrutura/); assert.deepEqual(fs.readdirSync(f.backups), [])
  } finally { f.cleanup() }
})

test('importação: rejeita corrupção, traversal, ADS, duplicatas, arquivos desconhecidos e banco futuro/adulterado', () => {
  const f = fixture()
  try {
    const backup = createBackup(f.db, f.data, f.backups), original = fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8')
    for (const p of ['../escape', 'attachments/a:secret', '/absolute', 'attachments/CON.txt', 'linkedin/.claude/secret']) {
      updateManifest(backup.path, m => m.files.push({ path: p, size: 1, hash: '0'.repeat(64) }))
      assert.throws(() => inspectBackup(backup.path), /Caminho inválido|fora das pastas/)
      fs.writeFileSync(path.join(backup.path, 'manifest.json'), original)
    }
    updateManifest(backup.path, m => m.files.push(m.files[0])); assert.throws(() => inspectBackup(backup.path), /duplicado/); fs.writeFileSync(path.join(backup.path, 'manifest.json'), original)
    updateManifest(backup.path, m => m.schema++); assert.throws(() => inspectBackup(backup.path), /incompatível/); fs.writeFileSync(path.join(backup.path, 'manifest.json'), original)
    fs.writeFileSync(path.join(backup.path, 'unknown.txt'), 'x'); assert.throws(() => inspectBackup(backup.path), /fora das pastas/); fs.unlinkSync(path.join(backup.path, 'unknown.txt'))
    const dbfile = path.join(backup.path, 'dashboard.db'), db = new DatabaseSync(dbfile)
    db.exec('CREATE VIEW unknown AS SELECT 1'); db.close(); rehashDb(backup.path)
    assert.throws(() => inspectBackup(backup.path), /Estrutura/)
    assert.throws(() => stageRestore(f.data, backup.path), /Estrutura/); assert.equal(fs.existsSync(path.join(f.data, '.restore-pending')), false)
    fs.writeFileSync(dbfile, 'corrompido'); assert.throws(() => inspectBackup(backup.path), /corrompido/)
  } finally { f.cleanup() }
})

test('restauração: falha durante renames devolve todos os dados originais e permite nova tentativa', async t => {
  const f = fixture()
  try {
    await populated(f); const backup = createBackup(f.db, f.data, f.backups)
    const target = path.join(f.root, 'target'), db = openDb(path.join(target, 'dashboard.db'))
    db.prepare("INSERT INTO settings(key,value) VALUES ('original','yes')").run(); db.close()
    fs.mkdirSync(path.join(target, 'production')); fs.writeFileSync(path.join(target, 'production', 'old.txt'), 'old')
    stageRestore(target, backup.path)
    const real = fs.renameSync; let failed = false
    t.mock.method(fs, 'renameSync', (a: fs.PathLike, b: fs.PathLike) => {
      if (!failed && String(a).includes(path.join('.restore-transaction', 'new', 'production'))) { failed = true; throw Error('falha simulada de disco') }
      return real(a, b)
    })
    assert.throws(() => applyPendingRestore(target), /falha simulada/); t.mock.restoreAll()
    const restored = new DatabaseSync(path.join(target, 'dashboard.db'), { readOnly: true })
    try { assert.equal(row(restored, "SELECT value FROM settings WHERE key='original'").value, 'yes') } finally { restored.close() }
    assert.equal(fs.readFileSync(path.join(target, 'production', 'old.txt'), 'utf8'), 'old')
    assert.equal(fs.existsSync(path.join(target, 'attachments')), false); assert.ok(applyPendingRestore(target))
  } finally { t.mock.restoreAll(); f.cleanup() }
})

test('restauração: recupera diário interrompido e não mistura arquivos antigos/novos', () => {
  const f = fixture()
  try {
    f.db.prepare("INSERT INTO settings(key,value) VALUES ('original','yes')").run(); f.db.close()
    const tx = path.join(f.data, '.restore-transaction'); fs.mkdirSync(path.join(tx, 'old'), { recursive: true })
    fs.renameSync(path.join(f.data, 'dashboard.db'), path.join(tx, 'old', 'dashboard.db'))
    const replacement = openDb(path.join(f.data, 'dashboard.db')); replacement.prepare("INSERT INTO settings(key,value) VALUES ('new','yes')").run(); replacement.close()
    fs.mkdirSync(path.join(f.data, 'attachments')); fs.writeFileSync(path.join(f.data, 'attachments', 'new.txt'), 'new')
    fs.writeFileSync(path.join(tx, 'journal.json'), JSON.stringify({ format: 1, state: 'applying', had: ['dashboard.db'], restoredAt: new Date().toISOString(), safetyPath: '' }))
    assert.equal(applyPendingRestore(f.data), null)
    const restored = new DatabaseSync(path.join(f.data, 'dashboard.db'), { readOnly: true })
    try { assert.equal(row(restored, "SELECT value FROM settings WHERE key='original'").value, 'yes'); assert.equal(row(restored, "SELECT value FROM settings WHERE key='new'"), undefined) } finally { restored.close() }
    assert.equal(fs.existsSync(path.join(f.data, 'attachments')), false); assert.equal(fs.existsSync(tx), false)
    // Interrupção antes da criação do diário não moveu nada.
    fs.mkdirSync(tx); fs.writeFileSync(path.join(tx, 'leftover'), 'temp'); assert.equal(applyPendingRestore(f.data), null)
    assert.equal(fs.existsSync(tx), false)
  } finally { f.cleanup() }
})

test('preparação rejeita evidência atual ausente antes de publicar a restauração ou reiniciar', async () => {
  const f = fixture()
  try {
    await populated(f); const backup = createBackup(f.db, f.data, f.backups)
    const currentDb = fs.readFileSync(path.join(f.data, 'dashboard.db'))
    const missing = JSON.parse(row(f.db, 'SELECT images FROM project_playtests').images)[0]
    fs.unlinkSync(missing)
    assert.throws(() => stageRestore(f.data, backup.path), /anexo referenciado ausente/)
    assert.equal(fs.existsSync(path.join(f.data, '.restore-pending')), false)
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'dashboard.db')), currentDb)
    assert.equal(row(f.db, 'SELECT COUNT(*) n FROM project_playtests').n, 1)
    assert.equal(applyPendingRestore(f.data), null)
  } finally { f.cleanup() }
})

test('recibo de restauração inválido é ignorado sem bloquear startup nem expor caminhos externos', () => {
  const f = fixture()
  try {
    const receipt = path.join(f.data, '.restore-last.json')
    for (const text of ['{', 'null', JSON.stringify({ restoredAt: 'inválido', safetyPath: '' }), JSON.stringify({ restoredAt: new Date().toISOString(), safetyPath: f.backups }), JSON.stringify({ restoredAt: new Date().toISOString(), safetyPath: '../external' }), 'x'.repeat(8193)]) {
      fs.writeFileSync(receipt, text)
      assert.equal(backupInfo(f.data), null); assert.equal(applyPendingRestore(f.data), null)
    }
    fs.unlinkSync(receipt)
    const external = path.join(f.root, 'receipt-dir'); fs.mkdirSync(external); fs.symlinkSync(external, receipt, 'junction')
    assert.equal(backupInfo(f.data), null); assert.equal(applyPendingRestore(f.data), null)
    fs.unlinkSync(receipt)
    fs.writeFileSync(receipt, JSON.stringify({ restoredAt: new Date().toISOString(), safetyPath: '' }))
    assert.equal(backupInfo(f.data)?.safetyPath, '')
  } finally { f.cleanup() }
})

test('recuperação manual: preservar instalação corrompida e restaurar numa instalação nova', async () => {
  const f = fixture()
  try {
    const records = await populated(f), backup = createBackup(f.db, f.data, f.backups)
    f.db.close()
    fs.writeFileSync(path.join(f.data, 'dashboard.db'), 'banco corrompido')
    const preserved = path.resolve(f.root, 'data-preserved')
    assert.equal(path.dirname(path.resolve(f.data)), path.resolve(f.root))
    assert.equal(path.dirname(preserved), path.resolve(f.root))
    fs.renameSync(f.data, preserved)
    const fresh = openDb(path.join(f.data, 'dashboard.db')); fresh.close()
    stageRestore(f.data, backup.path); assert.ok(applyPendingRestore(f.data))
    const restored = openDb(path.join(f.data, 'dashboard.db'))
    try {
      assert.equal(row(restored, 'SELECT COUNT(*) n FROM messages').n, 1)
      assert.equal(row(restored, 'SELECT hash FROM project_builds').hash, records.build.hash)
      assert.equal(createPlaytestService(restored, path.join(f.data, 'production')).images(f.game, row(restored, 'SELECT id FROM project_playtests').id).length, 1)
      assert.equal(row(restored, "SELECT value FROM settings WHERE key='linkedinAuth'"), undefined)
    } finally { restored.close() }
    assert.equal(fs.readFileSync(path.join(preserved, 'dashboard.db'), 'utf8'), 'banco corrompido')
  } finally { f.cleanup() }
})
