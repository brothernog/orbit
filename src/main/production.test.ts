import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask, deleteTask } from './tasks.ts'
import { createProductionService } from './production.ts'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-production-'))
  const game = path.join(root, 'game'), other = path.join(root, 'other'), data = path.join(root, 'data')
  fs.mkdirSync(game); fs.mkdirSync(other)
  const db = new DatabaseSync(':memory:'); migrate(db)
  return { root, game, other, data, db, service: createProductionService(db, data), cleanup() { db.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/UAAAAAASUVORK5CYII=', 'base64')

test('assets: captura imutável, versões/dedupe, ownership, revisão vinculada ao hash e exportação exclusiva', async () => {
  const f = fixture(), { service: s, game, other, root } = f
  try {
    fs.writeFileSync(path.join(game, 'sprite.png'), pixel)
    const id = await s.captureAsset(game, { title: 'Jogador', path: 'sprite.png', kind: 'sprite', license: 'CC0', source: 'Desenho próprio', tags: 'player', note: 'Primeiro' })
    const a = s.listAssets(game)[0], v = a.versions[0]
    assert.equal(a.id, id); assert.equal(v.state, 'pending'); assert.equal(s.listAssets(other).length, 0)
    assert.equal(s.readAssetImage(game, v.id), `data:image/png;base64,${pixel.toString('base64')}`)
    assert.throws(() => s.readAssetImage(other, v.id), /outro projeto/)
    await assert.rejects(s.reviewAssetVersion(other, v.id, v.hash, 'approved'), /outro projeto/)
    await assert.rejects(s.reviewAssetVersion(game, v.id, '0'.repeat(64), 'approved'), /mudou/)
    await assert.rejects(s.reviewAssetVersion(game, v.id, v.hash, 'invalid'), /inválida/)
    await assert.rejects(s.exportFile(game, 'asset', v.id, path.join(root, 'export.png')), /Aprove/)
    await s.reviewAssetVersion(game, v.id, v.hash, 'approved')
    assert.equal(await s.captureAssetVersion(game, id, 'Mesmo arquivo'), v.id)
    assert.equal(await s.captureAsset(game, { title: 'Outra tentativa', path: './sprite.png' }), id)
    assert.equal(s.listAssets(game)[0].title, 'Jogador'); assert.equal(s.listAssets(game)[0].versions[0].state, 'approved')
    fs.writeFileSync(path.join(game, 'sprite.png'), Buffer.concat([pixel, Buffer.from('novo')]))
    const next = await s.captureAssetVersion(game, id, 'Outra versão')
    assert.notEqual(next, v.id); assert.equal(s.listAssets(game)[0].versions.length, 2)
    assert.equal(s.listAssets(game)[0].versions[0].state, 'pending')
    const out = path.join(root, 'export.png')
    await s.exportFile(game, 'asset', v.id, out)
    assert.deepEqual(fs.readFileSync(out), pixel)
    await assert.rejects(s.exportFile(game, 'asset', v.id, out), { code: 'EEXIST' })
    assert.deepEqual(fs.readFileSync(out), pixel)
    await s.reviewAssetVersion(game, v.id, v.hash, 'rejected')
    await assert.rejects(s.exportFile(game, 'asset', v.id, path.join(root, 'again.png')), /Aprove/)
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n, 0)
  } finally { f.cleanup() }
})

test('assets: impede escapes/junctions, arquivos inválidos/grandes e snapshots adulterados', async () => {
  const f = fixture(), { service: s, game, other, data } = f
  try {
    fs.writeFileSync(path.join(other, 'secret.txt'), 'fora')
    await assert.rejects(s.captureAsset(game, { title: 'x', path: '../other/secret.txt' }), /fora/)
    await assert.rejects(s.captureAsset(game, { title: 'x', path: path.join(other, 'secret.txt') }), /relativo/)
    await assert.rejects(s.captureAsset(game, { title: 'x', path: '.' }), /fora/)
    await assert.rejects(s.captureAsset(game, { title: '', path: 'x' }), /Título/)
    fs.symlinkSync(other, path.join(game, 'outside'), 'junction')
    await assert.rejects(s.captureAsset(game, { title: 'x', path: 'outside/secret.txt' }), /fora/)
    const large = path.join(game, 'large.png'); fs.closeSync(fs.openSync(large, 'w')); fs.truncateSync(large, 512 * 1024 * 1024 + 1)
    await assert.rejects(s.captureAsset(game, { title: 'Grande', path: 'large.png' }), /512 MiB/)
    fs.writeFileSync(path.join(game, 'x.png'), pixel)
    await s.captureAsset(game, { title: 'X', path: 'x.png' })
    const v = s.listAssets(game)[0].versions[0], blob = path.join(data, 'blobs', v.hash)
    await s.reviewAssetVersion(game, v.id, v.hash, 'approved')
    const modified = Buffer.from(pixel); modified[20] ^= 1; fs.writeFileSync(blob, modified)
    assert.equal(s.readAssetImage(game, v.id), null)
    await assert.rejects(s.reviewAssetVersion(game, v.id, v.hash, 'approved'), /corrompido/)
    await assert.rejects(s.exportFile(game, 'asset', v.id, path.join(f.root, 'bad.png')), /corrompido/)
    await assert.rejects(s.captureAssetVersion(game, s.listAssets(game)[0].id, ''), /corrompido/)
    assert.equal(fs.readdirSync(path.join(data, 'blobs')).some(p => p.startsWith('.capture-')), false)
  } finally { f.cleanup() }
})

test('exportação: rejeição durante a cópia impede publicar a versão', async () => {
  const f = fixture(), { service: s, game } = f, originalCopy = fs.promises.copyFile
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(r => { entered = r }), resume = new Promise<void>(r => { release = r })
  try {
    fs.writeFileSync(path.join(game, 'x.png'), pixel)
    await s.captureAsset(game, { title: 'X', path: 'x.png' })
    const v = s.listAssets(game)[0].versions[0]
    await s.reviewAssetVersion(game, v.id, v.hash, 'approved')
    fs.promises.copyFile = async (...args: Parameters<typeof originalCopy>) => {
      await originalCopy(...args)
      if (path.basename(String(args[1])).startsWith('.export-')) { entered(); await resume }
    }
    const destination = path.join(f.root, 'paused.png'), exporting = s.exportFile(game, 'asset', v.id, destination)
    await started
    await s.reviewAssetVersion(game, v.id, v.hash, 'rejected')
    release(); await assert.rejects(exporting, /revisão mudou/)
    assert.equal(fs.existsSync(destination), false)
    assert.equal(fs.readdirSync(f.root).some(p => p.startsWith('.export-')), false)
  } finally { release(); fs.promises.copyFile = originalCopy; f.cleanup() }
})

test('builds: só comando concluído do projeto/worktree, aceite humano e histórico após excluir tarefa', async () => {
  const f = fixture(), { service: s, game, other, db } = f
  try {
    const task = createTask(db, game, 'Build local'), otherTask = createTask(db, other, 'Outro')
    const command = (taskId: number, workspace: string, status = 'completed', exit = 0) => Number(db.prepare('INSERT INTO command_runs(task_id,workspace,name,program,args,status,exit_code,duration_ms,ended_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(taskId, workspace, 'Empacotar', process.execPath, '["build.js"]', status, exit, 10).lastInsertRowid)
    const id = command(task, game), otherId = command(otherTask, other), failed = command(task, game, 'failed', 2), running = command(task, game, 'running', 0)
    const raw = { title: 'Demo', version: '0.1', platform: 'Windows', path: 'demo.zip', notes: 'Testar antes da publicação', commandId: id }
    fs.writeFileSync(path.join(game, 'demo.zip'), 'versão inicial')
    assert.deepEqual(s.listBuildCommands(game).map(c => c.id), [id])
    for (const commandId of [otherId, failed, running, 999]) await assert.rejects(s.registerBuild(game, { ...raw, commandId }), /comando concluído/)
    const badWorkspace = command(task, other)
    await assert.rejects(s.registerBuild(game, { ...raw, commandId: badWorkspace }), /Workspace/)
    let sourceChecks = 0
    await assert.rejects(s.registerBuild(game, raw, () => { if (++sourceChecks === 2) throw Error('Arquivos acompanhantes mudaram durante a captura.') }), /acompanhantes/)
    assert.equal(sourceChecks, 2); assert.equal(s.listBuilds(game).length, 0)
    const buildId = await s.registerBuild(game, raw), b = s.listBuilds(game)[0]
    assert.equal(b.state, 'pending'); assert.equal(b.source_task_id, task)
    await assert.rejects(s.exportFile(game, 'build', buildId, path.join(f.root, 'out.zip')), /Aprove/)
    await assert.rejects(s.reviewBuild(other, buildId, b.hash, 'approved'), /outro projeto/)
    await s.reviewBuild(game, buildId, b.hash, 'approved')
    assert.equal(await s.registerBuild(game, raw), buildId)
    assert.equal(s.listBuilds(game)[0].state, 'approved')
    const beforeEdit = s.listBuilds(game)[0]
    assert.throws(() => s.editBuild(other, buildId, { ...raw, revision: beforeEdit.revision }), /outro projeto/)
    s.editBuild(game, buildId, { title: 'Demo revisada', version: '0.1.1', platform: 'Desktop', notes: 'Nota atual', revision: beforeEdit.revision, hash: '0'.repeat(64), command: '{}' })
    const edited = s.listBuilds(game)[0]
    assert.deepEqual([edited.hash, edited.command, edited.state, edited.reviewed_at], [beforeEdit.hash, beforeEdit.command, 'approved', beforeEdit.reviewed_at])
    assert.deepEqual([edited.title, edited.version, edited.platform, edited.notes, edited.revision], ['Demo revisada', '0.1.1', 'Desktop', 'Nota atual', beforeEdit.revision + 1])
    assert.throws(() => s.editBuild(game, buildId, { ...raw, revision: beforeEdit.revision }), /mudou/)
    assert.throws(() => s.setBuildArchived(game, buildId, beforeEdit.revision, true), /mudou/)
    assert.throws(() => s.setBuildArchived(other, buildId, edited.revision, true), /outro projeto/)
    assert.throws(() => s.setBuildArchived(game, buildId, edited.revision, 1), /booleano/)
    s.setBuildArchived(game, buildId, edited.revision, true)
    assert.ok(s.listBuilds(game)[0].archived_at)
    s.setBuildArchived(game, buildId, edited.revision + 1, false)
    assert.equal(s.listBuilds(game)[0].archived_at, null)
    deleteTask(db, task)
    const preserved = s.listBuilds(game)[0]
    assert.equal(preserved.source_task_id, null); assert.equal(preserved.source_command_id, null)
    assert.equal(JSON.parse(preserved.command).task_title, 'Build local')
    assert.equal(JSON.parse(preserved.command).program, process.execPath)
    fs.writeFileSync(path.join(game, 'demo.zip'), 'alterada')
    await s.exportFile(game, 'build', buildId, path.join(f.root, 'out.zip'))
    assert.equal(fs.readFileSync(path.join(f.root, 'out.zip'), 'utf8'), 'versão inicial')
    const wtTask = createTask(db, game, 'Isolada'), wt = path.join(game, '.worktrees', 'build')
    fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'demo.zip'), 'isolada')
    db.prepare('UPDATE tasks SET worktree=? WHERE id=?').run(wt, wtTask)
    const wtId = command(wtTask, wt)
    await s.registerBuild(game, { ...raw, commandId: wtId })
    db.prepare('UPDATE tasks SET worktree=NULL WHERE id=?').run(wtTask)
    await assert.rejects(s.registerBuild(game, { ...raw, commandId: wtId }), /Workspace/)
    db.prepare('UPDATE tasks SET worktree=? WHERE id=?').run(other, wtTask)
    const escaped = command(wtTask, other)
    await assert.rejects(s.registerBuild(game, { ...raw, commandId: escaped }), /Workspace/)
  } finally { f.cleanup() }
})

test('catálogo: edição e arquivo de assets preservam caminho, snapshots e aprovação, com revisão concorrente', async () => {
  const f = fixture(), { service: s, game, other } = f
  try {
    fs.writeFileSync(path.join(game, 'x.png'), pixel)
    const id = await s.captureAsset(game, { title: 'X', path: 'x.png' }), before = s.listAssets(game)[0], v = before.versions[0]
    await s.reviewAssetVersion(game, v.id, v.hash, 'approved')
    assert.throws(() => s.editAsset(other, id, { title: 'Outro', revision: 1 }), /outro projeto/)
    for (const title of ['', 'x\0', 'x'.repeat(301)]) assert.throws(() => s.editAsset(game, id, { title, revision: 1 }), /Título/)
    assert.throws(() => s.editAsset(game, id, { title: 'Editado', revision: '1' }), /Revisão/)
    s.editAsset(game, id, { title: 'Editado', kind: 'sprite', license: 'CC0', source: 'Meu desenho', tags: 'player', revision: 1, path: 'other.png' })
    const edited = s.listAssets(game)[0]
    assert.deepEqual([edited.title, edited.kind, edited.license, edited.source, edited.tags, edited.path, edited.revision], ['Editado', 'sprite', 'CC0', 'Meu desenho', 'player', 'x.png', 2])
    assert.deepEqual([edited.versions[0].id, edited.versions[0].hash, edited.versions[0].state], [v.id, v.hash, 'approved'])
    assert.throws(() => s.editAsset(game, id, { title: 'Perdido', revision: 1 }), /mudou/)
    assert.throws(() => s.setAssetArchived(game, id, 1, true), /mudou/)
    assert.throws(() => s.setAssetArchived(other, id, 2, true), /outro projeto/)
    assert.throws(() => s.setAssetArchived(game, id, 2, 'true'), /booleano/)
    s.setAssetArchived(game, id, 2, true)
    assert.ok(s.listAssets(game)[0].archived_at); assert.equal(s.listAssets(game)[0].versions[0].state, 'approved')
    await s.exportFile(game, 'asset', v.id, path.join(f.root, 'archived.png'))
    s.setAssetArchived(game, id, 3, false)
    assert.equal(s.listAssets(game)[0].archived_at, null)
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n, 0)
  } finally { f.cleanup() }
})

test('retenção: mantém novas, pendentes, aprovadas e protegidas, compartilha hashes globalmente e reidrata IDs', async () => {
  const f = fixture(), { service: s, game, other, data, db } = f
  try {
    const write = (content: string) => fs.writeFileSync(path.join(game, 'asset.txt'), content)
    write('antiga'); const id = await s.captureAsset(game, { title: 'Asset', path: 'asset.txt', note: 'Nota original' })
    const first = s.listAssets(game)[0].versions[0]
    await s.reviewAssetVersion(game, first.id, first.hash, 'rejected')
    const add = async (content: string, state?: 'approved' | 'rejected', pinned = false) => {
      write(content); await s.captureAssetVersion(game, id, content)
      const v = s.listAssets(game)[0].versions[0]
      if (state) await s.reviewAssetVersion(game, v.id, v.hash, state)
      if (pinned) s.setAssetVersionPinned(game, v.id, v.hash, true)
      return v
    }
    const approved = await add('aprovada', 'approved'), pending = await add('pendente'), pinned = await add('protegida', 'rejected', true)
    const shared = await add('compartilhada', 'rejected'), built = await add('usada no build', 'rejected'), newest = await add('nova rejeitada', 'rejected')
    fs.writeFileSync(path.join(other, 'asset.txt'), 'compartilhada'); await s.captureAsset(other, { title: 'Outro projeto', path: 'asset.txt' })
    const buildId = Number(db.prepare('INSERT INTO project_builds(game,title,version,platform,hash,size,file_name,notes,command,archived_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(other, 'Build preservado', '1', 'Windows', built.hash, built.size, 'asset.txt', '', '{}').lastInsertRowid)
    db.prepare('INSERT INTO project_playtests(game,title,scenario,expected,observed,outcome,notes,severity,build_id,archived_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(other, 'Evidência', '', '', 'Testado', 'pass', '', 'low', buildId)
    for (const invalid of [0, -1, 1.1, '1', 101]) assert.throws(() => s.previewRetention(game, invalid), /inv.lid|entre 1/)
    assert.throws(() => s.setAssetVersionPinned(other, first.id, first.hash, true), /outro projeto/)
    assert.throws(() => s.setAssetVersionPinned(game, first.id, '0'.repeat(64), true), /mudou/)
    assert.throws(() => s.setAssetVersionPinned(game, first.id, first.hash, 1), /booleano/)
    const plan = s.previewRetention(game, 1)
    assert.deepEqual(plan.versions.map(v => v.id), [shared.id, built.id, first.id].sort((a, b) => b - a))
    assert.equal(plan.files, 1); assert.equal(plan.bytes, first.size)
    assert.throws(() => s.pruneRetention(other, 1, plan.token), /mudou/)
    const result = s.pruneRetention(game, 1, plan.token)
    assert.deepEqual(result, { versions: 3, files: 1, bytes: first.size, warnings: [] })
    assert.deepEqual(s.listAssets(game)[0].versions.map(v => v.id), [newest.id, pinned.id, pending.id, approved.id])
    assert.equal(fs.existsSync(path.join(data, 'blobs', first.hash)), false)
    for (const hash of [shared.hash, built.hash]) assert.equal(fs.existsSync(path.join(data, 'blobs', hash)), true)
    assert.equal(s.listBuilds(other)[0].id, buildId); assert.equal((db.prepare('SELECT build_id FROM project_playtests').get() as any).build_id, buildId)
    assert.throws(() => s.readAssetImage(game, first.id), /inexistente/)
    assert.throws(() => s.setAssetVersionPinned(game, first.id, first.hash, true), /inexistente/)
    await assert.rejects(s.reviewAssetVersion(game, first.id, first.hash, 'approved'), /inexistente/)
    await assert.rejects(s.exportFile(game, 'asset', first.id, path.join(f.root, 'removed.txt')), /inexistente/)
    assert.ok((db.prepare('SELECT pruned_at FROM asset_versions WHERE id=?').get(first.id) as any).pruned_at)
    write('nova identidade'); const next = await s.captureAssetVersion(game, id, 'Nova'); assert.ok(next > newest.id)
    write('antiga'); assert.equal(await s.captureAssetVersion(game, id, 'Não substitui nota'), first.id)
    const hydrated = s.listAssets(game)[0].versions.find(v => v.id === first.id)!
    assert.deepEqual([hydrated.hash, hydrated.note, hydrated.state, hydrated.pruned_at], [first.hash, 'Nota original', 'rejected', null])
    assert.equal(fs.readFileSync(path.join(data, 'blobs', first.hash), 'utf8'), 'antiga')
  } finally { f.cleanup() }
})

test('retenção: prévia obsoleta, operações assíncronas e falha de remoção preservam bytes e permitem retry', async t => {
  const f = fixture(), { service: s, game, data, db } = f
  try {
    fs.writeFileSync(path.join(game, 'asset.txt'), 'antiga')
    const id = await s.captureAsset(game, { title: 'Asset', path: 'asset.txt' }), old = s.listAssets(game)[0].versions[0]
    await s.reviewAssetVersion(game, old.id, old.hash, 'rejected')
    fs.writeFileSync(path.join(game, 'asset.txt'), 'nova'); await s.captureAssetVersion(game, id, '')
    let plan = s.previewRetention(game, 1)
    s.setAssetVersionPinned(game, old.id, old.hash, true)
    assert.throws(() => s.pruneRetention(game, 1, plan.token), /mudou/)
    assert.equal(s.listAssets(game)[0].versions.length, 2)
    s.setAssetVersionPinned(game, old.id, old.hash, false)
    plan = s.previewRetention(game, 1)
    const capturing = s.captureAssetVersion(game, id, '')
    assert.throws(() => s.previewRetention(game, 1), /em andamento/)
    assert.throws(() => s.pruneRetention(game, 1, plan.token), /em andamento/)
    await capturing
    const reviewing = s.reviewAssetVersion(game, old.id, old.hash, 'approved')
    assert.throws(() => s.previewRetention(game, 1), /em andamento/)
    await reviewing
    assert.throws(() => s.pruneRetention(game, 1, plan.token), /mudou/)
    const exporting = s.exportFile(game, 'asset', old.id, path.join(f.root, 'out.txt'))
    assert.throws(() => s.previewRetention(game, 1), /em andamento/); await exporting
    await s.reviewAssetVersion(game, old.id, old.hash, 'rejected')
    plan = s.previewRetention(game, 1)
    const build = Number(db.prepare('INSERT INTO project_builds(game,title,version,platform,hash,size,file_name,notes,command) VALUES (?,?,?,?,?,?,?,?,?)').run(game, 'Ref', '1', 'Windows', old.hash, old.size, old.file_name, '', '{}').lastInsertRowid)
    assert.throws(() => s.pruneRetention(game, 1, plan.token), /mudou/)
    db.prepare('DELETE FROM project_builds WHERE id=?').run(build)
    plan = s.previewRetention(game, 1)
    const unlink = fs.unlinkSync
    t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => { if (String(file) === path.join(data, 'blobs', old.hash)) throw Error('disco ocupado'); return unlink(file) })
    const failed = s.pruneRetention(game, 1, plan.token)
    assert.deepEqual([failed.versions, failed.files, failed.bytes, failed.warnings.length], [1, 0, 0, 1]); assert.match(failed.warnings[0], /bytes preservados/)
    assert.equal(fs.existsSync(path.join(data, 'blobs', old.hash)), true); assert.equal(s.listAssets(game)[0].versions.length, 1)
    t.mock.restoreAll()
    plan = s.previewRetention(game, 1); assert.equal(plan.versions.length, 0); assert.equal(plan.files, 1)
    assert.deepEqual(s.pruneRetention(game, 1, plan.token), { versions: 0, files: 1, bytes: old.size, warnings: [] })
    assert.equal(s.previewRetention(game, 1).files, 0)
  } finally { t.mock.restoreAll(); f.cleanup() }
})

test('retenção: arquivo substituído após o commit não é apagado', async t => {
  const f = fixture(), { service: s, game, data, db } = f
  try {
    fs.writeFileSync(path.join(game, 'asset.txt'), 'antiga')
    const id = await s.captureAsset(game, { title: 'Asset', path: 'asset.txt' }), old = s.listAssets(game)[0].versions[0]
    await s.reviewAssetVersion(game, old.id, old.hash, 'rejected')
    fs.writeFileSync(path.join(game, 'asset.txt'), 'nova'); await s.captureAssetVersion(game, id, '')
    const plan = s.previewRetention(game, 1), file = path.join(data, 'blobs', old.hash), exec = db.exec.bind(db)
    t.mock.method(db, 'exec', (sql: string) => {
      exec(sql)
      if (sql === 'COMMIT') fs.writeFileSync(file, 'substituído durante a limpeza')
    })
    const result = s.pruneRetention(game, 1, plan.token)
    assert.equal(result.files, 0); assert.equal(result.bytes, 0)
    assert.match(result.warnings[0], /mudou durante a limpeza/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'substituído durante a limpeza')
    assert.equal(s.listAssets(game)[0].versions.length, 1)
  } finally { t.mock.restoreAll(); f.cleanup() }
})
