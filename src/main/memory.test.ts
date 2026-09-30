// Memoria por tarefa com banco e arquivos sinteticos. Nenhuma chamada paga.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { addMemory, fileEvidence, getMemory, searchMemory, setTodoState, todoReady, validate, type MemoryInput } from './memory.ts'
import { createTask } from './tasks.ts'
import { listArtifacts, readArtifact, saveArtifact } from './artifacts.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-mem-'))
const ws = path.join(tmp, 'proj')
fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 1\n')
const db = openDb(path.join(tmp, 't.db'))
const T1 = createTask(db, ws, 'um'), T2 = createTask(db, ws, 'dois') // mesma pasta, tarefas distintas
const L = 'chat:1:codex:'
const mk = (o: Partial<MemoryInput> = {}): MemoryInput => ({ taskId: T1, owner: 'run', lineage: L, kind: 'finding', title: 'Achado A', content: 'O parser ignora linhas vazias.', ...o })

test('validacao de entrada e deduplicacao por conteudo + origem + escopo', () => {
  for (const bad of [{ kind: 'x' }, { title: '' }, { content: '' }, { content: 'x'.repeat(4001) }, { paths: Array(21).fill('a') }, { todoState: 'open' }, { deps: [999] }])
    assert.throws(() => addMemory(db, mk(bad)), Error)
  const a = addMemory(db, mk({ paths: ['src'] }))
  const again = addMemory(db, mk({ paths: ['src'] }))
  assert.deepEqual([again.deduped, again.id], [true, a.id])
  assert.equal(addMemory(db, mk({ paths: ['docs'] })).deduped, false) // escopo diferente
  assert.equal(addMemory(db, mk({ lineage: 'del:5' })).deduped, false) // origem diferente
})

test('fatos conflitantes ficam sinalizados e nada e sobrescrito em silencio', () => {
  const a = addMemory(db, mk({ kind: 'decision', title: 'Formato', content: 'Usar JSON.' }))
  const b = addMemory(db, mk({ kind: 'decision', title: 'formato', content: 'Usar YAML.' }))
  assert.equal(b.conflictWith, a.id)
  assert.equal(getMemory(db, T1, a.id)!.state, 'active') // o original continua ativo
  assert.equal(getMemory(db, T1, b.id)!.conflict_with, a.id)
})

test('revisao explicita preserva proveniencia; checkpoint vigente e um por linhagem; alheio nao e substituido', () => {
  const a = addMemory(db, mk({ title: 'R', content: 'v1' }))
  const b = addMemory(db, mk({ title: 'R', content: 'v2', supersedes: a.id }))
  assert.equal(b.revision, 2)
  assert.equal(getMemory(db, T1, a.id)!.state, 'superseded')
  assert.equal(getMemory(db, T1, b.id)!.supersedes, a.id)
  assert.throws(() => addMemory(db, mk({ lineage: 'del:9', title: 'R', content: 'v3', supersedes: b.id })), /propria linhagem/)
  const c1 = addMemory(db, mk({ kind: 'checkpoint', title: 'cp', content: 'estado 1', lineage: 'del:2' }))
  const c2 = addMemory(db, mk({ kind: 'checkpoint', title: 'cp', content: 'estado 2', lineage: 'del:2' }))
  assert.equal(getMemory(db, T1, c1.id)!.state, 'superseded')
  assert.equal(c2.revision, 2)
})

test('todo tem estado e dependencias; so fica pronto quando as dependencias terminam', () => {
  const t1 = addMemory(db, mk({ kind: 'todo', title: 'passo 1', content: 'ler', todoState: 'open' }))
  const t2 = addMemory(db, mk({ kind: 'todo', title: 'passo 2', content: 'editar', deps: [t1.id] }))
  assert.equal(todoReady(db, getMemory(db, T1, t2.id)!), false)
  setTodoState(db, T1, t1.id, 'done')
  assert.equal(todoReady(db, getMemory(db, T1, t2.id)!), true)
  assert.throws(() => setTodoState(db, T1, t1.id, 'x'), /invalido/)
  assert.throws(() => addMemory(db, { ...mk({ kind: 'todo', title: 'x', content: 'y', deps: [t1.id] }), taskId: T2 }), /nao existe nesta tarefa/) // dependencia de outra tarefa
})

test('evidencia por hash: mudar o arquivo invalida; tamanho igual com conteudo diferente tambem; sem evidencia = desconhecido', () => {
  const evidence = { files: fileEvidence(ws, ['src/a.ts']) }
  assert.equal(evidence.files[0].path, 'src/a.ts')
  const id = addMemory(db, mk({ title: 'Ev', content: 'depende de a.ts', evidence })).id
  assert.equal(validate(db, getMemory(db, T1, id)!, ws).validity, 'valid')
  const noEv = addMemory(db, mk({ title: 'SemEv', content: 'sem dependencias declaradas' })).id
  assert.equal(validate(db, getMemory(db, T1, noEv)!, ws).validity, 'unknown') // ausencia de evidencia nao e validade
  fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 2\n') // mesmo tamanho, outro conteudo
  const v = validate(db, getMemory(db, T1, id)!, ws)
  assert.deepEqual([v.validity, v.changed], ['stale', ['src/a.ts']])
  assert.equal(getMemory(db, T1, id)!.state, 'stale') // persistido
  fs.rmSync(path.join(ws, 'src', 'a.ts'))
  assert.equal(validate(db, getMemory(db, T1, id)!, ws).validity, 'stale') // arquivo removido nao confirma nada
  assert.throws(() => fileEvidence(ws, ['../fora']), /fora da area/)
  assert.throws(() => fileEvidence(ws, ['src']), /precisa ser um arquivo/)
})

test('busca por tipo, caminho e texto normalizado, ordem estavel e paginada; tarefas isoladas', () => {
  const t = createTask(db, ws, 'busca')
  const add = (title: string, content: string, paths: string[] = [], kind = 'finding') => addMemory(db, { taskId: t, owner: 'run', lineage: 'x', kind, title, content, paths }).id
  const i1 = add('Ação de pulo', 'jogador pula duas vezes', ['src/player'])
  const i2 = add('Colisão', 'raycast falha na quina', ['src/player/collision.ts'])
  add('Menu', 'botao sem foco', ['src/ui'], 'decision')
  assert.deepEqual(searchMemory(db, { taskId: t, text: 'acao PULO' }).items.map(i => i.id), [i1]) // sem acento, sem caixa
  assert.deepEqual(searchMemory(db, { taskId: t, path: 'src/player' }).items.map(i => i.id), [i1, i2])
  assert.deepEqual(searchMemory(db, { taskId: t, path: 'src/player/collision.ts' }).items.map(i => i.id), [i1, i2]) // escopo pai cobre o arquivo
  assert.equal(searchMemory(db, { taskId: t, kind: 'decision' }).items.length, 1)
  const p1 = searchMemory(db, { taskId: t, limit: 2 })
  assert.equal(p1.items.length, 2); assert.ok(p1.next)
  const p2 = searchMemory(db, { taskId: t, limit: 2, afterId: p1.next! })
  assert.equal(p2.items.length, 1); assert.equal(p2.next, null)
  assert.equal(searchMemory(db, { taskId: t, lineages: ['outro'] }).items.length, 0) // linhagem sem itens
  assert.equal(searchMemory(db, { taskId: T2 }).items.length, 0) // outra tarefa nunca aparece, mesma pasta
  assert.equal(searchMemory(db, { taskId: t, text: "x' OR 1=1 --" }).items.length, 0) // texto e parametro, nao SQL
})

test('artefatos: guardados uma vez, leitura paginada, so tarefa e leitores autorizados (o produtor nao le por ser produtor)', () => {
  const big = 'linha\n'.repeat(1000)
  const a = saveArtifact(db, { taskId: T1, producer: 'del:1', readers: ['g:leitor'], kind: 'delegation', content: big })
  const dup = saveArtifact(db, { taskId: T1, producer: 'del:1', readers: ['g:outro'], kind: 'delegation', content: big })
  assert.deepEqual([dup.id, dup.reused], [a.id, true])
  const p1 = readArtifact(db, { taskId: T1, reader: 'g:leitor', id: a.id, limit: 100 })!
  assert.deepEqual([p1.content.length, p1.next, p1.size], [100, 100, 6000])
  assert.equal(readArtifact(db, { taskId: T1, reader: 'g:leitor', id: a.id, offset: 5950, limit: 100 })!.next, null) // ultima pagina
  assert.equal(readArtifact(db, { taskId: T1, reader: 'del:2', id: a.id, limit: 10 }), null) // outro leitor
  assert.equal(readArtifact(db, { taskId: T1, reader: 'del:1', id: a.id, limit: 10 }), null) // o nome do produtor nao concede leitura
  assert.equal(readArtifact(db, { taskId: T2, reader: 'g:leitor', id: a.id, limit: 10 }), null) // outra tarefa
  assert.equal(listArtifacts(db, T1, 'del:2').length, 0)
  assert.equal(listArtifacts(db, T1, 'g:outro')[0].size, 6000) // leitor acrescentado pelo reaproveitamento
})

test('validacao em lote: a mesma evidencia e lida e hasheada uma vez por passada; o hash continua obrigatorio', t => {
  fs.writeFileSync(path.join(ws, 'src', 'lote.ts'), 'export const lote = 1\n')
  const ev = { files: fileEvidence(ws, ['src/lote.ts']) }
  const T = createTask(db, ws, 'lote')
  const ids = Array.from({ length: 30 }, (_, i) => addMemory(db, mk({ taskId: T, title: `Item ${i}`, content: `conteudo ${i}`, evidence: ev })).id)
  const reads = t.mock.method(fs, 'readFileSync')
  const seen = new Map()
  assert.ok(ids.every(id => validate(db, getMemory(db, T, id)!, ws, seen).validity === 'valid'))
  assert.equal(reads.mock.calls.length, 1)
  // Mesmo tamanho, conteudo diferente: so o hash revela; uma passada nova le de novo (nada vale entre chamadas).
  fs.writeFileSync(path.join(ws, 'src', 'lote.ts'), 'export const lote = 2\n')
  const fresh = new Map()
  assert.ok(ids.every(id => validate(db, getMemory(db, T, id)!, ws, fresh).validity === 'stale'))
  assert.equal(reads.mock.calls.length, 2)
})
