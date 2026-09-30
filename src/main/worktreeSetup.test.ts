import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyIntoWorktree, copyNote, copySuggestions, normalizeCopyList } from './worktreeSetup.ts'

test('lista: relativa, sem sair da pasta, sem .git/.worktrees, sem repetidos', () => {
  assert.deepEqual(normalizeCopyList(['.env', './.godot/', 'config\\local.json', '.ENV']), ['.ENV', '.godot', 'config/local.json'])
  for (const bad of ['../x', 'C:/x', '/etc/x', '.git/config', '.worktrees', 'a//b', '']) assert.throws(() => normalizeCopyList([bad]), bad)
  assert.throws(() => normalizeCopyList('x'))
})

test('copia arquivo e pasta ignorados sem sobrescrever o versionado; sugere o que o git ignora', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtcopy-'))
  const game = path.join(root, 'jogo'), wt = path.join(root, 'wt')
  fs.mkdirSync(path.join(game, '.godot', 'imported'), { recursive: true })
  fs.writeFileSync(path.join(game, '.env'), 'SEGREDO=1')
  fs.writeFileSync(path.join(game, '.godot', 'imported', 'a.ctex'), 'x')
  fs.writeFileSync(path.join(game, '.gitignore'), '.env\n.godot/\n')
  fs.writeFileSync(path.join(game, 'versionado.txt'), 'original')
  execFileSync('git', ['init', '-q'], { cwd: game })
  assert.deepEqual(await copySuggestions(game), ['.env', '.godot'])
  fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'versionado.txt'), 'da branch')
  fs.writeFileSync(path.join(game, 'versionado.txt'), 'mudado')
  const r = await copyIntoWorktree(game, wt, ['.env', '.godot', 'versionado.txt', 'sumiu.txt'])
  assert.deepEqual(r, { copied: ['.env', '.godot/', 'versionado.txt'], missing: ['sumiu.txt'], failed: [] })
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SEGREDO=1')
  assert.ok(fs.existsSync(path.join(wt, '.godot', 'imported', 'a.ctex')))
  assert.equal(fs.readFileSync(path.join(wt, 'versionado.txt'), 'utf8'), 'da branch') // nunca sobrescreve
  assert.match(copyNote(r)!, /Copiado para a worktree: \.env, \.godot\/, versionado\.txt\.\nNão encontrado.*sumiu\.txt/)
  assert.equal(copyNote({ copied: [], missing: [], failed: [] }), null)
  fs.rmSync(root, { recursive: true, force: true })
})
