import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate } from './db.ts'
import { createPlaytestService } from './playtests.ts'

const image = 'data:image/png;base64,aGVsbG8='
const record = { title: 'Pulo', observed: 'Atravessou a plataforma', scenario: 'Plataforma móvel', expected: 'Pousar sobre ela', outcome: 'fail', notes: 'Sessão humana', images: [image] }
function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-playtests-')), db = new DatabaseSync(':memory:')
  migrate(db)
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { db, dir, service: createPlaytestService(db, dir) }
}

test('playtests: captura persistente, escopo do projeto e estado explícito', t => {
  const { db, dir, service } = setup(t)
  const id = service.add('game', record)
  const rows = createPlaytestService(db, dir).list('game')
  assert.equal(rows.length, 1); assert.equal(rows[0].id, id); assert.equal(rows[0].imageCount, 1)
  assert.equal(rows[0].severity, 'medium'); assert.equal(rows[0].state, 'open')
  assert.equal(rows[0].observed, record.observed); assert.ok(!('images' in rows[0]))
  assert.deepEqual(service.images('game', id), [image]); assert.deepEqual(service.list('other'), [])
  for (const action of [() => service.images('other', id), () => service.setState('other', id, 'resolved'), () => service.createIssue('other', id, 'Fix', 'Corrija o pulo')]) assert.throws(action, /neste projeto/)
  assert.throws(() => service.setState('game', id, 'done'), /Estado/)
  service.setState('game', id, 'resolved'); assert.equal(service.list('game')[0].state, 'resolved')
  service.setState('game', id, 'open'); assert.equal(service.list('game')[0].state, 'open')
})

test('playtests: entradas inválidas não persistem e falha de imagem preserva captura anterior', t => {
  const { db, dir, service } = setup(t)
  const id = service.add('game', record)
  for (const invalid of [null, [], { ...record, title: ' ' }, { ...record, title: 'x'.repeat(201) }, { ...record, observed: '' }, { ...record, observed: 'x'.repeat(8001) },
    { ...record, scenario: 'x'.repeat(4001) }, { ...record, expected: 'x'.repeat(8001) }, { ...record, notes: 'x'.repeat(8001) },
    { ...record, outcome: 'unknown' }, { ...record, severity: 'critical' }, { ...record, images: Array(7).fill(image) },
    { ...record, images: [image, 'file:///secret.png'] }, { ...record, images: ['data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')] }]) {
    assert.throws(() => service.add('game', invalid))
  }
  assert.equal(service.list('game').length, 1)
  assert.deepEqual(service.images('game', id), [image]); assert.equal(fs.readdirSync(path.join(dir, 'playtests')).length, 1)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM pins').get() as any).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n, 0)
})

test('playtests: vínculo idempotente recebe somente a ordem digitada, sem copiar histórico e evidências', t => {
  const { db, service } = setup(t), id = service.add('game', record)
  assert.throws(() => service.createIssue('game', id, ' ', 'corrija'), /obrigatório/)
  assert.throws(() => service.createIssue('game', id, 'Corrigir colisão', ''), /obrigatório/)
  const pin = service.createIssue('game', id, 'Corrigir colisão', 'Reveja o código de colisão do personagem.')
  assert.equal(service.createIssue('game', id, 'Outra ordem', 'Não deve duplicar'), pin)
  const issue = db.prepare('SELECT * FROM pins WHERE id=?').get(pin) as any
  assert.equal(issue.title, 'Corrigir colisão'); assert.equal(issue.body, 'Reveja o código de colisão do personagem.')
  for (const value of [record.observed, record.scenario, record.expected, record.notes, image, '[imagem anexada:']) assert.ok(!issue.body.includes(value))
  assert.equal(service.list('game')[0].pin_id, pin)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM pins').get() as any).n, 1)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as any).n, 0)
  // Um problema removido não impede criar outro; um vínculo a outro projeto jamais é reaproveitado.
  db.prepare('UPDATE pins SET game=? WHERE id=?').run('other', pin)
  const next = service.createIssue('game', id, 'Nova ordem', 'Corrija a colisão.')
  assert.notEqual(next, pin); assert.equal(service.list('game')[0].pin_id, next)
})

test('playtests: build deve existir no mesmo projeto, sem ler arquivos ou saídas do comando', t => {
  const { db, service } = setup(t)
  assert.throws(() => service.add('game', { ...record, buildId: -1 }), /Build/)
  assert.throws(() => service.add('game', { ...record, buildId: 999 }), /neste projeto/)
  // O serviço valida a identidade de um registro de build, sem executar seu comando.
  const build = Number(db.prepare(`INSERT INTO project_builds (game,title,version,platform,hash,size,file_name,notes,command)
    VALUES ('game','Build humana','0.1','desktop',?,1,'game.zip','','{}')`).run('a'.repeat(64)).lastInsertRowid)
  assert.throws(() => service.add('other', { ...record, buildId: build }), /neste projeto/)
  const id = service.add('game', { ...record, buildId: build, images: [] })
  assert.equal(service.list('game').find(p => p.id === id)?.build_id, build)
})
