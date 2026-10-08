// Regressão focal do painel: Electron/React reais, agentes e respostas de arquivo simulados.
// Rode npm run build antes. A fixture bloqueia CLIs, login e rede e usa dados temporários próprios.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-panel-e2e-'))
const tempRoot = fs.realpathSync.native(os.tmpdir())
const safeWork = () => path.dirname(fs.realpathSync.native(work)) === tempRoot && path.basename(work).startsWith('orbit-panel-e2e-') && !fs.lstatSync(work).isSymbolicLink()
assert(safeWork(), 'Pasta temporária fora do destino esperado.')
const userdata = path.join(work, 'userdata'), bin = path.join(work, 'bin'), home = path.join(work, 'home'), game = path.join(work, 'project')
for (const dir of [userdata, bin, home, game, path.join(game, 'src'), path.join(game, 'art')]) fs.mkdirSync(dir)
const unexpectedCli = path.join(work, 'unexpected-cli.log')
for (const provider of ['claude', 'codex', 'gemini', 'opencode']) fs.writeFileSync(path.join(bin, `${provider}.cmd`), `@echo off\r\n>>"${unexpectedCli}" echo ${provider}\r\nexit /b 99\r\n`)
for (const [file, label] of [['alpha.ts', 'ALPHA'], ['beta.ts', 'BETA'], ['gamma.ts', 'GAMMA']]) {
  fs.writeFileSync(path.join(game, 'src', file), Array.from({ length: 100 }, (_, i) => `${label}_ORIGINAL ${i + 1}`).join('\n'))
}
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
fs.writeFileSync(path.join(game, 'art', 'pixel.png'), Buffer.from(pixel.split(',')[1], 'base64'))
const entry = path.join(work, 'orbit-ui.cjs')
fs.writeFileSync(entry, `
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
  const counts = {}, calls = {}, blocked = new Set(), waiters = new Map(), unexpected = [];
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[name] = () => { unexpected.push('process:'+name); throw Error('Processo bloqueado pela fixture') };
  global.fetch = async () => { unexpected.push('network'); throw Error('Rede bloqueada pela fixture') };
  shell.openExternal = async () => { unexpected.push('external'); throw Error('Navegador bloqueado pela fixture') };
  BrowserWindow.prototype.show = function() {};
  BrowserWindow.prototype.maximize = function() {};
  app.on('browser-window-created', (_e, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, callback) => { unexpected.push('renderer-network'); callback({cancel:true}) });
  });
  require(${JSON.stringify(path.join(root, 'out/main/index.js'))});
  const game = ${JSON.stringify(game)}, image = ${JSON.stringify(pixel)};
  const emit = event => BrowserWindow.getAllWindows().forEach(win => win.webContents.send('chat', event));
  const tasks = [1,2].map(id => ({id,game,title:'Fixture task '+id,state:'aberta',legacy:null,pin_id:null,branch:null,worktree:null,created_at:'2026-01-01 00:00:00',updated_at:'2026-01-01 00:00:00',archived_at:null,sel:JSON.stringify({provider:'codex'})}));
  const activity = (file,line) => ({kind:'edit',path:file,line,position:'reported',added:2,removed:1,at:Date.now()});
  const agent = (id,provider,file,line) => {const a=activity(file,line);return {id,provider,active:true,activity:a,events:[a]}};
  const agents = new Map([[1,[agent('chat:1','codex','src/alpha.ts',78),agent('delegation:12','claude','src/beta.ts',42)]],[2,[agent('chat:2','gemini','src/gamma.ts',25)]]]);
  const disk = () => ['src/alpha.ts','src/beta.ts'].map(file => ({path:file,status:'M',added:2,removed:1,lastWrite:null}));
  const previews = new Set(['src/alpha.ts','src/beta.ts','src/gamma.ts','art/pixel.png']);
  const fullThought = 'EXPOSED_THINKING_FIXTURE\\nFULL_THINKING_PAGE_ONE\\n'.padEnd(64*1024,'.')+'\\nFULL_THINKING_PAGE_TWO';
  const fixtures = {
    diagnose: () => ['codex','claude','gemini'].map(id=>({id,exe:'fixture/'+id+'.cmd',version:'fixture',capabilities:[],missing:[],env:[],auth:{state:'connected'}})),
    listAccounts: () => [], accountStatus: () => ({state:'connected'}), accountUsage: () => null, accountUsageSnapshot: () => null,
    codexUsage: () => null, codexUsageSnapshot: () => null,
    planetUsage: () => [], planetState: () => ({on:false,right:true,bottom:true}),
    catalog: provider => ({provider,source:'manual',at:new Date().toISOString(),models:[],efforts:[],allowCustomModel:true}),
    listGames: () => [game], projectNames: () => ({}), projectIcon: () => null, getProjectGroups: () => [],
    listTasks: () => tasks, taskBriefs: () => [], listActive: () => [],
    novaState: () => ({waiting:[],doneToday:{}}), pulseEvents: () => ({}), projectsPulse: () => [], projectUsage: () => [],
    projectInfo: () => ({kind:'app',stack:'fixture',repo:false,git:null,worktrees:[],lastActivity:null,openTasks:2}),
    listDocs: () => [], listAssets: () => [], listPlaytests: () => [], listBuilds: () => [], listBuildCommands: () => [],
    taskChat: id => ({task:tasks.find(t=>t.id===id),running:false,messages:[],metric:null,sel:{provider:'codex'}}),
    listContextPackages: () => [], listPendingSends: () => [], listSteps: () => [], projectCommands: () => [], listCommandRuns: () => [],
    godotState: () => ({organizer:null,available:false,project:null}),
    stopFiles: () => {}, taskFiles: () => ({repo:true,isolated:false,files:disk()}),
    taskOrbit: id => ({agents:agents.get(id)??[]}),
    orbitActivityText: (id,agentId,textId,offset=0) => {if(id!==1||agentId!=='delegation:12'||textId!=='thought-fixture')return {text:null,next:null,total:0};const end=Math.min(offset+64*1024,fullThought.length);return {text:fullThought.slice(offset,end),next:end<fullThought.length?end:null,total:fullThought.length}},
    fileDiff: () => '',
    orbitFile: (id,file) => {if(!tasks.some(t=>t.id===id)||!previews.has(file))throw Error('Prévia fora da fixture');const abs=path.join(game,file),stat=fs.statSync(abs);return {path:file,kind:file.endsWith('.png')?'image':'text',startLine:1,lines:file.endsWith('.png')?[]:fs.readFileSync(abs,'utf8').split('\\n'),size:stat.size,modifiedAt:stat.mtimeMs,...(!file.endsWith('.png')?{totalLines:100}:{})}},
    taskImage: (id,file) => tasks.some(t=>t.id===id)&&file==='art/pixel.png'?image:null
  };
  const gate = name => blocked.has(name) ? new Promise(resolve => { const list=waiters.get(name)??[];list.push(resolve);waiters.set(name,list) }) : Promise.resolve();
  for (const [name,fn] of Object.entries(fixtures)) {
    ipcMain.removeHandler(name);
    ipcMain.handle(name, async (_e,...args) => {counts[name]=(counts[name]??0)+1;(calls[name]??=[]).push(args);const result=structuredClone(fn(...args));await gate(name);return result});
  }
  ipcMain.handle('orbitFixture', async (_e,action,input=[]) => {
    if(action==='block')input.forEach(name=>blocked.add(name));
    if(action==='release')input.forEach(name=>{blocked.delete(name);for(const resolve of waiters.get(name)??[])resolve();waiters.delete(name)});
    if(action==='emit')input.forEach(emit);
    if(action==='activity') {const {taskId,agent}=input;const list=agents.get(taskId)??[];agents.set(taskId,list.map(a=>a.id===agent.id?agent:a));emit({orbitActivity:{taskId,agent}})}
    if(action==='screenshot') {const win=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('#'));return (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64')}
    return {counts,calls,pending:Object.fromEntries([...waiters].map(([name,list])=>[name,list.length])),unexpected};
  });
`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let app, socket, log = '', passed = false
const checks = []
const check = (name, condition) => { assert(condition, name); checks.push(name); console.log(`OK ${name}`) }
try {
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const { ELECTRON_RENDERER_URL: _dev, ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  app = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [entry, `--user-data-dir=${userdata}`, `--remote-debugging-port=${port}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], {
    env: { ...env, PATH: `${bin};${path.dirname(process.execPath)};${path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')}`, USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', chunk => { log += chunk }); app.stderr.on('data', chunk => { log += chunk })
  app.on('error', error => { log += error.message })
  let page
  const deadline = Date.now() + 25_000
  while (!page && Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(p => p.type === 'page' && !p.url.includes('#')) } catch {}
    if (!page) await sleep(100)
  }
  assert(page, 'Renderer não abriu: ' + log.slice(-1000))
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Timeout CDP')), 5000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = () => { clearTimeout(timer); reject(Error('Falha CDP')) }
  })
  let id = 0
  const pending = new Map()
  socket.onmessage = message => { const value=JSON.parse(message.data);pending.get(value.id)?.(value);pending.delete(value.id) }
  const send = (method, params) => new Promise((resolve, reject) => {
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Timeout CDP: '+method))},5000)
    pending.set(requestId,value=>{clearTimeout(timer);resolve(value)});socket.send(JSON.stringify({id:requestId,method,params}))
  })
  const ev = async expression => {
    const reply=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
    assert(!reply.error,reply.error?.message);assert(!reply.result?.exceptionDetails,reply.result?.exceptionDetails?.exception?.description)
    return reply.result.result.value
  }
  const control = (action='status',input=[]) => ev(`window.invoke('orbitFixture',${JSON.stringify(action)},${JSON.stringify(input)})`)
  const wait = async expression => {
    const end=Date.now()+6000
    while(Date.now()<end){if(await ev(expression))return;await sleep(50)}
    throw Error('Interface não chegou: '+expression)
  }
  const frames = expression => ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(${expression}))))`)
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const openTask = taskId => ev(`[...document.querySelectorAll('.task-row button.task,.ph-tasks button')].find(b=>b.textContent.includes('Fixture task ${taskId}')).click()`)
  const selectAgent = label => ev(`[...document.querySelectorAll('.orbit-agent-tabs [role=tab]')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  const sourceIs = (file,marker) => `document.querySelector('.orbit-filehead>span')?.textContent===${JSON.stringify(file)} && document.querySelector('.orbit-code')?.textContent.includes(${JSON.stringify(marker)})`
  const expose = (taskId,agentId,provider,activity,events) => control('activity',{taskId,agent:{id:agentId,provider,active:true,activity:{...activity,at:Date.now()},events:events??[{...activity,at:Date.now()}]}})
  const storedSetting = () => {
    const db = new DatabaseSync(path.join(userdata,'dashboard.db'),{readOnly:true})
    try { return db.prepare("SELECT value FROM settings WHERE key='workspaceOrbit'").get()?.value } finally { db.close() }
  }
  const inspectLayout = async height => {
    await send('Emulation.setDeviceMetricsOverride',{width:1400,height,deviceScaleFactor:1,mobile:false})
    await frames('true')
    const dimensions=await ev("(() => {const p=document.querySelector('.orbit-panel'),b=document.querySelector('.orbit-bottom'),g=document.querySelector('.orbit-globe-stage'),code=document.querySelector('.orbit-code'),line=document.querySelector('.orbit-line.active'),scope=document.querySelector('.orbit-scope'),summary=document.querySelector('.orbit-globe-files>summary');const br=b.getBoundingClientRect(),cr=code.getBoundingClientRect(),lr=line.getBoundingClientRect();return {viewport:innerHeight,panel:p.clientHeight,bottom:b.clientHeight,scroll:b.scrollHeight,globe:g.clientHeight,activeVisible:lr.top>=cr.top-1&&lr.bottom<=cr.bottom+1,controlsVisible:scope.getBoundingClientRect().bottom<=br.bottom+1&&summary.getBoundingClientRect().bottom<=br.bottom+1}})()")
    console.log('LAYOUT '+JSON.stringify(dimensions))
    if(process.env.ORBIT_E2E_SCREENSHOTS==='1'){
      // A janela fica oculta. Emular visibilidade só durante a captura permite ao canvas redesenhar após resize.
      const hidden=await ev('document.hidden')
      let data
      try {
        if(hidden)await ev("window.orbitHiddenDescriptor=Object.getOwnPropertyDescriptor(document,'hidden');Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))")
        await frames('true')
        data=await control('screenshot')
      } finally {
        if(hidden)await ev("if(window.orbitHiddenDescriptor)Object.defineProperty(document,'hidden',window.orbitHiddenDescriptor);else delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))")
      }
      assert(data,'Captura de tela indisponível.')
      const output=path.join(root,'docs',`orbit-e2e-${height}.png`)
      fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(data,'base64'))
    }
    return dimensions
  }

  await wait("!!document.querySelector('button[aria-label=\"Configurações\"]') && !!window.invoke")
  await ev('document.startViewTransition=undefined')
  check('Planeta vem ligado por padrão na instalação isolada',await ev("window.invoke('workspaceOrbit')"))
  await ev("[...document.querySelectorAll('.rail-ws')].find(b=>b.getAttribute('aria-label').startsWith('Sem organizador,')).click()")
  await wait("!!document.querySelector('.ph-tasks')")
  await openTask(1)
  await wait(sourceIs('src/alpha.ts','ALPHA_ORIGINAL'))
  check('Painel padrão monta planeta e janela de código',await ev("!!document.querySelector('.orbit-globe-surface') && document.querySelectorAll('.orbit-agent-tabs [role=tab]').length===2 && !!document.querySelector('.orbit-panel')"))
  check('Linha informada pela CLI aparece rotulada e destacada',await ev("document.querySelector('.orbit-filehead small')?.textContent==='CLI · linha 78' && document.querySelector('.orbit-line.active .orbit-line-number')?.textContent==='78'"))
  const wide=await inspectLayout(900),short=await inspectLayout(620)
  check('Planeta continua montado nas duas alturas',wide.globe>0&&short.globe>0)
  check('Controles do planeta cabem nas duas alturas',wide.controlsVisible&&short.controlsVisible)
  check('Linha ativa continua visível ao redimensionar',wide.activeVisible&&short.activeVisible)
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false})
  await selectAgent('Claude')
  await wait(sourceIs('src/beta.ts','BETA_ORIGINAL'))
  check('Trocar agente acompanha seu arquivo e sua linha',await ev("document.querySelector('.orbit-line.active .orbit-line-number')?.textContent==='42' && document.querySelector('.orbit-agent-tabs [aria-selected=true]')?.textContent==='Claude'"))
  await selectAgent('Codex')
  await wait(sourceIs('src/alpha.ts','ALPHA_ORIGINAL'))
  fs.writeFileSync(path.join(game,'src','alpha.ts'),Array.from({length:100},(_,i)=>`ALPHA_DISK_UPDATE ${i+1}`).join('\n'))
  const beforeWrite=(await control()).counts.orbitFile
  await control('emit',Array.from({length:80},()=>({fileWrite:{taskId:1,path:'src/alpha.ts'}})))
  await wait(sourceIs('src/alpha.ts','ALPHA_DISK_UPDATE'))
  check('Gravação recarrega o disco e rajada vira uma única prévia',(await control()).counts.orbitFile===beforeWrite+1)

  await control('block',['orbitFile'])
  await control('emit',[{fileWrite:{taskId:1,path:'src/alpha.ts'}}])
  await wait("window.invoke('orbitFixture','status').then(s=>s.pending.orbitFile===1)")
  await ev("window.orbitLeaks=[];window.orbitObserver=new MutationObserver(()=>{if(document.querySelector('.orbit-code')?.textContent.includes('ALPHA_DISK_UPDATE'))window.orbitLeaks.push('arquivo antigo')});window.orbitObserver.observe(document.querySelector('.orbit-source-area'),{childList:true,subtree:true})")
  await selectAgent('Claude')
  check('Troca de agente esconde o texto antigo enquanto a prévia está retida',await frames("!document.querySelector('.orbit-code')?.textContent.includes('ALPHA_DISK_UPDATE') && document.querySelector('.orbit-filehead>span')?.textContent==='src/beta.ts'"))
  await control('release',['orbitFile'])
  await wait(sourceIs('src/beta.ts','BETA_ORIGINAL'))
  check('Resposta atrasada do arquivo anterior não reaparece',await ev("window.orbitObserver.disconnect();window.orbitLeaks.length===0"))
  await control('block',['orbitFile'])
  await control('emit',[{fileWrite:{taskId:1,path:'src/beta.ts'}}])
  await wait("window.invoke('orbitFixture','status').then(s=>s.pending.orbitFile===1)")
  await ev("window.orbitLeaks=[];window.orbitObserver=new MutationObserver(()=>{if(document.querySelector('.orbit-code')?.textContent.includes('BETA_ORIGINAL'))window.orbitLeaks.push('arquivo antigo')});window.orbitObserver.observe(document.querySelector('.orbit-source-area'),{childList:true,subtree:true})")
  const next={kind:'read',path:'src/gamma.ts',line:25,position:'reported'}
  await expose(1,'delegation:12','claude',next)
  check('Salto de arquivo esconde a prévia anterior antes da resposta',await frames("document.querySelector('.orbit-filehead>span')?.textContent==='src/gamma.ts' && !document.querySelector('.orbit-code')?.textContent.includes('BETA_ORIGINAL')"))
  await control('release',['orbitFile'])
  await wait(sourceIs('src/gamma.ts','GAMMA_ORIGINAL'))
  check('Novo arquivo e linha vencem a resposta atrasada do mesmo agente',await ev("window.orbitObserver.disconnect();window.orbitLeaks.length===0 && document.querySelector('.orbit-line.active .orbit-line-number')?.textContent==='25'"))

  const thought={kind:'thinking',summary:'EXPOSED_THINKING_FIXTURE',ref:'thought-1',textId:'thought-fixture',truncated:true,at:Date.now()}
  const message={kind:'message',direction:'sent',summary:'VISIBLE_AGENT_MESSAGE_FIXTURE',at:Date.now()}
  await expose(1,'delegation:12','claude',thought,[{...next,at:Date.now()},message,thought])
  await wait("document.querySelector('[aria-label=\"Raciocínio exposto pela CLI\"] pre')?.textContent==='EXPOSED_THINKING_FIXTURE'")
  check('Texto completo do pensamento não é consultado antecipadamente',!(await control()).counts.orbitActivityText)
  await ev("[...document.querySelectorAll('.orbit-source-area button')].find(b=>b.textContent==='Ver texto completo').click()")
  await wait("document.querySelector('.orbit-source-area pre')?.textContent.includes('FULL_THINKING_PAGE_ONE')")
  check('Pedido explícito carrega texto além do resumo',(await control()).counts.orbitActivityText===1)
  await ev("[...document.querySelectorAll('.orbit-source-area button')].find(b=>b.textContent==='Carregar mais').click()")
  await wait("document.querySelector('.orbit-source-area pre')?.textContent.includes('FULL_THINKING_PAGE_TWO')")
  check('Texto exposto paginado é concatenado sem perder o primeiro trecho',await ev("document.querySelector('.orbit-source-area pre')?.textContent.includes('FULL_THINKING_PAGE_ONE')")&&(await control()).calls.orbitActivityText[1][3]===64*1024)
  await expose(1,'delegation:12','claude',thought,[{...next,at:Date.now()},message,thought])
  await wait("[...document.querySelectorAll('.orbit-source-area button')].some(b=>b.textContent==='Atualizar texto completo')")
  check('Atualização parcial preserva o texto completo já aberto',await ev("document.querySelector('.orbit-source-area pre')?.textContent.includes('FULL_THINKING_PAGE_TWO')")&&(await control()).counts.orbitActivityText===2)
  await click('.orbit-activity>summary')
  await ev("[...document.querySelectorAll('.orbit-event>summary')].find(s=>s.textContent.includes('Mensagem enviada')).click()")
  check('Pensamento exposto e mensagem ficam visíveis e separados do código',await ev("document.querySelector('.orbit-source-area')?.textContent.includes('EXPOSED_THINKING_FIXTURE') && document.querySelector('.orbit-activity-list')?.textContent.includes('VISIBLE_AGENT_MESSAGE_FIXTURE') && !document.querySelector('.orbit-code')"))
  await expose(1,'delegation:12','claude',{kind:'image',path:'art/pixel.png',ref:'opaque-image-call'},[{...next,at:Date.now()},message,thought,{kind:'image',path:'art/pixel.png',ref:'opaque-image-call',at:Date.now()}])
  await wait("document.querySelector('.orbit-source-area img')?.complete && document.querySelector('.orbit-source-area img')?.naturalWidth===1")
  check('Imagem indicada pelo agente usa a prévia de imagem',await ev("document.querySelector('.orbit-source-area img')?.alt==='Imagem vista pelo agente: art/pixel.png'"))
  await click('.orbit-disable')
  await wait("!!document.querySelector('.files-panel') && !document.querySelector('.orbit-panel')")
  check('Controle no topo volta à lista e persiste a escolha',storedSetting()==='off' && await ev("window.invoke('workspaceOrbit').then(v=>v===false)"))
  await ev("[...document.querySelectorAll('.files-panel header button')].find(b=>b.textContent==='Planeta').click()")
  await wait("!!document.querySelector('.orbit-panel')")
  check('Lista permite reativar o planeta',storedSetting()==='on')
  await click('button[aria-label="Configurações"]')
  await ev("[...document.querySelectorAll('.set-head [role=tab]')].find(b=>b.textContent==='Interface').click()")
  await wait("!!document.querySelector('.settings input[type=checkbox]')")
  check('Configurações Interface mostra a preferência atual',await ev("document.querySelector('.settings input[type=checkbox]').checked"))
  await click('.settings input[type=checkbox]')
  await wait("window.invoke('workspaceOrbit').then(v=>v===false)")
  check('Configurações grava a preferência no SQLite real',storedSetting()==='off')
  await send('Page.reload',{})
  await wait("!!document.querySelector('button[aria-label=\"Configurações\"]') && !!window.invoke")
  await click('button[aria-label="Configurações"]')
  await ev("[...document.querySelectorAll('.set-head [role=tab]')].find(b=>b.textContent==='Interface').click()")
  await wait("!!document.querySelector('.settings input[type=checkbox]')")
  check('Recarregar o renderer mantém a opção desativada',await ev("document.querySelector('.settings input[type=checkbox]').checked===false"))
  const finalState=await control()
  check('Nenhuma CLI, rede ou login real foi chamado',!fs.existsSync(unexpectedCli)&&finalState.unexpected.length===0)
  check('Electron não registrou exceções não tratadas',!/UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError/.test(log))
  passed=true
  console.log(`${checks.length}/${checks.length} verificações OK`)
} catch(error) {
  console.error(error.stack);console.error(log.slice(-1500));console.error('Fixture preservada para diagnóstico:',work);process.exitCode=1
} finally {
  socket?.close()
  if(app?.pid)try{execFileSync('taskkill',['/pid',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  if(passed&&safeWork())try{fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:100})}catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;console.warn('Windows manteve arquivos temporários bloqueados; fixture preservada.')}
}
