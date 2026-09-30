import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attachImages, imagesIn, readImage } from './attachments.ts'
import { AGENTS } from './adapters.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-att-'))
const png = 'data:image/png;base64,' + Buffer.from('\x89PNG fake').toString('base64')

test('imagem colada vira arquivo na pasta de anexos e marcador no texto; repetir nao duplica', () => {
  const dir = path.join(root, '7')
  const text = attachImages(dir, 'olha isso', [png, png])
  const imgs = imagesIn(text, root)
  assert.equal(imgs.length, 1)
  assert.ok(imgs[0].startsWith(dir) && fs.existsSync(imgs[0]))
  assert.match(text, /^olha isso\n\[imagem anexada: /)
  assert.equal(attachImages(dir, 'so texto', undefined), 'so texto')
})

test('entrada invalida e marcador apontando para fora da pasta sao recusados', () => {
  assert.throws(() => attachImages(root, 'x', ['data:text/html;base64,PGI+']), /invalida/)
  assert.throws(() => attachImages(root, 'x', Array(7).fill(png)), /No maximo/)
  const fora = path.join(os.tmpdir(), 'fora.png'); fs.writeFileSync(fora, 'x')
  assert.deepEqual(imagesIn(`[imagem anexada: ${fora}]`, root), [])
})

test('cada CLI recebe a imagem do seu jeito', () => {
  const f = path.join(root, '7', 'a.jpg'), d = path.dirname(f), images = [f]
  const codex = AGENTS.codex.chatArgs('s1', { images })
  assert.deepEqual(codex.slice(-4), ['resume', 's1', `--image=${f}`, '-']) // `-i a -` engoliria o '-' (conferido no codex 0.147)
  const claude = AGENTS.claude.chatArgs(undefined, { images })
  assert.deepEqual(claude.slice(claude.indexOf('--add-dir'), claude.indexOf('--add-dir') + 2), ['--add-dir', d])
  const oc = AGENTS.opencode.chatArgs(undefined, { images })
  assert.deepEqual(oc.slice(oc.indexOf('-f'), oc.indexOf('-f') + 2), ['-f', f])
  assert.ok(AGENTS.gemini.chatArgs(undefined, { images }).includes('--include-directories'))
  assert.ok(!AGENTS.claude.chatArgs(undefined, {}).includes('--add-dir')) // sem imagem, nada muda
})

test('miniatura do chat so le imagem dentro das pastas da tarefa', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-proj-'))
  fs.mkdirSync(path.join(proj, 'out')); fs.writeFileSync(path.join(proj, 'out', 'g.svg'), '<svg/>'); fs.writeFileSync(path.join(proj, 'a.ts'), 'x')
  assert.match(readImage('out/g.svg', [proj]) ?? '', /^data:image\/svg\+xml;base64,/) // relativo ao projeto
  assert.equal(readImage('a.ts', [proj]), null) // nao e imagem
  fs.writeFileSync(path.join(proj, '..', 'fora.png'), 'x')
  assert.equal(readImage('../fora.png', [proj]), null) // existe, mas fora das pastas
  assert.equal(readImage(path.join(root, '7', 'nao-existe.png'), [proj, root]), null)
})
