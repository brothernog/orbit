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
    const buildId = await s.registerBuild(game, raw), b = s.listBuilds(game)[0]
    assert.equal(b.state, 'pending'); assert.equal(b.source_task_id, task)
    await assert.rejects(s.exportFile(game, 'build', buildId, path.join(f.root, 'out.zip')), /Aprove/)
    await assert.rejects(s.reviewBuild(other, buildId, b.hash, 'approved'), /outro projeto/)
    await s.reviewBuild(game, buildId, b.hash, 'approved')
    assert.equal(await s.registerBuild(game, raw), buildId)
    assert.equal(s.listBuilds(game)[0].state, 'approved')
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
