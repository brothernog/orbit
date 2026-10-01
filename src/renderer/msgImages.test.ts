import test from 'node:test'
import assert from 'node:assert/strict'
import { fileRefs, imageRefs, sentCaption, stripMarks } from './msgImages.ts'

test('acha anexos e imagens citadas pelo agente, sem enderecos da internet', () => {
  const t = [
    'olha\n[imagem anexada: C:\\dados\\attachments\\7\\ab.jpg]',
    'Salvei em `C:\\Users\\x\\Meu Jogo\\shots\\tela 1.png` e ![grafico](out/chart.svg).',
    'Tambem docs/fluxo.webp, e https://exemplo.com/rastreio.png nao.',
  ].join('\n')
  assert.deepEqual(imageRefs(t), ['C:\\dados\\attachments\\7\\ab.jpg', 'C:\\Users\\x\\Meu Jogo\\shots\\tela 1.png', 'out/chart.svg', 'docs/fluxo.webp'])
  assert.deepEqual(imageRefs('nada de imagem aqui, so a.ts'), [])
})

test('o texto do usuario perde so o marcador', () => {
  assert.equal(stripMarks('olha isso\n[imagem anexada: C:\\a\\b.jpg]'), 'olha isso')
  assert.equal(stripMarks('[imagem anexada: C:\\a\\b.jpg]'), '')
})

test('mensagem do usuario: so os anexos, nao os caminhos que ele citou', () => {
  assert.deepEqual(imageRefs('gere out/teste.svg\n[imagem anexada: C:\\a\\b.jpg]', true), ['C:\\a\\b.jpg'])
  assert.deepEqual(imageRefs('gere um grafico em out/teste.svg', true), [])
})

test('arquivo enviado pelo agente: marcador vira referencia e sai do texto', () => {
  const t = '↳ Arquivo enviado pelo agente: resumo\n[arquivo enviado: C:/dados/attachments/7/enviados/ab/rel.md]\n[arquivo enviado: C:/dados/attachments/7/enviados/ab/rel.md]'
  assert.deepEqual(fileRefs(t), ['C:/dados/attachments/7/enviados/ab/rel.md'])
  assert.equal(stripMarks(t), '↳ Arquivo enviado pelo agente: resumo')
  assert.deepEqual(imageRefs(t, true), []) // nao vira miniatura duplicada
  assert.equal(sentCaption(stripMarks(t)), 'resumo')
  assert.equal(sentCaption('↳ Arquivo enviado pelo agente'), '')
})
