import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { run } from './projectInfo.ts'
import { createWorktreeService } from './worktrees.ts'

const fixture = async () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-worktree-')), source = path.join(game, '.worktrees', 'task-one')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)')
  await run(game, ['init', '-q', '-b', 'main'])
  await run(game, ['config', 'user.name', 'Test'])
  await run(game, ['config', 'user.email', 'test@users.noreply.github.com'])
  await run(game, ['config', 'core.autocrlf', 'false'])
  await run(game, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(game, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(game, '.gitignore'), '.worktrees/\n*.ignored\n')
  await run(game, ['add', '.']); await run(game, ['commit', '-qm', 'base'])
  await run(game, ['worktree', 'add', '-q', '-b', 'task/one', source])
  const commit = async (dir: string, file: string, text: string) => { fs.writeFileSync(path.join(dir, file), text); await run(dir, ['add', '--', file]); await run(dir, ['commit', '-qm', file]) }
  const dispose = () => {
    db.close()
    assert.ok(path.resolve(game).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(game).startsWith('gpd-worktree-'))
    fs.rmSync(game, { recursive: true, force: true })
  }
  return { game, source, db, service: createWorktreeService(db), commit, dispose }
}

test('worktree: previa valida os hashes, merge revisado sobrevive ao reinicio e remove preservando branch', async () => {
  const f = await fixture()
  try {
    await f.commit(f.source, 'feature.txt', 'feature\n')
    const preview = await f.service.previewMerge(f.game, f.source)
    assert.deepEqual(preview.files, ['feature.txt']); assert.equal(preview.commits.length, 1)
    await f.commit(f.source, 'second.txt', 'second\n')
    await assert.rejects(f.service.beginMerge(f.game, f.source, preview.token), /previa mudou/)
    const fresh = await f.service.previewMerge(f.game, f.source)
    const merge = await f.service.beginMerge(f.game, f.source, fresh.token)
    assert.equal(merge.pending?.owned, true); assert.equal(merge.pending?.mergeStarted, true)
    assert.deepEqual(merge.pending?.staged, ['feature.txt', 'second.txt'])
    assert.equal((await run(f.game, ['rev-parse', 'HEAD'])).trim(), fresh.target.head)
    assert.throws(() => f.service.assertAvailable(f.game), /pendente|integracao/)
    assert.doesNotThrow(() => f.service.assertAvailable(f.source))
    const restarted = createWorktreeService(f.db), resumed = await restarted.view(f.game)
    const done = await restarted.finishMerge(f.game, resumed.pending!.token)
    assert.equal(done.pending, null)
    assert.equal((await run(f.game, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 3)
    const removal = await restarted.previewRemoval(f.game, f.source)
    assert.deepEqual(removal.blockers, [])
    assert.deepEqual(await restarted.remove(f.game, f.source, removal.token), { path: fs.realpathSync.native(f.game) + path.sep + '.worktrees' + path.sep + 'task-one' })
    assert.equal(fs.existsSync(f.source), false)
    assert.equal((await restarted.view(f.game)).removal?.missing, true)
    assert.deepEqual(await createWorktreeService(f.db).recoverRemoval(f.game), { path: removal.source.path })
    restarted.ackRemoval(f.game, removal.source.path)
    assert.equal((await restarted.view(f.game)).removal, null)
    assert.equal((await run(f.game, ['rev-parse', 'task/one'])).trim(), fresh.source.head)
  } finally { f.dispose() }
})

test('worktree: recuperacao da limpeza nao segue pasta substituida nem troca do ancestral', async () => {
  const f = await fixture()
  try {
    const p = await f.service.previewRemoval(f.game, f.source)
    await f.service.remove(f.game, f.source, p.token)
    const restarted = createWorktreeService(f.db)
    fs.mkdirSync(f.source)
    await assert.rejects(restarted.recoverRemoval(f.game), /pasta ainda existe/)
    assert.equal(fs.existsSync(f.source), true)
    fs.rmdirSync(f.source)
    const managed = path.dirname(f.source), old = managed + '-old'
    fs.renameSync(managed, old); fs.mkdirSync(managed)
    await assert.rejects(restarted.recoverRemoval(f.game), /substituida/)
    assert.ok((await restarted.view(f.game)).removal)
    fs.rmdirSync(managed); fs.symlinkSync(os.tmpdir(), managed, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(restarted.recoverRemoval(f.game), /fora do projeto/)
    fs.unlinkSync(managed)
  } finally { f.dispose() }
})

test('worktree: conflitos exigem indice resolvido e nova revisao; abort usa estado nativo', async () => {
  const f = await fixture()
  try {
    await f.commit(f.source, 'base.txt', 'source\n')
    await f.commit(f.game, 'base.txt', 'target\n')
    const preview = await f.service.previewMerge(f.game, f.source)
    const merged = await f.service.beginMerge(f.game, f.source, preview.token)
    assert.deepEqual(merged.pending?.conflicts, ['base.txt'])
    await assert.rejects(f.service.finishMerge(f.game, merged.pending!.token), /Resolva/)
    fs.writeFileSync(path.join(f.game, 'base.txt'), 'resolved\n')
    await assert.rejects(f.service.finishMerge(f.game, merged.pending!.token), /mudou/)
    let current = await f.service.view(f.game)
    assert.equal(current.pending?.unstaged, true)
    await assert.rejects(f.service.finishMerge(f.game, current.pending!.token), /Resolva/)
    await run(f.game, ['add', '--', 'base.txt'])
    current = await f.service.view(f.game)
    assert.deepEqual(current.pending?.conflicts, [])
    fs.writeFileSync(path.join(f.game, 'keep-new.txt'), 'new\n')
    current = await f.service.view(f.game)
    await assert.rejects(f.service.finishMerge(f.game, current.pending!.token), /Resolva/)
    await f.service.abortMerge(f.game, current.pending!.token)
    assert.equal(fs.readFileSync(path.join(f.game, 'base.txt'), 'utf8'), 'target\n')
    assert.equal(fs.readFileSync(path.join(f.game, 'keep-new.txt'), 'utf8'), 'new\n')
    assert.equal((await f.service.view(f.game)).pending, null)
    fs.unlinkSync(path.join(f.game, 'keep-new.txt'))
    const again = await f.service.previewMerge(f.game, f.source)
    await f.service.beginMerge(f.game, f.source, again.token)
    fs.writeFileSync(path.join(f.game, 'base.txt'), 'resolved\n'); await run(f.game, ['add', '--', 'base.txt'])
    await f.service.finishMerge(f.game, (await f.service.view(f.game)).pending!.token)
    assert.equal(fs.readFileSync(path.join(f.game, 'base.txt'), 'utf8'), 'resolved\n')
  } finally { f.dispose() }
})

test('worktree: nunca assume merge externo e protege arquivos ignorados do destino', async () => {
  const f = await fixture()
  try {
    await f.commit(f.source, 'base.txt', 'source\n'); await f.commit(f.game, 'base.txt', 'target\n')
    await assert.rejects(run(f.game, ['merge', '--no-ff', '--no-commit', 'task/one']))
    const foreign = await f.service.view(f.game)
    assert.equal(foreign.pending?.owned, false)
    await assert.rejects(f.service.abortMerge(f.game, foreign.pending!.token), /nao pertence/)
    await assert.rejects(f.service.dismissMerge(f.game, foreign.pending!.token), /nao pertence/)
    await assert.rejects(f.service.finishMerge(f.game, foreign.pending!.token), /nao pertence/)
    await assert.rejects(f.service.previewMerge(f.game, f.source), /pendente/)
    await run(f.game, ['merge', '--abort'])
    fs.writeFileSync(path.join(f.source, 'keep.ignored'), 'incoming\n')
    await run(f.source, ['add', '-f', '--', 'keep.ignored']); await run(f.source, ['commit', '-qm', 'ignored path tracked'])
    fs.writeFileSync(path.join(f.game, 'keep.ignored'), 'local secret\n')
    await assert.rejects(f.service.previewMerge(f.game, f.source), /ignorados/)
    assert.equal(fs.readFileSync(path.join(f.game, 'keep.ignored'), 'utf8'), 'local secret\n')
    assert.equal((await f.service.view(f.game)).pending, null)
  } finally { f.dispose() }
})

test('worktree: flags adicionadas durante o merge impedem conclusao e aborto com edicoes ocultas', async () => {
  const f = await fixture()
  try {
    await f.commit(f.source, 'feature.txt', 'feature\n')
    const preview = await f.service.previewMerge(f.game, f.source)
    const begun = await f.service.beginMerge(f.game, f.source, preview.token)
    await run(f.game, ['update-index', '--skip-worktree', '--', 'base.txt'])
    const hidden = Buffer.from('post merge hidden edit\n')
    fs.writeFileSync(path.join(f.game, 'base.txt'), hidden)
    const flagged = await f.service.view(f.game)
    assert.notEqual(flagged.pending!.token, begun.pending!.token)
    assert.match(flagged.pending!.blocked.join(' '), /skip-worktree/)
    await assert.rejects(f.service.finishMerge(f.game, flagged.pending!.token), /skip-worktree/)
    await assert.rejects(f.service.abortMerge(f.game, flagged.pending!.token), /skip-worktree/)
    assert.deepEqual(fs.readFileSync(path.join(f.game, 'base.txt')), hidden)
    await run(f.game, ['update-index', '--no-skip-worktree', '--', 'base.txt'])
    const exposed = await f.service.view(f.game)
    assert.notEqual(exposed.pending!.token, flagged.pending!.token)
    assert.equal(exposed.pending!.unstaged, true)
    assert.equal((await f.service.abortMerge(f.game, exposed.pending!.token)).pending, null)
  } finally { f.dispose() }
})

test('worktree: reinicio reconhece apenas o commit com os dois pais esperados', async () => {
  const f = await fixture()
  try {
    await f.commit(f.source, 'feature.txt', 'feature')
    let p = await f.service.previewMerge(f.game, f.source)
    await f.service.beginMerge(f.game, f.source, p.token)
    await run(f.game, ['commit', '--no-edit'])
    const restarted = createWorktreeService(f.db)
    assert.doesNotThrow(() => restarted.assertAvailable(f.game))
    assert.equal((await restarted.view(f.game)).pending, null)
    await f.commit(f.source, 'second.txt', 'second')
    p = await restarted.previewMerge(f.game, f.source)
    await restarted.beginMerge(f.game, f.source, p.token)
    await run(f.game, ['merge', '--abort'])
    await f.commit(f.game, 'unrelated.txt', 'unrelated')
    assert.equal((await createWorktreeService(f.db).view(f.game)).pending?.owned, false)
    assert.throws(() => restarted.assertAvailable(f.game), /integracao/)
    await assert.rejects(restarted.abortMerge(f.game, (await restarted.view(f.game)).pending!.token), /nao pertence/)
    const head = (await run(f.game, ['rev-parse', 'HEAD'])).trim()
    assert.equal((await restarted.dismissMerge(f.game, (await restarted.view(f.game)).pending!.token)).pending, null)
    assert.equal((await run(f.game, ['rev-parse', 'HEAD'])).trim(), head)
    assert.equal(fs.readFileSync(path.join(f.game, 'unrelated.txt'), 'utf8'), 'unrelated')
    assert.doesNotThrow(() => restarted.assertAvailable(f.game))
  } finally { f.dispose() }
})

test('worktree: limpeza recusa ignorados, alteracoes, commits nao integrados, locks e tokens antigos', async () => {
  const f = await fixture()
  try {
    for (const flag of ['skip-worktree', 'assume-unchanged']) {
      await run(f.source, ['update-index', `--${flag}`, '--', 'base.txt'])
      const hidden = Buffer.from(`local hidden ${flag}\n`)
      fs.writeFileSync(path.join(f.source, 'base.txt'), hidden)
      assert.equal(await run(f.source, ['status', '--porcelain=v1', '-z']), '')
      assert.equal(await run(f.source, ['diff']), '')
      const flagged = await f.service.previewRemoval(f.game, f.source)
      assert.match(flagged.blockers.join(' '), /skip-worktree|assume-unchanged/)
      await assert.rejects(f.service.remove(f.game, f.source, flagged.token), /skip-worktree|assume-unchanged/)
      await assert.rejects(f.service.previewMerge(f.game, f.source), /skip-worktree|assume-unchanged/)
      assert.deepEqual(fs.readFileSync(path.join(f.source, 'base.txt')), hidden)
      await run(f.source, ['update-index', `--no-${flag}`, '--', 'base.txt'])
      assert.match((await f.service.previewRemoval(f.game, f.source)).blockers.join(' '), /alteracoes/)
      fs.writeFileSync(path.join(f.source, 'base.txt'), 'base\n')
      await run(f.game, ['update-index', `--${flag}`, '--', 'base.txt'])
      fs.writeFileSync(path.join(f.game, 'base.txt'), hidden)
      await assert.rejects(f.service.previewMerge(f.game, f.source), /skip-worktree|assume-unchanged/)
      assert.deepEqual(fs.readFileSync(path.join(f.game, 'base.txt')), hidden)
      await run(f.game, ['update-index', `--no-${flag}`, '--', 'base.txt'])
      fs.writeFileSync(path.join(f.game, 'base.txt'), 'base\n')
    }
    let p = await f.service.previewRemoval(f.game, f.source)
    fs.writeFileSync(path.join(f.source, 'local.ignored'), 'private')
    await assert.rejects(f.service.remove(f.game, f.source, p.token), /mudou/)
    p = await f.service.previewRemoval(f.game, f.source)
    assert.match(p.blockers.join(' '), /ignorados/)
    await assert.rejects(f.service.remove(f.game, f.source, p.token), /ignorados/)
    fs.unlinkSync(path.join(f.source, 'local.ignored'))
    fs.writeFileSync(path.join(f.source, 'new.txt'), 'new')
    assert.match((await f.service.previewRemoval(f.game, f.source)).blockers.join(' '), /alteracoes/)
    fs.unlinkSync(path.join(f.source, 'new.txt'))
    await run(f.game, ['worktree', 'lock', f.source])
    assert.match((await f.service.previewRemoval(f.game, f.source)).blockers.join(' '), /bloqueada/)
    await run(f.game, ['worktree', 'unlock', f.source])
    await f.commit(f.source, 'new.txt', 'new')
    p = await f.service.previewRemoval(f.game, f.source)
    assert.match(p.blockers.join(' '), /commits/)
    await assert.rejects(f.service.remove(f.game, f.source, p.token), /commits/)
    assert.ok(fs.existsSync(f.source))
  } finally { f.dispose() }
})

test('worktree: pasta externa, repo aninhado, HEAD destacado e operacoes paralelas ficam fora', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.service.previewMerge(f.game, f.game), /fora/)
    const nested = path.join(f.game, '.worktrees', 'fake'); fs.mkdirSync(nested)
    await run(nested, ['init', '-q'])
    await assert.rejects(f.service.previewMerge(f.game, nested), /nao registrada/)
    await run(f.source, ['checkout', '--detach', '-q'])
    await assert.rejects(f.service.previewMerge(f.game, f.source), /destacado/)
    await run(f.source, ['checkout', '-q', 'task/one'])
    const second = path.join(f.game, '.worktrees', 'task-two'), gitFile = path.join(f.source, '.git')
    await run(f.game, ['worktree', 'add', '-q', '-b', 'task/two', second])
    const original = fs.readFileSync(gitFile)
    fs.copyFileSync(path.join(second, '.git'), gitFile)
    await assert.rejects(f.service.previewMerge(f.game, f.source), /identidade/)
    fs.unlinkSync(gitFile); fs.writeFileSync(gitFile, original)
    const gitDir = path.resolve(f.source, (await run(f.source, ['rev-parse', '--git-dir'])).trim())
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'))
    await assert.rejects(f.service.previewMerge(f.game, f.source), /pendente/)
    assert.throws(() => f.service.assertAvailable(f.source), /pendente/)
    fs.rmdirSync(path.join(gitDir, 'rebase-merge'))
    assert.doesNotThrow(() => f.service.assertAvailable(nested))
    assert.doesNotThrow(() => f.service.assertAvailable(os.tmpdir()))
    const oldPath = process.env.PATH
    try {
      process.env.PATH = ''
      assert.doesNotThrow(() => f.service.assertAvailable(os.tmpdir()))
      assert.throws(() => f.service.assertAvailable(f.game), /verificar/)
    } finally { process.env.PATH = oldPath }
  } finally { f.dispose() }
})
