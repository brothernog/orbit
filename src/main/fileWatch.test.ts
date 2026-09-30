import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changedFiles, fileDiff, ignored, mergeChanges, parseNumstat, stopWatching, watchDir } from './fileWatch.ts'

test('numstat: contagens, binario sem numero inventado e renomeio fica com o nome novo', () => {
  const m = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tart/logo.png\n4\t0\tsrc/{old => new}/b.ts\n1\t1\tx.ts => y.ts\n')
  assert.deepEqual(m.get('src/a.ts'), { added: 12, removed: 3 })
  assert.deepEqual(m.get('art/logo.png'), { added: null, removed: null })
  assert.deepEqual(m.get('src/new/b.ts'), { added: 4, removed: 0 })
  assert.ok(m.has('y.ts'))
})

test('lista de arquivos: novo conta as proprias linhas, pastas ignoradas somem, gravacao mais recente primeiro', () => {
  const list = mergeChanges(
    [{ path: 'a.gd', status: 'M' }, { path: 'novo.gd', status: '?' }, { path: 'node_modules/x.js', status: '?' }, { path: 'b.gd', status: 'M' }],
    parseNumstat('5\t2\ta.gd\n1\t0\tb.gd\n'), new Map([['b.gd', 200], ['a.gd', 100]]), rel => (rel === 'novo.gd' ? 7 : null))
  assert.deepEqual(list.map(f => [f.path, f.added, f.removed, f.lastWrite]), [['b.gd', 1, 0, 200], ['a.gd', 5, 2, 100], ['novo.gd', 7, 0, null]])
  assert.ok(ignored('.godot/imported/x') && ignored('sub/node_modules/y') && !ignored('src/build_tools.ts'))
})

test('pasta real com git: mudancas, diff do arquivo, caminho de fora recusado e gravacao observada', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-watch-'))
  // Close the watcher even when an assertion fails: an open fs.watch handle keeps the test process alive forever.
  t.after(() => { stopWatching(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, windowsHide: true })
  git('init', '-q')
  fs.writeFileSync(path.join(dir, 'player.gd'), 'a\nb\nc\n')
  git('add', '.'); git('commit', '-qm', 'base')
  let seen: string[] = []
  watchDir(dir, rel => seen.push(rel))
  fs.mkdirSync(path.join(dir, 'save'))
  fs.writeFileSync(path.join(dir, 'save', 'slot.gd'), 'x\ny\n')
  // On macOS the recursive watcher starts delivering events shortly after fs.watch returns, so a write right
  // away can be missed under load: rewrite the same content until the watcher reports it.
  for (let i = 0; i < 40 && !seen.includes('player.gd'); i++) {
    fs.writeFileSync(path.join(dir, 'player.gd'), 'a\nB\nc\nd\n')
    await new Promise(r => setTimeout(r, 50))
  }
  const { repo, files } = await changedFiles(dir)
  assert.equal(repo, true)
  const byPath = Object.fromEntries(files.map(f => [f.path, f]))
  assert.deepEqual([byPath['player.gd'].added, byPath['player.gd'].removed], [2, 1])
  assert.deepEqual([byPath['save/slot.gd'].status, byPath['save/slot.gd'].added], ['?', 2])
  assert.ok(seen.includes('player.gd'), `observador nao viu a gravacao: ${seen}`)
  assert.ok(byPath['player.gd'].lastWrite! > 0)
  assert.match(await fileDiff(dir, 'player.gd'), /-b\n\+B/)
  assert.match(await fileDiff(dir, 'player.gd', true), /@@[^\n]*\n a\n-b\n\+B\n c\n\+d\n?$/) // arquivo inteiro: contexto + removido + adicionado
  assert.equal(await fileDiff(dir, 'save/slot.gd'), '+x\n+y')
  await assert.rejects(fileDiff(dir, '../fora.txt'), /fora da pasta/)
})

test('lista de arquivos: corta em 200 antes de contar linhas; so os arquivos exibidos sao lidos', () => {
  const status = Array.from({ length: 1000 }, (_, i) => ({ path: `novo${String(i).padStart(4, '0')}.gd`, status: '?' as const }))
  const writes = new Map([['novo0999.gd', 50], ['novo0500.gd', 40]])
  const read: string[] = []
  const list = mergeChanges(status, new Map(), writes, rel => { read.push(rel); return 3 })
  assert.equal(list.length, 200); assert.equal(read.length, 200)
  assert.deepEqual(list.slice(0, 3).map(f => [f.path, f.lastWrite]), [['novo0999.gd', 50], ['novo0500.gd', 40], ['novo0000.gd', null]])
  assert.deepEqual(read.sort(), list.map(f => f.path).sort())
  assert.ok(list.every(f => f.added === 3 && f.removed === 0))
})
