
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask, getTask } from './tasks.ts'
import { createChatService } from './chatService.ts'
import { WorkspaceGuard, DEFAULT_SETTINGS } from './delegation.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import { normalizePermissionSettings } from './permissions.ts'

test('chat: comando iniciado durante preparação assíncrona do MCP impede o spawn e não grava execução',async()=>{
  const db=new DatabaseSync(':memory:');migrate(db);const task=createTask(db,process.cwd())
  let busy=false,release!: (v:{url:string})=>void,entered!: ()=>void
  const waiting=new Promise<{url:string}>(r=>release=r),ready=new Promise<void>(r=>entered=r)
  const forbidden=()=>{throw Error('Não deveria iniciar execução/entrega.')}
  const service=createChatService({db,active:new Map(),guard:new WorkspaceGuard(),broker:{} as any,
    asTask:id=>getTask(db,id),taskCwd:()=>process.cwd(),checkSel:async()=>{},workspaceBusy:()=>busy,
    contextLimits:()=>DEFAULT_LIMITS,delegationSettings:()=>({...DEFAULT_SETTINGS,enabled:true}),permissionSettings:()=>normalizePermissionSettings(null),
    getMcp:()=>{entered();return waiting},mcpDir:()=>process.cwd(),nativeFor:forbidden,envFor:forbidden,
    emit:()=>{},note:()=>{},logFor:()=>()=>{},accountRow:()=>null,setSetting:()=>{},recordMetric:()=>{},registerParent:forbidden,unregisterToken:()=>{},attachRoot:process.cwd(),linkedinDir:process.cwd()+'/linkedin'
  })
  const send=service.sendTask(task,{provider:'codex'},'Investigue o projeto')
  await ready;busy=true;release({url:'http://127.0.0.1:1/mcp'})
  await assert.rejects(send,/comando local/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n,0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as any).n,0)
  db.close()
})

test('chat: Godot prepara MCP mesmo sem delegação; revogação durante preparo impede spawn', async () => {
  const db = new DatabaseSync(':memory:'); migrate(db); const task = createTask(db, process.cwd())
  let organizer: string | undefined = 'jogos', entered!: () => void, release!: (v: { url: string }) => void
  const ready = new Promise<void>(r => entered = r), waiting = new Promise<{ url: string }>(r => release = r)
  const forbidden = () => { throw Error('Não deveria iniciar execução.') }
  const service = createChatService({ db, active: new Map(), guard: new WorkspaceGuard(), broker: {} as any,
    asTask: id => getTask(db, id), taskCwd: () => process.cwd(), checkSel: async () => {}, workspaceBusy: () => false,
    contextLimits: () => DEFAULT_LIMITS, delegationSettings: () => ({ ...DEFAULT_SETTINGS, enabled: false }), permissionSettings: () => normalizePermissionSettings(null),
    engineGrants: () => organizer ? { godot: organizer } : {}, getMcp: () => { entered(); return waiting }, mcpDir: () => process.cwd(), nativeFor: forbidden, envFor: forbidden,
    emit: () => {}, note: () => {}, logFor: () => () => {}, accountRow: () => null, setSetting: () => {}, recordMetric: () => {}, registerParent: forbidden, unregisterToken: () => {}, attachRoot: process.cwd(), linkedinDir: process.cwd() + '/linkedin'
  })
  const send = service.sendTask(task, { provider: 'codex' }, 'Consulte a cena')
  await ready; organizer = undefined; release({ url: 'http://127.0.0.1:1/mcp' })
  await assert.rejects(send, /configuração Godot/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM runs').get() as any).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as any).n, 0)
  db.close()
})
