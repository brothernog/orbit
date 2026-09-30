import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { detectKind, parseStatus, parseWorktrees } from './projectInfo.ts'

test('status do git: branch, upstream, ahead/behind e arquivos por tipo', () => {
  const s = parseStatus('## main...origin/main [ahead 2, behind 1]\n M src/a.ts\nA  novo.ts\n D velho.ts\n?? solto.txt\nR  x.ts -> y.ts\n')
  assert.equal(s.branch, 'main')
  assert.equal(s.upstream, 'origin/main')
  assert.deepEqual([s.ahead, s.behind], [2, 1])
  assert.deepEqual(s.files.map(f => f.status + f.path), ['Msrc/a.ts', 'Anovo.ts', 'Dvelho.ts', '?solto.txt', 'My.ts'])
  assert.equal(parseStatus('## No commits yet on main\n').branch, 'main')
  assert.equal(parseStatus('## feat/x\n').upstream, null)
  assert.equal(parseStatus('## HEAD (no branch)\n').branch, null)
})

test('worktree list --porcelain vira caminho + branch', () => {
  const w = parseWorktrees('worktree C:/p\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/p/.worktrees/t1\nHEAD def\nbranch refs/heads/task/1-x\n\nworktree C:/p/.worktrees/t2\nHEAD 123\ndetached\n')
  assert.deepEqual(w.map(x => x.branch), ['main', 'task/1-x', null])
})

test('tipo do projeto vem dos arquivos da raiz', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-'))
  assert.deepEqual(detectKind(d), { kind: 'app', stack: 'Projeto' })
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ devDependencies: { electron: '1' } }))
  assert.deepEqual(detectKind(d), { kind: 'app', stack: 'Electron' })
  fs.writeFileSync(path.join(d, 'project.godot'), '')
  assert.deepEqual(detectKind(d), { kind: 'game', stack: 'Godot' })
})
