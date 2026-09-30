import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitAll, commitSteps, createBranch, defaultBranch, ghError, pickHunks, pushArgs, remoteAhead, summarizeChecks } from './gitOps.ts'
import { run } from './projectInfo.ts'

test('gh: PR da branch principal explica o que fazer', () => {
  assert.match(ghError('head branch "main" is the same as base branch "main", cannot create a pull request'), /branch principal/)
})

test('push: primeira vez cria o upstream; depois so push', () => {
  assert.deepEqual(pushArgs('feat/x', null), ['push', '-u', 'origin', 'feat/x'])
  assert.deepEqual(pushArgs('main', 'origin/main'), ['push'])
  assert.deepEqual(pushArgs(null, null), ['push']) // HEAD solto: git explica o erro
})

test('checks do PR viram tres numeros', () => {
  assert.deepEqual(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), { ok: 3, fail: 1, running: 1 })
  assert.deepEqual(summarizeChecks(null), { ok: 0, fail: 0, running: 0 })
})

test('erros do gh em linguagem de acao', () => {
  assert.match(ghError('spawn gh ENOENT'), /não encontrado/)
  assert.match(ghError('To get started with GitHub CLI, please run:  gh auth login'), /não está logado/)
  assert.equal(ghError('no pull requests found for branch "x"'), 'Sem PR para esta branch.')
  assert.match(ghError('none of the git remotes configured for this repository point to a known GitHub host'), /remoto do GitHub/)
})

test('commit: sem lista inclui tudo; com lista usa pathspec literal', () => {
  assert.deepEqual(commitSteps('m'), [['add', '-A'], ['commit', '-m', 'm']])
  assert.deepEqual(commitSteps('m', ['a*.txt']), [['add', '-A', '--', ':(literal)a*.txt'], ['commit', '-m', 'm', '--', ':(literal)a*.txt']])
})

test('commit parcial: so os arquivos escolhidos entram, mesmo com outro ja no indice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-commit-'))
  try {
    await run(dir, ['init', '-q'])
    await run(dir, ['config', 'user.email', 't@t']); await run(dir, ['config', 'user.name', 't'])
    fs.writeFileSync(path.join(dir, 'base.txt'), '0'); await commitAll(dir, 'base')
    fs.writeFileSync(path.join(dir, 'a[1].txt'), '1'); fs.writeFileSync(path.join(dir, 'b.txt'), '2'); fs.rmSync(path.join(dir, 'base.txt'))
    await run(dir, ['add', 'b.txt']) // ja no indice, mas nao escolhido
    await commitAll(dir, 'parcial', ['a[1].txt', 'base.txt'])
    assert.deepEqual((await run(dir, ['show', '--name-only', '--format=', 'HEAD'])).trim().split(/\s+/).sort(), ['a[1].txt', 'base.txt'])
    assert.match(await run(dir, ['status', '--porcelain']), /b\.txt/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

const EOL = String.fromCharCode(13, 10)
const repo = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-hunk-'))
  await run(dir, ['init', '-q'])
  await run(dir, ['config', 'user.email', 't@t']); await run(dir, ['config', 'user.name', 't']); await run(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

test('trechos: so o marcado entra no commit; o resto fica na pasta (arquivo CRLF, outro ja no indice)', async () => {
  const dir = await repo()
  try {
    const lines = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`)
    fs.writeFileSync(path.join(dir, 'f.txt'), lines.join(EOL) + EOL); fs.writeFileSync(path.join(dir, 'o.txt'), 'o')
    await commitAll(dir, 'base')
    lines[1] = 'MUDOU 2'; lines[27] = 'MUDOU 28'
    fs.writeFileSync(path.join(dir, 'f.txt'), lines.join(EOL) + EOL)
    fs.writeFileSync(path.join(dir, 'o.txt'), 'outro'); await run(dir, ['add', 'o.txt'])
    const heads = (await run(dir, ['diff', 'HEAD', '--no-color', '--', 'f.txt'])).split('\n').filter(l => l.startsWith('@@'))
    assert.equal(heads.length, 2)
    await commitAll(dir, 'so o primeiro', [], [{ path: 'f.txt', skip: [heads[1]] }])
    const head = await run(dir, ['show', 'HEAD:f.txt'])
    assert.ok(head.includes('MUDOU 2') && !head.includes('MUDOU 28') && head.includes(EOL))
    assert.deepEqual((await run(dir, ['show', '--name-only', '--format=', 'HEAD'])).trim(), 'f.txt') // o.txt ficou fora
    assert.ok(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8').includes('MUDOU 28')) // pasta intacta
    assert.equal((await run(dir, ['diff', '--cached', '--name-only'])).trim(), 'o.txt') // indice real: so o que ja estava
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('trechos: diff que mudou ou nada marcado da erro claro', () => {
  const d = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '@@ -9 +9 @@ f', '-c', '+d', ''].join('\n')
  assert.equal(pickHunks(d, ['@@ -9 +9 @@ f']), ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', ''].join('\n'))
  assert.throws(() => pickHunks(d, ['@@ -5 +5 @@']), /mudou/)
  assert.throws(() => pickHunks(d, ['@@ -1 +1 @@', '@@ -9 +9 @@ f']), /Nenhum/)
})

test('antes do push: conta commits novos no remoto (via fetch)', async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-remote-'))
  const a = await repo(), b = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-b-'))
  try {
    await run(remote, ['init', '-q', '--bare'])
    fs.writeFileSync(path.join(a, 'x'), '1'); await commitAll(a, 'um')
    await run(a, ['remote', 'add', 'origin', remote]); await run(a, ['push', '-q', '-u', 'origin', 'HEAD'])
    await run(b, ['clone', '-q', remote, '.']); await run(b, ['config', 'user.email', 't@t']); await run(b, ['config', 'user.name', 't'])
    assert.equal(await remoteAhead(a), 0)
    const cur = (await run(b, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    assert.equal(await defaultBranch(b), cur) // clone: origin/HEAD
    assert.equal(await defaultBranch(a), ['main', 'master'].includes(cur) ? cur : null) // remote adicionado a mao: main/master
    fs.writeFileSync(path.join(b, 'y'), '2'); await commitAll(b, 'dois'); await run(b, ['push', '-q'])
    assert.equal(await remoteAhead(a), 1)
    const lone = await repo()
    try { assert.equal(await remoteAhead(lone), 0) } finally { fs.rmSync(lone, { recursive: true, force: true }) } // sem remoto: fetch nao faz nada
  } finally { for (const d of [remote, a, b]) fs.rmSync(d, { recursive: true, force: true }) }
})

test('nova branch: leva as alteracoes, recusa nome invalido ou repetido', async () => {
  const dir = await repo()
  try {
    fs.writeFileSync(path.join(dir, 'a'), '1'); await commitAll(dir, 'base')
    fs.writeFileSync(path.join(dir, 'a'), '2')
    await createBranch(dir, 'feat/nova')
    assert.equal((await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'feat/nova')
    assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), '2')
    await assert.rejects(createBranch(dir, 'com espaco'), /válido/)
    await assert.rejects(createBranch(dir, 'feat/nova'), /já existe/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
