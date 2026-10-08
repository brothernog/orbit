import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileWindow, relativeActivityPath } from './orbitFiles.ts'

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-files-')))
const root = path.join(temporary, 'project'), outside = path.join(temporary, 'outside')
fs.mkdirSync(root); fs.mkdirSync(outside)
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }))

test('prévia limita a janela, centra a linha conhecida e lê novamente após uma gravação', async () => {
  const file = path.join(root, 'source.ts')
  fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => `linha ${i + 1}`).join('\r\n'))
  const window = await readFileWindow(root, file, 200)
  assert.equal(window.path, 'source.ts')
  assert.equal(window.kind, 'text')
  assert.equal(window.startLine, 140)
  assert.equal(window.totalLines, 300)
  assert.equal(window.lines.length, 120)
  assert.equal(window.lines[60], 'linha 200')
  assert.ok(window.size! > 0 && window.modifiedAt! > 0)
  const last = await readFileWindow(root, 'source.ts', 10_000)
  assert.equal(last.startLine, 181)
  assert.equal(last.lines.at(-1), 'linha 300')
  fs.writeFileSync(file, 'atualizado\n')
  assert.deepEqual((await readFileWindow(root, './source.ts')).lines, ['atualizado', ''])
})

test('prévia corta linhas extensas e informa arquivos grandes ou binários sem total inventado', async () => {
  fs.writeFileSync(path.join(root, 'long.txt'), 'x'.repeat(3000))
  const long = await readFileWindow(root, 'long.txt')
  assert.equal(long.lines[0].length, 2000)
  assert.ok(long.lines[0].endsWith('…'))
  fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat((1 << 20) + 1))
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([65, 0, 66]))
  fs.writeFileSync(path.join(root, 'invalid.dat'), Buffer.from([0xff, 0xfe]))
  for (const [file, kind] of [['large.txt', 'large'], ['binary.dat', 'binary'], ['invalid.dat', 'binary']]) {
    const preview = await readFileWindow(root, file)
    assert.equal(preview.kind, kind)
    assert.equal(preview.totalLines, undefined)
    assert.deepEqual(preview.lines, [])
  }
})

test('imagem retorna metadados sem conteúdo; arquivo removido continua com caminho válido', async () => {
  fs.writeFileSync(path.join(root, 'photo.PNG'), Buffer.alloc((1 << 20) + 1))
  const image = await readFileWindow(root, 'photo.PNG')
  assert.equal(image.kind, 'image')
  assert.equal(image.size, (1 << 20) + 1)
  assert.deepEqual(image.lines, [])
  assert.equal(image.totalLines, undefined)
  assert.deepEqual(await readFileWindow(root, 'deleted.txt'), { path: 'deleted.txt', kind: 'missing', startLine: 1, lines: [] })
  fs.mkdirSync(path.join(root, 'directory'))
  await assert.rejects(readFileWindow(root, 'directory'), /arquivo/)
})

test('prévia valida linha e impede caminhos externos, ignorados, streams e argumentos inválidos', async () => {
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'x')
  for (const file of ['../outside/secret.txt', path.join(outside, 'secret.txt'), 'node_modules/ignored.js', '.git/config', '.GIT/config', 'source.ts:stream', '', 'source.ts\0', 2, null]) {
    assert.equal(relativeActivityPath(root, file), undefined)
    await assert.rejects(readFileWindow(root, file))
  }
  assert.equal(relativeActivityPath(root, path.join(root, 'deleted.txt')), 'deleted.txt')
  for (const line of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}, null]) await assert.rejects(readFileWindow(root, 'deleted.txt', line), /Linha/)
})

test('prévia bloqueia escapes por junction/symlink e normaliza links internos', async t => {
  const escape = path.join(root, 'escape'), internal = path.join(root, 'internal')
  fs.mkdirSync(path.join(root, 'internal-files'))
  try {
    fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(path.join(root, 'internal-files'), internal, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (e) {
    if (!['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
    t.skip('O ambiente não permite criar junctions/symlinks.'); return
  }
  for (const file of ['escape/secret.txt', 'escape/new/deleted.txt']) {
    assert.equal(relativeActivityPath(root, file), undefined)
    await assert.rejects(readFileWindow(root, file), /fora do jogo/)
  }
  assert.equal(relativeActivityPath(root, 'internal/new.txt'), 'internal-files/new.txt')
  assert.equal((await readFileWindow(root, 'internal/new.txt')).path, 'internal-files/new.txt')
})
