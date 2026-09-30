import { createTask, deleteTask } from './tasks.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { todoBoard, saveTodo, todoTask } from './planning.ts'
test('to-do: importação única, revisão, validação e tarefa idempotente sem inferência', () => {
  const db = new DatabaseSync(':memory:'); migrate(db)
  const topics = [{ id: 't', title: 'Jogo', open: true, items: [{ id: 'i', text: 'Corrigir pulo', done: false, images: [], project: 'C:/game', agent: 'codex' }] }]
  const a = todoBoard(db, topics)
  assert.deepEqual(todoBoard(db, []), a)
  assert.throws(() => saveTodo(db, 99, topics), /outra tela/)
  assert.throws(() => saveTodo(db, 0, [{ ...topics[0], items: [...topics[0].items, topics[0].items[0]] }]), /repetido/)
  assert.throws(() => saveTodo(db, 0, [{ ...topics[0], items: [{ ...topics[0].items[0], images: ['file:///secret'] }] }]), /imagens/)
  assert.throws(() => todoTask(db, 't', 'i', 'C:/other'), /projeto/)
  const first = todoTask(db, 't', 'i', 'C:/game'), again = todoTask(db, 't', 'i', 'C:/game')
  assert.equal(first.created, true); assert.equal(again.created, false); assert.equal(first.taskId, again.taskId)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 1)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n, 0)
  assert.throws(() => saveTodo(db, 0, topics), /outra tela/)
  assert.throws(() => saveTodo(db, again.board.revision, topics), /vínculo/)
  const done = structuredClone(again.board.topics); done[0].items[0].done = true
  saveTodo(db, again.board.revision, done)
  assert.throws(() => todoTask(db, 't', 'i', 'C:/game'), /concluído/)
  db.close()
})

test('to-do: preserva anexos legados acima do limite do chat e impede apagar o último tópico',()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const topics=[{id:'t',title:'Entrada',open:true,items:[{id:'i',text:'Referências',done:false,images:Array(7).fill('data:image/png;base64,YQ==')}]}]
  assert.equal(todoBoard(db,topics).topics[0].items[0].images.length,7)
  assert.throws(()=>saveTodo(db,0,[]),/ao menos/);db.close()
})

test('to-do: exclusão limpa o vínculo mesmo quando SQLite reutiliza o ID',()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const topics=[{id:'t',title:'Entrada',open:true,items:[{id:'i',text:'Corrigir pulo',done:false,images:[],project:'C:/game'}]}]
  todoBoard(db,topics);const first=todoTask(db,'t','i','C:/game')
  deleteTask(db,first.taskId);assert.equal(todoBoard(db).topics[0].items[0].taskId,undefined)
  const reused=createTask(db,'C:/game','Outra tarefa');assert.equal(reused,first.taskId)
  const next=todoTask(db,'t','i','C:/game');assert.equal(next.created,true);assert.notEqual(next.taskId,reused)
  db.close()
})
