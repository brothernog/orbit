import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { WorkspaceGuard } from './delegation.ts'
import { commandOutput, commandRun, createCommandService, listCommandRuns, normalizeCommand, projectCommands, reconcileCommands, saveCommands } from './commands.ts'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))

test('comandos: revalidação antes do spawn impede executar destino alterado; diagnóstico não transforma exit 0 em sucesso', async () => {
  const db = new DatabaseSync(':memory:'); migrate(db)
  const cwd = process.cwd(), task = createTask(db, cwd)
  saveCommands(db, cwd, [{ name: 'diagnóstico', purpose: 'test', program: process.execPath, args: ['-e', 'console.log("SCRIPT ERROR: Parse Error: invalid script")'] }])
  let checks = 0, block = true
  const service = createCommandService(db, new WorkspaceGuard(), () => false, () => {}, {
    beforeSpawn: () => { if (++checks === 2 && block) throw Error('Destino mudou antes do spawn.') },
    resultError: (_command, output) => output.includes('SCRIPT ERROR:') ? 'Erro Godot reconhecido.' : undefined
  })
  const wait = async (id: number) => { for (let i = 0; i < 150; i++) { const row = commandRun(db, task, id)!; if (row.status !== 'running') return row; await sleep(20) } throw Error('timeout') }
  try {
    const failed = await wait(await service.start(task, cwd, cwd, 'diagnóstico'))
    assert.equal(failed.status, 'failed'); assert.equal(failed.output, ''); assert.equal(failed.exit_code, null); assert.match(failed.error!, /Destino mudou/)
    block = false
    const diagnosed = await wait(await service.start(task, cwd, cwd, 'diagnóstico'))
    assert.equal(diagnosed.exit_code, 0); assert.equal(diagnosed.status, 'failed'); assert.match(diagnosed.output, /SCRIPT ERROR/); assert.match(diagnosed.error!, /Godot/)
    assert.equal(service.busy(cwd), false)
  } finally { service.stopAll(); db.close() }
})
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
  let agents=false;const events:any[]=[];const service=createCommandService(db,guard,()=>agents,event=>events.push(event))
  const done=async(id:number)=>{for(let i=0;i<150;i++){const r=commandRun(db,t,id)!;if(r.status!=='running')return r;await sleep(50)}throw Error('timeout')}
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
    assert.deepEqual(events.filter(e=>e.commandRun?.id===hang).map(e=>e.commandRun.status),['running','cancelled'])
    assert.equal(events.filter(e=>e.commandDone?.id===hang).length,1)
    const early=await service.start(t,game,game,'hang');service.cancel(early);assert.equal((await done(early)).status,'cancelled')
    db.prepare("INSERT INTO command_runs(task_id,workspace,name,program,args) VALUES (?,?,?,?,?)").run(t,game,'interrompido','fake','[]');reconcileCommands(db)
    assert.equal(listCommandRuns(db,t)[0].status,'failed')
  } finally {service.stopAll();db.close()}
})
test('comandos: chave por projeto minuscula no Windows/macOS (bancos existentes); caixa conta no Linux',()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const cmd={name:'t',purpose:'test',program:process.execPath,args:[]}
  saveCommands(db,'/p/Jogo',[cmd])
  const fold=process.platform!=='linux'
  assert.equal(projectCommands(db,'/p/jogo').length,fold?1:0)
  if(process.platform==='win32')assert.ok(db.prepare('SELECT 1 FROM settings WHERE key=?').get('commands:'+path.resolve('/p/Jogo').toLowerCase()))
})

test('comandos: listas leves e leitura incremental preservam ownership e offsets UTF-16',()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const game=process.cwd(),task=createTask(db,game),other=createTask(db,game)
  const output='A😀B'+'x'.repeat(999_996)
  const id=Number(db.prepare('INSERT INTO command_runs(task_id,workspace,name,program,args,output,truncated) VALUES (?,?,?,?,?,?,1)').run(task,game,'Grande','fake','[]',output).lastInsertRowid)
  try {
    const [summary]=listCommandRuns(db,task)
    assert.equal(Object.hasOwn(summary,'output'),false);assert.equal(summary.id,id);assert.equal(summary.truncated,1)
    assert.equal(commandRun(db,other,id),undefined)
    assert.throws(()=>commandOutput(db,other,id),/outra tarefa/)
    assert.deepEqual(commandOutput(db,task,id),{offset:0,output,total:1_000_000,truncated:1})
    assert.deepEqual(commandOutput(db,task,id,3),{offset:3,output:output.slice(3),total:1_000_000,truncated:1})
    assert.equal(output.slice(0,2)+commandOutput(db,task,id,2).output,output)
    assert.deepEqual(commandOutput(db,task,id,output.length),{offset:1_000_000,output:'',total:1_000_000,truncated:1})
    assert.equal(commandOutput(db,task,id,999_995).output,'xxxxx')
    for(const offset of [-1,0.5,NaN,Infinity,1_000_001])assert.throws(()=>commandOutput(db,task,id,offset),/inválido/)
    db.prepare("UPDATE command_runs SET output='curto',truncated=0 WHERE id=?").run(id)
    assert.throws(()=>commandOutput(db,task,id,6),/além/)
    assert.equal(commandOutput(db,task,id,0).truncated,0)
  } finally {db.close()}
})

test('comandos: rajadas de saída emitem metadados; início/fim únicos e flush final precedem conclusão',async()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const game=process.cwd(),task=createTask(db,game),events:any[]=[]
  saveCommands(db,game,[{name:'Rajada',purpose:'test',program:process.execPath,args:['-e','let n=0;const timer=setInterval(()=>{process.stdout.write("x".repeat(60000));if(++n===20)clearInterval(timer)},20)']}])
  const service=createCommandService(db,new WorkspaceGuard(),()=>false,event=>events.push(event))
  try {
    const id=await service.start(task,game,game,'Rajada')
    for(let i=0;i<150&&commandRun(db,task,id)!.status==='running';i++)await sleep(50)
    const run=commandRun(db,task,id)!
    assert.equal(run.status,'completed');assert.equal(run.output.length,1_000_000);assert.equal(run.truncated,1)
    const changes=events.filter(e=>e.commandChanged),outputs=events.filter(e=>e.commandOutput),done=events.filter(e=>e.commandDone)
    assert.equal(changes.length,2);assert.equal(changes[0].commandRun.status,'running');assert.equal(changes[1].commandRun.status,'completed')
    assert.equal(Object.hasOwn(changes[1].commandRun,'output'),false);assert.equal(changes[1].game,game)
    assert.ok(outputs.length>0);assert.equal(done.length,1);assert.equal(done[0].commandDone.output.length,20_000)
    for(let i=0;i<outputs.length;i++){
      const event=outputs[i]
      assert.deepEqual(Object.keys(event.commandOutput).sort(),['id','outputLength','truncated']);assert.equal(event.game,game);assert.equal(event.taskId,task)
      assert.equal(Object.hasOwn(event,'commandChanged'),false)
      if(i)assert.notDeepEqual(event.commandOutput,outputs[i-1].commandOutput)
    }
    assert.deepEqual(outputs.at(-1).commandOutput,{id,outputLength:1_000_000,truncated:true})
    assert.ok(events.indexOf(outputs.at(-1))<events.indexOf(changes[1]));assert.ok(events.indexOf(changes[1])<events.indexOf(done[0]))
  } finally {service.stopAll();db.close()}
})

test('comandos: saída viva vem da memória; SQLite grava só no intervalo longo e no fim, antes da conclusão',async()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  let writes=0
  const counted=new Proxy(db,{get(target,prop){
    if(prop==='prepare')return (sql:string)=>{if(/SET output=/.test(sql))writes++;return target.prepare(sql)}
    const value=(target as any)[prop];return typeof value==='function'?value.bind(target):value
  }}) as DatabaseSync
  const game=process.cwd(),task=createTask(db,game),other=createTask(db,game),events:any[]=[]
  // ~1,2 s de saída em 40 pedaços: antes eram ~8 regravações do texto inteiro; agora uma só, no fim.
  saveCommands(db,game,[{name:'Longo',purpose:'test',program:process.execPath,args:['-e','let n=0;const t=setInterval(()=>{process.stdout.write("é😀".repeat(500));if(++n===40)clearInterval(t)},30)']}])
  const service=createCommandService(counted,new WorkspaceGuard(),()=>false,event=>{
    if(event && (event as any).commandDone)events.push({done:true,writes,stored:commandRun(db,task,(event as any).commandDone.id)!.output.length})
    events.push(event)
  })
  try {
    const id=await service.start(task,game,game,'Longo')
    let live:any
    for(let i=0;i<100;i++){await sleep(30);live=service.output(task,id);if(live.total>=3000)break}
    assert.ok(live.total>=3000);assert.equal(commandRun(db,task,id)!.output,'') // ainda não persistido
    assert.ok(service.output(task,id,2).output.startsWith(live.output.slice(2))) // offsets UTF-16; a saída só cresce
    assert.throws(()=>service.output(other,id),/outra tarefa/)
    assert.throws(()=>service.output(task,id,1_000_001),/inválido/)
    for(let i=0;i<150&&commandRun(db,task,id)!.status==='running';i++)await sleep(30)
    const run=commandRun(db,task,id)!
    assert.equal(run.status,'completed');assert.equal(run.output.length,40*500*3);assert.equal(writes,1)
    const marker=events.find(e=>e.done);assert.equal(marker.writes,1);assert.equal(marker.stored,run.output.length) // flush final antes do commandDone
    assert.deepEqual(service.output(task,id,3),commandOutput(db,task,id,3)) // terminado: lê do SQLite
    assert.deepEqual(events.filter(e=>e.commandOutput).at(-1).commandOutput,{id,outputLength:run.output.length,truncated:false})
  } finally {service.stopAll();db.close()}
})
