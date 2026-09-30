import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDoc, editDoc } from './docs.ts'

test('docs: criar so arquivo novo; editar exige o texto lido e recusa mudanca concorrente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'))
  try {
    const file = path.join(root, 'ROADMAP.md')
    createDoc(root, 'ROADMAP.md', '- [ ] a\n')
    assert.equal(fs.readFileSync(file, 'utf8'), '- [ ] a\n')
    assert.throws(() => createDoc(root, 'ROADMAP.md', 'outro'), /EEXIST/) // criar nao sobrescreve
    assert.equal(fs.readFileSync(file, 'utf8'), '- [ ] a\n')

    editDoc(root, 'ROADMAP.md', '- [ ] a\n', '- [x] a\n') // marcar item de um arquivo existente
    assert.equal(fs.readFileSync(file, 'utf8'), '- [x] a\n')

    fs.writeFileSync(file, '- [x] a\n- [ ] b\n') // outro editor mudou o arquivo
    assert.throws(() => editDoc(root, 'ROADMAP.md', '- [x] a\n', '- [ ] a\n'), /mudou/)
    assert.equal(fs.readFileSync(file, 'utf8'), '- [x] a\n- [ ] b\n')

    assert.throws(() => editDoc(root, 'nada.md', '', 'x'), /ENOENT/) // editar nao cria
    assert.throws(() => createDoc(root, 'x.exe', 'oi'), /\.md/)
    assert.throws(() => createDoc(root, '../fora.md', 'oi'), /fora/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
