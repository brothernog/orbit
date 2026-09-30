import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { WorkspaceGuard } from './delegation.ts'
import { createCommandService, listCommandRuns, normalizeCommand, projectCommands, reconcileCommands, saveCommands } from './commands.ts'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
test('comandos: persistência, ownership, saída/exit, falha, exclusão mútua, cancelamento e reinício',async()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const game=process.cwd(),t=createTask(db,game),other=createTask(db,game+'/other'),guard=new WorkspaceGuard()
  const command=(name:string,code:string)=>({name,purpose:'test',program:process.execPath,args:['-e',code]})
  assert.throws(()=>normalizeCommand({...command('x',''),program:'cmd.exe'}),/shell/)
  assert.throws(()=>normalizeCommand({...command('x',''),program:' cmd.exe  '}),/shell/)
  assert.throws(()=>normalizeCommand({...command('x',''),args:'echo'}),/inválido/)
  assert.throws(()=>saveCommands(db,game,[command('x',''),command('X','')]),/repetidos/)
  saveCommands(db,game,[command('ok','console.log("feito & literal");console.error("aviso")'),command('bad','process.exit(3)'),command('hang','console.log("aguardando");setInterval(()=>{},1000)'),command('large','process.stdout.write("x".repeat(1000050))'),{...command('missing',''),program:game+'/nao-existe.exe'}])
  assert.equal(projectCommands(db,game).length,5)
  let agents=false;const service=createCommandService(db,guard,()=>agents,()=>{})
  const done=async(id:number)=>{for(let i=0;i<150;i++){const r=listCommandRuns(db,t).find(r=>r.id===id)!;if(r.status!=='running')return r;await sleep(50)}throw Error('timeout')}
  try {
    await assert.rejects(service.start(other,game,game,'ok'),/outro projeto/)
    agents=true;await assert.rejects(service.start(t,game,game,'ok'),/Pare/);agents=false
    const id=await service.start(t,game,game,'ok'),ok=await done(id)
    assert.equal(ok.status,'completed');assert.equal(ok.exit_code,0);assert.match(ok.output,/feito & literal/);assert.match(ok.output,/aviso/);assert.ok(ok.duration_ms!>=0)
    assert.equal((await done(await service.start(t,game,game,'bad'))).exit_code,3)
    assert.equal((await done(await service.start(t,game,game,'missing'))).status,'failed')
    const large=await done(await service.start(t,game,game,'large'));assert.equal(large.truncated,1);assert.equal(large.output.length,1000000)
    const hang=await service.start(t,game,game,'hang')
    assert.ok(service.busy(game));assert.ok(guard.blockedFor(game,other));await assert.rejects(service.start(t,game,game,'ok'),/Pare/)
    await sleep(300);service.cancel(hang);assert.equal((await done(hang)).status,'cancelled');assert.equal(service.busy(game),false)
    const early=await service.start(t,game,game,'hang');service.cancel(early);assert.equal((await done(early)).status,'cancelled')
    db.prepare("INSERT INTO command_runs(task_id,workspace,name,program,args) VALUES (?,?,?,?,?)").run(t,game,'interrompido','fake','[]');reconcileCommands(db)
    assert.equal(listCommandRuns(db,t)[0].status,'failed')
  } finally {service.stopAll();db.close()}
})
