import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrbitActivityStore } from './orbitActivity.ts'

test('orbita separa tarefas e agentes, encerra sem perder arquivo e substitui pensamento cumulativo', () => {
  const store = createOrbitActivityStore()
  store.record(1, 'chat:1', 'codex', { kind: 'read', path: 'src/app.ts', line: 20, position: 'reported' })
  store.record(1, 'delegation:1', 'claude', { kind: 'thinking', ref: 't', summary: 'a' })
  store.record(1, 'delegation:1', 'claude', { kind: 'thinking', ref: 't', summary: 'ab' })
  store.record(2, 'chat:2', 'gemini', { kind: 'read', path: 'other.ts' })
  const ended = store.finish(1, 'chat:1', 'codex')
  assert.equal(ended.active, false)
  assert.equal(ended.activity?.line, 20)
  assert.equal(store.snapshot(1).agents.length, 2)
  assert.deepEqual(store.snapshot(1).agents[1].events.map(e => e.summary), ['ab'])
  store.forget(1)
  assert.equal(store.snapshot(1).agents.length, 0)
  assert.equal(store.snapshot(2).agents[0].activity?.path, 'other.ts')
})

test('historico e memoria da orbita sao limitados com corte explicito e eventos repetidos nao crescem', () => {
  const store = createOrbitActivityStore()
  for (let i = 0; i < 110; i++) store.record(1, 'chat:1', 'codex', { kind: 'message', summary: `${i}${'a'.repeat(4000)}` })
  const a = store.snapshot(1).agents[0]
  assert(a.historyTruncated)
  assert(a.events.reduce((n, e) => n + e.summary!.length, 0) <= 128_000)
  store.record(1, 'chat:1', 'codex', { kind: 'read', path: 'same.ts' })
  const count = store.snapshot(1).agents[0].events.length
  store.record(1, 'chat:1', 'codex', { kind: 'read', path: 'same.ts' })
  assert.equal(store.snapshot(1).agents[0].events.length, count)
  for (let i = 0; i < 100; i++) store.record(1, 'chat:1', 'codex', { kind: 'tool', summary: String(i) })
  assert.equal(store.snapshot(1).agents[0].lastFile?.path, 'same.ts')
  assert.deepEqual(store.snapshot(1).agents[0].visited, ['same.ts'])
  for (let i = 2; i < 16; i++) store.record(i, `chat:${i}`, 'codex', { kind: 'tool' })
  assert.equal(store.snapshot(1).agents.length, 0)
})

test('texto exposto completo e paginado sob a tarefa/agente e nao trafega nos snapshots', () => {
  const store = createOrbitActivityStore(), fullText = 'a'.repeat(150_000)
  const a = store.record(1, 'chat:1', 'claude', { kind: 'thinking', ref: 'block', summary: fullText.slice(0, 16_000), truncated: true, fullText })
  assert(!('fullText' in a.activity!))
  const id = a.activity!.textId!
  assert.equal(store.text(2, 'chat:1', id).text, null)
  assert.equal(store.text(1, 'other', id).text, null)
  assert.equal(store.text(1, 'chat:1', id).next, 64_000)
  assert.equal(store.text(1, 'chat:1', id, 128_000).text?.length, 22_000)
  assert.equal(store.text(1, 'chat:1', id, 128_000).next, null)
  store.record(1, 'chat:1', 'claude', { kind: 'thinking', ref: 'block', summary: 'new', truncated: true, fullText: 'new complete' })
  assert.equal(store.snapshot(1).agents[0].activity!.textId, id)
  assert.equal(store.text(1, 'chat:1', id).text, 'new complete')
  store.forget(1)
  assert.equal(store.text(1, 'chat:1', id).text, null)
})

test('mensagens nativas usam a perspectiva da aba do filho e pensamento nao vira mensagem', () => {
  const store = createOrbitActivityStore()
  assert.equal(store.record(1, 'native', 'codex', { kind: 'message', agent: 'child', direction: 'sent' }).activity?.direction, 'received')
  assert.equal(store.record(1, 'native', 'claude', { kind: 'message', agent: 'child', direction: 'received' }).activity?.direction, 'sent')
  assert.equal(store.record(1, 'native', 'claude', { kind: 'thinking', agent: 'child', direction: 'received' }).activity?.direction, undefined)
  store.record(1, 'native', 'claude', { kind: 'message', ref: 'partial', summary: 'a' })
  store.record(1, 'native', 'claude', { kind: 'message', ref: 'partial', summary: 'ab' })
  assert.equal(store.snapshot(1).agents[0].events.filter(e => e.ref === 'partial').length, 1)
})
