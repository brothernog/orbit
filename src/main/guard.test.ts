import test from 'node:test'
import { cleanGroups, commitParts, commitPaths, pickGames, scopeTo } from './guard.ts'

// Caminhos com letra de unidade e sem distincao de caixa: semantica do Windows.
test('projetos: a pasta do proprio app so entra se o usuario a adicionou; fora de Documentos so se adicionada', { skip: process.platform !== 'win32' }, () => {
  const base = { docs: 'C:\\Users\\u\\Documents', appPath: 'C:\\Users\\u\\Documents\\Dashboard', isDir: () => true }
  const auto = ['C:\\Users\\u\\Documents\\Dashboard', 'C:\\Users\\u\\Documents\\Jogo', 'D:\\fora\\Outro']
  assert.deepEqual(pickGames({ ...base, projects: auto, extra: [] }), ['C:\\Users\\u\\Documents\\Jogo']) // descoberta automatica ignora o app e o que esta fora
  assert.deepEqual(pickGames({ ...base, projects: auto, extra: ['c:\\users\\u\\documents\\dashboard'] }), ['C:\\Users\\u\\Documents\\Dashboard', 'C:\\Users\\u\\Documents\\Jogo']) // adicionada de proposito (caixa diferente)
  assert.deepEqual(pickGames({ ...base, projects: [], extra: ['D:\\fora\\Outro'] }), ['D:\\fora\\Outro'])
  assert.deepEqual(pickGames({ ...base, projects: [], extra: ['C:\\Users\\u\\Documents\\Jogo', 'C:\\Users\\u\\Documents\\jogo'], isDir: () => false }), []) // nao e pasta
  assert.deepEqual(pickGames({ ...base, projects: auto, extra: ['D:\\fora\\Outro'], hidden: ['c:\\users\\u\\documents\\jogo', 'D:\\fora\\Outro'] }), []) // removido da lista some, mesmo adicionado
})
test('projetos (macOS/Linux): mesma regra com caminhos POSIX', { skip: process.platform === 'win32' }, () => {
  const base = { docs: '/home/u/Documents', appPath: '/home/u/Documents/Dashboard', isDir: () => true }
  const auto = ['/home/u/Documents/Dashboard', '/home/u/Documents/Jogo', '/fora/Outro']
  assert.deepEqual(pickGames({ ...base, projects: auto, extra: [] }), ['/home/u/Documents/Jogo'])
  assert.deepEqual(pickGames({ ...base, projects: [], extra: ['/fora/Outro'] }), ['/fora/Outro'])
  assert.deepEqual(pickGames({ ...base, projects: auto, extra: [], hidden: ['/home/u/Documents/Jogo'] }), [])
})
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asAllowedPath, asInt, asStr, inside, pathKey, safeJoin, samePath } from './guard.ts'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-guard-')))
const root = path.join(tmp, 'jogo')
const outside = path.join(tmp, 'fora')
fs.mkdirSync(root)
fs.mkdirSync(outside)
fs.writeFileSync(path.join(root, 'ok.md'), 'x')
fs.writeFileSync(path.join(outside, 'segredo.md'), 's')

test('tipos inesperados no IPC sao recusados', () => {
  for (const v of [0, -1, 1.5, '1', null, undefined, {}, NaN, Infinity]) assert.throws(() => asInt(v, 'id'), /invalido/)
  assert.equal(asInt(7, 'id'), 7)
  for (const v of [1, null, {}, ['a'], 'x'.repeat(11)]) assert.throws(() => asStr(v, 's', 10), /invalido/)
})

test('so caminhos da lista permitida', () => {
  assert.equal(asAllowedPath([root], path.join(root, '.'), 'projeto'), root)
  assert.throws(() => asAllowedPath([root], outside, 'projeto'), /nao permitido/)
  assert.throws(() => asAllowedPath([root], path.join(root, '..', 'fora'), 'projeto'), /nao permitido/)
  assert.throws(() => asAllowedPath([root], { a: 1 }, 'projeto'), /invalido/)
})

test('safeJoin bloqueia .., caminho absoluto e link para fora; permite arquivo interno e novo', () => {
  assert.equal(safeJoin(root, 'ok.md'), path.join(root, 'ok.md'))
  assert.equal(safeJoin(root, 'novo.md'), path.join(root, 'novo.md')) // arquivo ainda inexistente
  assert.throws(() => safeJoin(root, '../fora/segredo.md'), /fora do jogo/)
  assert.throws(() => safeJoin(root, path.join(outside, 'segredo.md')), /fora do jogo/)
  assert.throws(() => safeJoin(root, 'sub/../../fora/segredo.md'), /fora do jogo/)
  try { // junction (Windows) ou symlink apontando para fora da pasta do jogo
    fs.symlinkSync(outside, path.join(root, 'atalho'), 'junction')
  } catch { return }
  assert.throws(() => safeJoin(root, 'atalho/segredo.md'), /fora do jogo/)
  assert.throws(() => safeJoin(root, 'atalho/novo.md'), /fora do jogo/)
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('grupos de projetos: nome obrigatorio, cor valida, projeto em um grupo so', () => {
  const g = cleanGroups([{ id: 'a b!', name: '  Trabalho ', color: 'red', games: ['C:/x', 'c:/X', 5], open: 1 }, { name: 'Jogos', color: '#C6A2FF', games: ['C:/x', 'D:/y'] }])
  assert.deepEqual(g.map(x => [x.id.length > 0, x.name, x.color, x.games, x.open]), [[true, 'Trabalho', '#7cc4ff', ['C:/x'], true], [true, 'Jogos', '#C6A2FF', ['D:/y'], false]])
  assert.equal(g[0].id, 'ab')
  assert.throws(() => cleanGroups([{ name: ' ' }]), /sem nome/)
  assert.throws(() => cleanGroups('x'), /invalidos/)
})

test('Godot é opt-in por organizador e configuração inválida não habilita ferramentas', () => {
  const base = { id: 'jogos', name: 'Jogos', games: ['C:/projects/game'] }
  assert.equal(cleanGroups([base])[0].godot, undefined)
  assert.deepEqual(cleanGroups([{ ...base, godot: { enabled: true, executable: ' godot ' } }])[0].godot, { enabled: true, executable: 'godot' })
  assert.deepEqual(cleanGroups([{ ...base, godot: { enabled: false, executable: '' } }])[0].godot, { enabled: false, executable: '' })
  for (const godot of [true, [], { enabled: 'true', executable: '' }, { enabled: true, executable: 4 }, { enabled: true, executable: 'godot\n--other' }]) assert.throws(() => cleanGroups([{ ...base, godot }]), /Godot inválida/)
})

test('arquivos do commit: relativos e dentro da pasta', () => {
  assert.equal(commitPaths(undefined), undefined)
  assert.equal(commitPaths([]), undefined)
  assert.deepEqual(commitPaths(['src/a.ts', 'b c.txt']), ['src/a.ts', 'b c.txt'])
  for (const bad of [['../x'], ['C:/x'], ['/etc/x'], [''], [1], 'a'] as unknown[]) assert.throws(() => commitPaths(bad))
  assert.throws(() => commitPaths(Array.from({ length: 300 }, (_, i) => 'x'.repeat(90) + i)), /demais/)
})

test('Nova de uma pasta: so ela vai ao modelo', () => {
  const gs = ['C:/p/Jogo', 'C:/p/Site']
  assert.deepEqual(scopeTo(gs), gs)
  assert.deepEqual(scopeTo(gs, 'c:/P/jogo'), ['C:/p/Jogo'])
  assert.throws(() => scopeTo(gs, 'C:/outra'), /fora da lista/)
  assert.deepEqual(scopeTo(gs, 'C:/outra', true), [])
})

test('trechos do commit: caminho seguro e cabecalhos de hunk', () => {
  assert.equal(commitParts(undefined), undefined)
  assert.deepEqual(commitParts([{ path: 'a.ts', skip: ['@@ -1 +1 @@'] }]), [{ path: 'a.ts', skip: ['@@ -1 +1 @@'] }])
  for (const bad of [[{ path: '../a', skip: ['@@ -1 +1 @@'] }], [{ path: 'a', skip: [] }], [{ path: 'a', skip: ['rm -rf'] }], [{ path: 'a' }], 'x'] as unknown[])
    assert.throws(() => commitParts(bad))
})

test('samePath: link/junction e a pasta real sao a mesma pasta; pastas diferentes nao', () => {
  const link = path.join(tmp, 'atalho')
  fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(samePath(link, root))
  assert.ok(samePath(path.join(root, '.'), root))
  assert.ok(!samePath(root, outside))
})

// Caixa de caminho segue o sistema de arquivos padrao: ignora no Windows/macOS, respeita no Linux.
test('caminhos sem caixa no Windows/macOS', { skip: process.platform === 'linux' }, () => {
  assert.equal(pathKey(root.toUpperCase()), pathKey(root))
  assert.ok(inside(root, path.join(root.toUpperCase(), 'x')))
  assert.equal(asAllowedPath([root], root.toUpperCase(), 'projeto'), root)
})
test('Linux: pasta com outra caixa e outra pasta (inside, asAllowedPath, samePath, pickGames)', { skip: process.platform !== 'linux' }, () => {
  assert.equal(pathKey('/home/u/Jogo'), '/home/u/Jogo')
  assert.ok(inside('/home/u/Jogo', '/home/u/Jogo/a.txt'))
  assert.ok(!inside('/home/u/Jogo', '/home/u/jogo/a.txt')) // irma com outra caixa nao esta dentro
  assert.throws(() => asAllowedPath([root], root.toUpperCase(), 'projeto'), /nao permitido/)
  const upper = path.join(tmp, 'JOGO'); fs.mkdirSync(upper)
  assert.ok(!samePath(root, upper))
  assert.deepEqual(pickGames({ docs: '/home/u/Documents', appPath: '/x', isDir: () => true, projects: ['/home/u/documents/Jogo', '/home/u/Documents/Jogo'], extra: [] }), ['/home/u/Documents/Jogo'])
  assert.throws(() => safeJoin(root, path.join(upper, 'x')), /fora do jogo/)
})
