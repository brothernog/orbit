import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { WorkspaceGuard } from './delegation.ts'
import { createCommandService, listCommandRuns, normalizeCommand, projectCommands, reconcileCommands, saveCommands } from './commands.ts'
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
  const wait = async (id: number) => { for (let i = 0; i < 150; i++) { const row = listCommandRuns(db, task).find(r => r.id === id)!; if (row.status !== 'running') return row; await sleep(20) } throw Error('timeout') }
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
test('comandos: chave por projeto minuscula no Windows/macOS (bancos existentes); caixa conta no Linux',()=>{
  const db=new DatabaseSync(':memory:');migrate(db)
  const cmd={name:'t',purpose:'test',program:process.execPath,args:[]}
  saveCommands(db,'/p/Jogo',[cmd])
  const fold=process.platform!=='linux'
  assert.equal(projectCommands(db,'/p/jogo').length,fold?1:0)
  if(process.platform==='win32')assert.ok(db.prepare('SELECT 1 FROM settings WHERE key=?').get('commands:'+path.resolve('/p/Jogo').toLowerCase()))
})
