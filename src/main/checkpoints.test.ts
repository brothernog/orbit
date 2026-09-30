import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { CHECKPOINT_PREFIX, createCheckpoint, listCheckpoints, previewRewind, rewindCheckpoint } from './checkpoints.ts'
import { run } from './projectInfo.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-checkpoints-'))
const db = openDb(path.join(tmp, 't.db'))

const repo = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-cp-'))
  await run(dir, ['init', '-q'])
  await run(dir, ['config', 'user.email', 't@t']); await run(dir, ['config', 'user.name', 't'])
  await run(dir, ['config', 'core.autocrlf', 'false'])
  await run(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}
const log = (dir: string) => run(dir, ['log', '--format=%s']).then(s => s.trim().split('\n').filter(Boolean))

test('sujo vira commit orbita-checkpoint:; limpo so registra o HEAD', async () => {
  const dir = await repo()
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), '1')
    const c1 = await createCheckpoint(db, dir, 1, {})
    assert.equal(c1.committed, 1)
    assert.ok(c1.head && c1.head !== c1.base)
    assert.match((await log(dir))[0], new RegExp(`^${CHECKPOINT_PREFIX}`))
    const n = (await log(dir)).length
    const c2 = await createCheckpoint(db, dir, 1, {})
    assert.equal(c2.committed, 0)
    assert.equal(c2.head, c1.head)
    assert.equal((await log(dir)).length, n) // limpo nao commita
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('lista recente primeiro e poda em 20 por tarefa', async () => {
  const dir = await repo()
  try {
    fs.writeFileSync(path.join(dir, 'f.txt'), '0')
    for (let i = 0; i < 22; i++) { fs.writeFileSync(path.join(dir, 'f.txt'), String(i)); await createCheckpoint(db, dir, 2, {}) }
    const list = listCheckpoints(db, 2)
    assert.equal(list.length, 20)
    assert.ok(list[0].id > list[list.length - 1].id)
    assert.equal(listCheckpoints(db, 9999).length, 0) // nada vaza entre tarefas
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('volta restaura o modificado, remove o novo nao versionado e preserva o ignorado', async () => {
  const dir = await repo()
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n')
    fs.writeFileSync(path.join(dir, 'jogo.txt'), 'bom')
    fs.writeFileSync(path.join(dir, '.env'), 'SEGREDO=1')
    await run(dir, ['add', '-A']); await run(dir, ['commit', '-qm', 'base'])
    const cp = await createCheckpoint(db, dir, 3, {})
    assert.equal(cp.committed, 0) // limpo apos o commit manual
    fs.writeFileSync(path.join(dir, 'jogo.txt'), 'quebrado pelo agente')
    fs.writeFileSync(path.join(dir, 'novo.txt'), 'lixo')
    fs.writeFileSync(path.join(dir, '.env'), 'SEGREDO=2')
    const prev = await previewRewind(db, dir, 3, cp.id)
    assert.equal(prev.dirtyNow, true)
    assert.deepEqual(prev.blocked, [])
    await rewindCheckpoint(db, dir, 3, cp.id, prev.token)
    assert.equal(fs.readFileSync(path.join(dir, 'jogo.txt'), 'utf8'), 'bom')
    assert.ok(!fs.existsSync(path.join(dir, 'novo.txt')))
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SEGREDO=2') // ignorado intacto
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('token obsoleto, pasta errada e MERGE_HEAD recusam a volta', async () => {
  const dir = await repo()
  const other = await repo()
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), '1')
    const cp = await createCheckpoint(db, dir, 4, {})
    fs.writeFileSync(path.join(dir, 'a.txt'), '2')
    const prev = await previewRewind(db, dir, 4, cp.id)
    await assert.rejects(rewindCheckpoint(db, dir, 4, cp.id, 'token-velho'), /prévia de novo/)
    await assert.rejects(previewRewind(db, other, 4, cp.id), /outra pasta/)
    await assert.rejects(previewRewind(db, dir, 5, cp.id), /nesta tarefa/)
    fs.writeFileSync(path.join(await run(dir, ['rev-parse', '--git-dir']).then(d => path.resolve(dir, d.trim())), 'MERGE_HEAD'), 'x')
    await assert.rejects(createCheckpoint(db, dir, 4, {}), /pendente/)
    const blocked = await previewRewind(db, dir, 4, cp.id) // previa nao lanca: devolve bloqueado para a UI desabilitar
    assert.match(blocked.blocked.join(' '), /pendente/)
    await assert.rejects(rewindCheckpoint(db, dir, 4, cp.id, blocked.token), /pendente/)
    assert.match(prev.token, /^[0-9a-f]{64}$/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }) }
})

test('sem git e repo vazio limpo: criar recusa, voltar sem head recusa', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-cp-plain-'))
  const empty = await repo()
  try {
    await assert.rejects(createCheckpoint(db, plain, 6, {}), /não é um repositório Git/)
    const cp = await createCheckpoint(db, empty, 6, {})
    assert.equal(cp.head, null)
    await assert.rejects(previewRewind(db, empty, 6, cp.id), /Nada a restaurar/)
  } finally { fs.rmSync(plain, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }) }
})
