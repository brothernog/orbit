import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { markPublished, parseProfile, readDesk, weekStart } from './linkedin.ts'
import { createLinkedInService } from './linkedinService.ts'

test('linkedin: perfil vira objetivo, meta semanal e historico; linhas fora do formato sao ignoradas', () => {
  const p = parseProfile('Objetivo: audiencia para os jogos\nFrequencia: 2 posts por semana\n## Historico\n- 2026-09-28 | post | Demo nova | Publicado\n- sem data | x | y | z\n- 2026-09-20 | video | Trailer | rejeitado | longo demais')
  assert.equal(p.goal, 'audiencia para os jogos')
  assert.equal(p.perWeek, 2)
  assert.deepEqual(p.history, [{ date: '2026-09-28', kind: 'post', topic: 'Demo nova', status: 'publicado' }, { date: '2026-09-20', kind: 'video', topic: 'Trailer', status: 'rejeitado' }])
  assert.deepEqual(parseProfile('Objetivo: (emprego | clientes)\nFrequencia: (ex.: 2)'), { goal: null, perWeek: null, history: [] }) // modelo ainda nao preenchido
})

test('linkedin: semana comeca na segunda', () => {
  assert.equal(weekStart(new Date(2026, 8, 29)), '2026-09-28') // terca
  assert.equal(weekStart(new Date(2026, 9, 4)), '2026-09-28') // domingo
})

test('linkedin: publicar tira o rascunho da mesa e registra no historico; nome com caminho e recusado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-'))
  fs.mkdirSync(path.join(dir, 'rascunhos'))
  fs.writeFileSync(path.join(dir, 'rascunhos', 'a.md'), '\n# Três anos fazendo | jogos\n\ncorpo')
  assert.equal(readDesk(dir).drafts.length, 1)
  markPublished(dir, 'a.md', new Date(2026, 8, 29))
  const d = readDesk(dir)
  assert.equal(d.drafts.length, 0)
  assert.deepEqual(d.history, [{ date: '2026-09-29', kind: 'post', topic: 'Três anos fazendo  jogos', status: 'publicado' }])
  for (const bad of ['../perfil.md', 'publicados/a.md', 'x.txt', 'nao-existe.md']) assert.throws(() => markPublished(dir, bad))
})

test('linkedin: sem keyring (Linux basic_text) a chave nao e salva', async () => {
  const saved: string[] = []
  const vault = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
  const li = createLinkedInService({ getSetting: () => undefined, setSetting: (k: string) => saved.push(k), safeStorage: vault, openExternal: () => assert.fail('nao deveria abrir o navegador'), linkedinDir: os.tmpdir() })
  await assert.rejects(li.liConnect('id', 'segredo'), /cofre/)
  assert.deepEqual(saved, [])
})
