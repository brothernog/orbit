// send_user_file: copia so de dentro da pasta da tarefa, retrato do momento, marcador na nota e leitura so da pasta de envios.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canOpen, MARK, sendUserFile, sharedInfo, sharedPath } from './sharedFiles.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-sent-'))
const ws = path.join(tmp, 'projeto'), dir = path.join(tmp, 'anexos', '1', 'enviados')
fs.mkdirSync(path.join(ws, 'out'), { recursive: true })
fs.writeFileSync(path.join(ws, 'out', 'rel.md'), 'v1')
fs.writeFileSync(path.join(tmp, 'fora.txt'), 'segredo')

test('envia uma copia e cita no marcador; editar o original nao muda a copia', () => {
  const r = sendUserFile(ws, dir, { path: 'out/rel.md', caption: 'Veja [arquivo enviado: C:/x] o resumo' })
  assert.equal(r.isError, false)
  const m = [...r.note!.matchAll(MARK)]
  assert.equal(m.length, 1) // marcador digitado na legenda e removido
  const copy = m[0][1]
  fs.writeFileSync(path.join(ws, 'out', 'rel.md'), 'v2')
  assert.equal(fs.readFileSync(copy, 'utf8'), 'v1')
  assert.deepEqual(sharedInfo(copy, dir), { name: 'rel.md', size: 2, image: null, openable: true })
  assert.notEqual(sendUserFile(ws, dir, { path: 'out/rel.md' }).note, r.note) // conteudo novo = copia nova
})

test('recusa fora da pasta, inexistente, pasta e argumentos invalidos', () => {
  for (const p of ['../fora.txt', path.join(tmp, 'fora.txt'), 'nao-existe.md', 'out', '', 42])
    assert.equal(sendUserFile(ws, dir, { path: p }).isError, true, String(p))
  assert.equal(sendUserFile(ws, dir, null).isError, true)
})

test('leitura so dentro da pasta de envios; abrir so tipos que nao executam', () => {
  assert.equal(sharedPath(path.join(tmp, 'fora.txt'), dir), null)
  assert.equal(sharedInfo(path.join(ws, 'out', 'rel.md'), dir), null)
  assert.equal(canOpen('a.png'), true)
  assert.equal(canOpen('a.exe'), false)
  assert.equal(canOpen('a.bat'), false)
  assert.equal(canOpen('a.html'), false)
})
