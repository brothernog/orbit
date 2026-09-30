import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { startRun, finishRun, reconcileRuns } from './runs.ts'
import { addStep, beginStep, bindStep, getStep, listSteps, reviewStep, reconcileSteps } from './workflows.ts'
test('etapas: sequenciamento, execução real observada, aceite humano, rejeição e reinício', () => {
  const db = new DatabaseSync(':memory:'); migrate(db)
  const t = createTask(db, 'C:/game'), other = createTask(db, 'C:/other')
  const a = addStep(db, t, 'Investigar', 'Leia o código'), b = addStep(db, t, 'Implementar', 'Faça o ajuste')
  assert.throws(() => beginStep(db, t, b), /anteriores/)
  assert.throws(() => beginStep(db, other, a), /pertence/)
  beginStep(db,t,a); assert.throws(() => beginStep(db,t,a), /execução/)
  const run = startRun(db,{taskId:t,provider:'fake'},'Leia o código')
  bindStep(db,a,{status:'started',runId:run})
  finishRun(db,run,{status:'completed',text:'feito',notes:[]})
  assert.equal(listSteps(db,t)[0].state,'review')
  assert.throws(() => beginStep(db,t,b),/anteriores/)
  reviewStep(db,a,false); assert.equal(getStep(db,a)?.state,'pending')
  beginStep(db,t,a)
  const run2 = startRun(db,{taskId:t,provider:'fake'},'Leia o código')
  finishRun(db,run2,{status:'completed',text:'feito',notes:[]})
  bindStep(db,a,{status:'started',runId:run2}); reviewStep(db,a,true)
  beginStep(db,t,b)
  const run3 = startRun(db,{taskId:t,provider:'fake'},'Faça o ajuste')
  bindStep(db,b,{status:'started',runId:run3}); reconcileRuns(db); reconcileSteps(db,true)
  assert.equal(getStep(db,b)?.state,'failed')
  beginStep(db,t,b); reconcileSteps(db,true); assert.equal(getStep(db,b)?.state,'failed')
  assert.throws(() => reviewStep(db,b,true),/concluída/)
  db.close()
})

test('etapas: consentimento cancelado/expirado não deixa reserva ativa', () => {
  const db=new DatabaseSync(':memory:');migrate(db);const t=createTask(db,'C:/game'),id=addStep(db,t,'Implementar','Faça o ajuste')
  const send=Number(db.prepare('INSERT INTO pending_sends(task_id,text,sel) VALUES (?,?,?)').run(t,'Faça o ajuste','{}').lastInsertRowid)
  beginStep(db,t,id);bindStep(db,id,{status:'awaiting_context_approval',sendId:send})
  assert.equal(getStep(db,id)?.state,'awaiting_context')
  db.prepare("UPDATE pending_sends SET state='cancelled' WHERE id=?").run(send)
  reconcileSteps(db);assert.equal(getStep(db,id)?.state,'cancelled')
  beginStep(db,t,id);db.prepare("UPDATE pending_sends SET state='awaiting_context_approval' WHERE id=?").run(send);bindStep(db,id,{status:'awaiting_context_approval',sendId:send})
  db.prepare("UPDATE pending_sends SET state='sent' WHERE id=?").run(send);reconcileSteps(db,true)
  assert.equal(getStep(db,id)?.state,'failed');db.close()
})
