// Regressao focal: Electron/React/IPC reais, uso, diagnostico e comandos simulados.
// Rode npm run build antes; nenhuma credencial, login ou chamada de inferencia.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-loading-e2e-'))
const tempRoot = fs.realpathSync.native(os.tmpdir())
const safeWork = () => path.dirname(fs.realpathSync.native(work)) === tempRoot && path.basename(work).startsWith('orbit-loading-e2e-') && !fs.lstatSync(work).isSymbolicLink()
assert(safeWork(), 'Pasta temporaria fora do destino esperado.')
const userdata = path.join(work, 'userdata'), bin = path.join(work, 'bin'), home = path.join(work, 'home')
const game = path.join(work, 'project'), otherGame = path.join(work, 'other-project')
for (const dir of [userdata, bin, home, game, otherGame]) fs.mkdirSync(dir)
const unexpectedCli = path.join(work, 'unexpected-cli.log')
for (const provider of ['claude', 'codex', 'gemini', 'opencode']) {
  fs.writeFileSync(path.join(bin, `${provider}.cmd`), `@echo off\r\n>>"${unexpectedCli}" echo ${provider}\r\nexit /b 99\r\n`)
}
const entry = path.join(work, 'loading-ui.cjs')
fs.writeFileSync(entry, `
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  const counts = {}, calls = {}, blocked = new Set(), waiters = new Map(), unexpected = [];
  const locals = new Map(), handle = ipcMain.handle.bind(ipcMain);
  const localReads = new Set(['getDelegationSettings', 'getNotifySettings', 'getContextLimits', 'delegationReport']);
  ipcMain.handle = (name, fn) => { if(localReads.has(name)) locals.set(name, fn); return handle(name, fn) };
  global.fetch = async () => { unexpected.push('network'); throw Error('Rede bloqueada pela fixture') };
  shell.openExternal = async () => { unexpected.push('external'); throw Error('Navegador bloqueado pela fixture') };
  BrowserWindow.prototype.show = function() {};
  BrowserWindow.prototype.maximize = function() {};
  app.on('browser-window-created', (_e, win) => win.webContents.setBackgroundThrottling(false));
  require(${JSON.stringify(path.join(root, 'out/main/index.js'))});
  ipcMain.handle = handle;
  const quota = { fiveHour: { utilization: 27, resets_at: new Date(Date.now()+3600000).toISOString() }, sevenDay: { utilization: 53, resets_at: new Date(Date.now()+86400000).toISOString() }, seenAt: new Date().toISOString(), cached: true };
  const providers = [{ id: 'codex', exe: 'fixture/codex.cmd', version: 'fixture-known', capabilities: [], missing: [], env: [], auth: {state: 'connected'} }];
  const game = ${JSON.stringify(game)}, otherGame = ${JSON.stringify(otherGame)};
  const tasks = [1,2].map(id => ({id, game, title:'Fixture task '+id, state:'aberta', legacy:null, pin_id:null, branch:null, worktree:null, created_at:'2026-01-01 00:00:00', updated_at:'2026-01-01 00:00:00', archived_at:null, sel:JSON.stringify({provider:'codex'})}));
  const output = new Map();
  const runs = new Map(tasks.map(task => [task.id, Array.from({length:20}, (_,i) => {
    const id = task.id*100+i; output.set(id,'log '+id+' inicial\\n');
    return {id,task_id:task.id,workspace:game,name:'Fixture command '+id,program:'node',args:'[]',status:'completed',truncated:0,exit_code:0,duration_ms:100,error:null,started_at:'2026-01-01 00:00:00'};
  })]));
  const configs = [{name:'Fixture command',purpose:'build',program:'node',args:[]}];
  const fixtures = {
    diagnose: () => providers,
    accountStatus: () => ({ state: 'connected', plan: 'fixture' }),
    accountUsageSnapshot: () => quota, accountUsage: () => quota,
    codexUsage: () => quota, codexUsageSnapshot: () => quota,
    planetUsage: () => [], planetState: () => ({on: false, right: true, bottom: true}),
    catalog: provider => ({ provider, source: 'manual', at: new Date().toISOString(), models: [], efforts: [], allowCustomModel: true }),
    listGames: () => [game,otherGame], projectNames: () => ({}), getProjectGroups: () => [],
    listTasks: g => g===game ? tasks : [], taskBriefs: () => [], listActive: () => [],
    novaState: () => ({waiting:[],doneToday:{}}), pulseEvents: () => ({}),
    projectInfo: () => ({kind:'app',stack:'fixture',repo:false,git:null,worktrees:[],lastActivity:null,openTasks:2}),
    projectsPulse: () => [], projectUsage: () => [], listDocs: () => [],
    listAssets: () => [], listPlaytests: () => [], listBuilds: () => [],
    listBuildCommands: g => g===game ? [...runs.values()].flat().filter(r=>r.status==='completed'&&r.exit_code===0).map(r=>({id:r.id,name:r.name,workspace:r.workspace,task_title:'Fixture task '+r.task_id})) : [],
    taskChat: id => ({task:tasks.find(t=>t.id===id),running:false,messages:[],metric:null,sel:{provider:'codex'}}),
    listContextPackages: () => [], listPendingSends: () => [], listSteps: () => [], listPermissionRequests: () => [],
    stopFiles: () => {}, taskFiles: () => ({repo:false,isolated:false,files:[]}),
    godotState: () => ({organizer:null,available:false,project:null}),
    worktreeCopy: () => ({list:[],suggestions:[]}),
    projectCommands: () => configs,
    listCommandRuns: id => runs.get(id)??[],
    commandOutput: (taskId,id,offset=0) => { if(!(runs.get(taskId)??[]).some(r=>r.id===id))throw Error('Comando de outra tarefa');const text=output.get(id)??''; return {offset,output:text.slice(offset),total:text.length,truncated:0} }
  };
  const gate = name => blocked.has(name) ? new Promise(resolve => {
    const list = waiters.get(name) ?? []; list.push(resolve); waiters.set(name, list);
  }) : Promise.resolve();
  for(const [name, fn] of Object.entries(fixtures)) {
    ipcMain.removeHandler(name);
    handle(name, async (_e, ...args) => { counts[name]=(counts[name]??0)+1; (calls[name]??=[]).push(args); const result=structuredClone(fn(...args)); await gate(name); return result });
  }
  for(const [name, fn] of locals) {
    ipcMain.removeHandler(name);
    handle(name, async (e, ...args) => { counts[name]=(counts[name]??0)+1; await gate(name); return fn(e, ...args) });
  }
  const emit = event => BrowserWindow.getAllWindows().forEach(win => win.webContents.send('chat',event));
  handle('loadingFixture', (_e, action, names=[]) => {
    if(action === 'block') names.forEach(name => blocked.add(name));
    if(action === 'release') names.forEach(name => { blocked.delete(name); for(const resolve of waiters.get(name)??[]) resolve(); waiters.delete(name) });
    if(action === 'releaseNext') names.forEach(name => waiters.get(name)?.shift()?.());
    if(action === 'releaseLast') names.forEach(name => waiters.get(name)?.pop()?.());
    if(action === 'emit') names.forEach(emit);
    if(action === 'run') { const row=names, list=runs.get(row.task_id)??[]; runs.set(row.task_id,[row,...list.filter(r=>r.id!==row.id)].slice(0,20)); if(!output.has(row.id))output.set(row.id,''); emit({taskId:row.task_id,game:row.workspace,commandChanged:true,commandRun:row}) }
    if(action === 'append') {const {taskId,id,text}=names; output.set(id,(output.get(id)??'')+text);const row=runs.get(taskId).find(r=>r.id===id);emit({taskId,game:row.workspace,commandOutput:{id,outputLength:output.get(id).length,truncated:false}})}
    return {counts,calls, pending: Object.fromEntries([...waiters].map(([name,list])=>[name,list.length])), unexpected};
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
  assert(page, 'Renderer nao abriu: ' + log.slice(-1000))
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Timeout CDP')), 5000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = () => { clearTimeout(timer); reject(Error('Falha CDP')) }
  })
  let id = 0
  const pending = new Map()
  socket.onmessage = message => {
    const value = JSON.parse(message.data)
    pending.get(value.id)?.(value); pending.delete(value.id)
  }
  const send = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Timeout CDP: ' + method)) }, 5000)
    pending.set(requestId, value => { clearTimeout(timer); resolve(value) })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  const ev = async expression => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert(!reply.error, reply.error?.message)
    assert(!reply.result?.exceptionDetails, reply.result?.exceptionDetails?.exception?.description)
    return reply.result.result.value
  }
  const control = (action = 'status', names = []) => ev(`window.invoke('loadingFixture', ${JSON.stringify(action)}, ${JSON.stringify(names)})`)
  const wait = async expression => {
    const end = Date.now() + 5000
    let lastError
    while (Date.now() < end) {
      try { if (await ev(expression)) return } catch (error) { lastError = error }
      await sleep(50)
    }
    if (lastError) throw lastError
    throw Error('Interface nao chegou: ' + expression)
  }
  // Dois frames observam o primeiro desenho; respostas retidas pela fixture continuam pendentes.
  const frames = expression => ev(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(${expression}))))`)
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const tab = label => ev(`[...document.querySelectorAll('.set-head [role=tab]')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  await wait("!!document.querySelector('button[aria-label=\"Configurações\"]') && !!window.invoke")
  await ev('document.startViewTransition = undefined')
  await click('button[aria-label="Configurações"]')
  await wait("document.querySelector('.account [aria-valuenow=\"27\"]') && document.querySelector('.prov')?.textContent.includes('fixture-known')")
  const before = await control()
  await click('button[aria-label="Início"]')
  await frames("!document.querySelector('.settings')")
  await control('block', ['accountUsage', 'accountStatus', 'diagnose'])
  await click('button[aria-label="Configurações"]')
  check('Contas reaparece com 27% e diagnostico conhecido no primeiro desenho', await frames("!!document.querySelector('.account [aria-valuenow=\"27\"]') && !!document.querySelector('.prov')?.textContent.includes('fixture-known')"))
  check('Reabrir Configuracoes nao dispara outro diagnostico', (await control()).counts.diagnose === before.counts.diagnose)

  await click('button[aria-label="Limites de uso"]')
  check('Popup reutiliza o uso conhecido das Contas no primeiro desenho', await frames("!!document.querySelector('.lim-pop .lim-acc [aria-valuenow=\"27\"]')"))
  check('Contas e popup compartilham a consulta dentro do TTL', (await control()).counts.accountUsage === before.counts.accountUsage)
  await click('button[aria-label="Limites de uso"]')
  await frames("!document.querySelector('.lim-pop')")
  await click('button[aria-label="Limites de uso"]')
  check('Reabrir popup preserva valores e barras sem animacao de entrada', await frames("(() => { const el=document.querySelector('.lim-pop .usage .bar div'); if(!el)return false; const css=getComputedStyle(el); return el.style.width==='27%' && css.animationName==='none' && css.transform==='none' })()"))
  await click('button[aria-label="Limites de uso"]')

  await tab('Delegação')
  await wait("!!document.querySelector('.deleg input[type=checkbox]') && !!document.querySelector('[aria-label=\"Nível de contexto\"]')")
  await tab('Avisos')
  await wait("document.querySelector('.settings')?.textContent.includes('Quando um agente terminar') && !!document.querySelector('.deleg input[type=checkbox]')")
  await control('block', ['getDelegationSettings', 'getContextLimits', 'getNotifySettings'])
  await tab('Delegação')
  check('Delegacao mostra controles conhecidos durante revalidacao retida', await frames("!!document.querySelector('.deleg input[type=checkbox]') && !!document.querySelector('[aria-label=\"Nível de contexto\"]') && !document.querySelector('.settings').textContent.includes('Carregando')"))
  check('Getter de Delegacao continua pendente durante o desenho', (await control()).pending.getDelegationSettings > 0)
  await tab('Avisos')
  check('Avisos mostra controles conhecidos durante revalidacao retida', await frames("!!document.querySelector('.deleg input[type=checkbox]') && document.querySelector('.settings').textContent.includes('Quando um agente terminar') && !document.querySelector('.settings').textContent.includes('Carregando')"))
  check('Getter de Avisos continua pendente durante o desenho', (await control()).pending.getNotifySettings > 0)
  await control('release', ['getDelegationSettings', 'getContextLimits', 'getNotifySettings'])
  await tab('Delegação')
  await wait("document.querySelectorAll('.deleg fieldset input').length > 0")
  const delegOn = await ev("document.querySelector('.deleg input[type=checkbox]').checked")
  await click('.deleg input[type=checkbox]')
  await wait(`document.querySelector('.deleg input[type=checkbox]')?.checked === ${!delegOn}`)
  check('Salvar Delegacao mantem a tela (setter devolve o formato da leitura)', await frames("document.querySelectorAll('.deleg fieldset input').length > 0 && !!document.querySelector('.set-head')"))
  await click('.deleg input[type=checkbox]')
  await wait(`document.querySelector('.deleg input[type=checkbox]')?.checked === ${delegOn}`)

  await tab('Contas')
  await frames("!!document.querySelector('.prov')")
  await click('button[aria-label="Diagnosticar de novo"]')
  check('Atualizar diagnostico preserva o anterior enquanto consulta esta pendente', await frames("!!document.querySelector('.prov')?.textContent.includes('fixture-known') && !document.querySelector('.settings').textContent.includes('Consultando as CLIs')"))
  const finalState = await control()
  check('Refresh manual disparou exatamente um diagnostico pendente', finalState.pending.diagnose === 1 && finalState.counts.diagnose === before.counts.diagnose + 1)
  await control('release', ['diagnose', 'accountUsage', 'accountStatus'])

  const getters = ['listAssets', 'listPlaytests', 'listBuilds', 'listBuildCommands', 'projectCommands', 'listCommandRuns']
  const count = (state, name) => state.counts[name] ?? 0
  const unchanged = (a, b, names = getters) => names.every(name => count(a, name) === count(b, name))
  const row = (id, status = 'running', workspace = game, taskId = 1) => ({ id, task_id: taskId, workspace, name: `Fixture command ${id}`, program: 'node', args: '[]', status, truncated: 0, exit_code: status === 'completed' ? 0 : status === 'failed' ? 1 : null, duration_ms: status === 'running' ? null : 100, error: null, started_at: '2026-01-01 00:00:00' })
  const stdout = (taskId = 1, targetGame = game, id = 500) => Array.from({ length: 100 }, (_, i) => ({ taskId, game: targetGame, commandOutput: { id, outputLength: i + 1, truncated: false } }))
  const run = value => control('run', value)
  const emit = values => control('emit', values)
  const append = (id, text, taskId = 1) => control('append', { taskId, id, text })
  const runDetails = id => `[...document.querySelectorAll('.command-result')].find(r=>r.querySelector('summary').textContent.startsWith('#${id} '))`
  const openRun = id => ev(`${runDetails(id)}.querySelector('summary').click()`)
  const text = id => `${runDetails(id)}?.querySelector('pre')?.textContent`
  const openTask = id => ev(`[...document.querySelectorAll('.task-row button.task,.ph-tasks button')].find(b=>b.textContent.includes('Fixture task ${id}')).click()`)
  const toggleHistory = () => ev("[...document.querySelectorAll('.project-commands details > summary')].find(s=>s.textContent.startsWith('Histórico desta tarefa')).click()")

  await click('button[aria-label="Início"]')
  await control('block', ['listBuildCommands'])
  await ev("[...document.querySelectorAll('.rail-ws')].find(b=>b.getAttribute('aria-label').startsWith('Sem organizador,')).click()")
  await wait("!!document.querySelector('.production')")
  await wait("window.invoke('loadingFixture','status').then(s=>s.pending.listBuildCommands===1)")
  const productionBefore = await control()
  await emit(stdout())
  check('Rajada de stdout nao recarrega os quatro catalogos de Producao', unchanged(productionBefore, await control()))
  await emit([{ taskId: 9, game: otherGame, commandChanged: true, commandRun: row(900, 'completed', otherGame, 9) }])
  await run(row(401, 'failed'))
  await run(row(402, 'cancelled'))
  await frames('true')
  check('Conclusoes de outro projeto, falha e cancelamento nao recarregam Producao', unchanged(productionBefore, await control()))
  await run(row(400, 'completed'))
  await wait("window.invoke('loadingFixture','status').then(s=>s.pending.listBuildCommands===2)")
  const completedState = await control()
  check('Conclusao com exit 0 recarrega somente os comandos elegiveis da build', count(completedState, 'listBuildCommands') === count(productionBefore, 'listBuildCommands') + 1 && unchanged(productionBefore, completedState, getters.filter(name => name !== 'listBuildCommands')))
  await control('releaseLast', ['listBuildCommands'])
  await frames('true')
  await control('release', ['listBuildCommands'])
  await wait("[...document.querySelectorAll('[aria-label=\"Comando da build\"] option')].some(o=>o.textContent.startsWith('#400 '))")
  check('Resposta inicial atrasada preserva a build concluida durante a consulta', await frames("[...document.querySelectorAll('[aria-label=\"Comando da build\"] option')].some(o=>o.textContent.startsWith('#400 '))"))

  await control('block', ['listCommandRuns'])
  await openTask(1)
  await wait("!!document.querySelector('.project-commands')")
  await wait("window.invoke('loadingFixture','status').then(s=>s.pending.listCommandRuns===1)")
  const taskBefore = await control()
  check('Historico fechado nao consulta saida nem monta logs e worktree', !count(taskBefore, 'commandOutput') && !count(taskBefore, 'worktreeCopy') && await ev("document.querySelectorAll('.project-commands pre').length===0"))
  await run(row(500))
  await wait("document.querySelector('.project-commands > summary').textContent.includes('Executando')")
  await run(row(500, 'completed'))
  await wait("!document.querySelector('.project-commands > summary').textContent.includes('Executando')")
  check('Eventos inicio e fim atualizam metadados sem reler historico/configuracao', unchanged(taskBefore, await control()) && (await control()).pending.listCommandRuns === 1)
  await click('.project-commands > summary')
  await wait("!!document.querySelector('.wt-copy')")
  await toggleHistory()
  await wait(`${runDetails(500)}?.textContent.includes('Concluído')`)
  await control('release', ['listCommandRuns'])
  check('Lista inicial atrasada nao sobrescreve a conclusao recebida por evento', await frames(`${runDetails(500)}?.textContent.includes('Concluído') && document.querySelectorAll('.command-result').length===20`))
  await toggleHistory()
  await wait("document.querySelectorAll('.command-result').length===0")
  const historyBefore = await control()
  await emit(stdout())
  await frames('true')
  check('Rajada de stdout com historico fechado nao consulta catalogos, configuracao ou logs', unchanged(historyBefore, await control()) && count(historyBefore, 'commandOutput') === count(await control(), 'commandOutput'))
  await emit([{ taskId: 2, game, commandChanged: true, commandRun: row(700, 'running', game, 2) }, ...stdout(2, game, 700)])
  await frames('true')
  check('Eventos de outra tarefa nao alteram os metadados desta tarefa', unchanged(historyBefore, await control()) && await ev("!document.querySelector('.project-commands > summary').textContent.includes('Executando')"))
  await emit([{ game: otherGame, commandConfigChanged: true }])
  await frames('true')
  check('Configuracao de outro projeto nao dispara consulta', unchanged(historyBefore, await control()))
  await emit([{ game, commandConfigChanged: true }])
  await wait(`window.invoke('loadingFixture','status').then(s=>(s.counts.projectCommands??0)===${count(historyBefore, 'projectCommands') + 1})`)
  const configured = await control()
  check('Evento de configuracao recarrega somente os comandos do projeto', count(configured, 'projectCommands') === count(historyBefore, 'projectCommands') + 1 && unchanged(historyBefore, configured, getters.filter(name => name !== 'projectCommands')))

  await toggleHistory()
  await wait("document.querySelectorAll('.command-result').length===20")
  check('Abrir historico sem expandir uma execucao ainda nao consulta saida', count(await control(), 'commandOutput') === 0 && await ev("document.querySelectorAll('.project-commands pre').length===0"))
  await append(500, 'primeira parte\n')
  await openRun(500)
  await wait(`${text(500)}==='primeira parte\\n'`)
  const firstLog = await control()
  check('Abrir uma execucao consulta somente seu log com offset zero', count(firstLog, 'commandOutput') === 1 && JSON.stringify(firstLog.calls.commandOutput) === JSON.stringify([[1, 500, 0]]))
  await append(500, 'segunda parte\n')
  await wait(`${text(500)}==='primeira parte\\nsegunda parte\\n'`)
  const secondLog = await control()
  check('Novas partes pedem somente os caracteres apos o offset conhecido', count(secondLog, 'commandOutput') === 2 && secondLog.calls.commandOutput[1][2] === 'primeira parte\n'.length && unchanged(firstLog, secondLog))
  await control('block', ['commandOutput'])
  await append(500, 'terceira parte\n')
  await wait("window.invoke('loadingFixture','status').then(s=>s.pending.commandOutput===1)")
  await append(500, 'quarta parte\n')
  check('Eventos durante getter de log pendente compartilham a consulta', (await control()).pending.commandOutput === 1 && count(await control(), 'commandOutput') === 3)
  await control('releaseNext', ['commandOutput'])
  await wait(`window.invoke('loadingFixture','status').then(s=>(s.counts.commandOutput??0)===4&&s.pending.commandOutput===1)`)
  const pendingLog = await control()
  check('Getter seguinte usa o offset recebido e preserva parte emitida durante espera', pendingLog.calls.commandOutput[3][2] === 'primeira parte\nsegunda parte\nterceira parte\n'.length)
  await control('release', ['commandOutput'])
  await wait(`${text(500)}==='primeira parte\\nsegunda parte\\nterceira parte\\nquarta parte\\n'`)
  check('Log aberto concatena todas as partes sem reler os catalogos', unchanged(secondLog, await control()))
  await control('block', ['commandOutput'])
  await append(500, 'resposta antiga ao fechar\n')
  await wait("window.invoke('loadingFixture','status').then(s=>s.pending.commandOutput===1)")
  await openRun(500)
  check('Fechar execucao desmonta o log mesmo com resposta pendente', await frames(`!${runDetails(500)}?.querySelector('pre')`))
  await control('release', ['commandOutput'])
  check('Resposta de log antigo nao reaparece apos fechar', await frames(`!${runDetails(500)}?.querySelector('pre')`))
  await openRun(500)
  await wait(`${text(500)}?.includes('resposta antiga ao fechar')`)
  await control('block', ['commandOutput'])
  await append(500, 'resposta antiga da tarefa\n')
  await wait("window.invoke('loadingFixture','status').then(s=>s.pending.commandOutput===1)")
  await openTask(2)
  await wait("window.invoke('loadingFixture','status').then(s=>s.calls.listCommandRuns.at(-1)?.[0]===2)")
  await control('release', ['commandOutput'])
  check('Trocar tarefa descarta resposta de log da tarefa anterior', await frames("![...document.querySelectorAll('.project-commands pre')].some(p=>p.textContent.includes('resposta antiga da tarefa')) && ![...document.querySelectorAll('.command-result summary')].some(s=>s.textContent.startsWith('#500 '))"))

  // Renderer sem trabalho repetido: eventos filtrados por tarefa/projeto, consultas compartilhadas e nada com a janela oculta.
  const callsOf = (state, name, pick = () => true) => (state.calls[name] ?? []).filter(pick).length
  const settle = () => sleep(400)
  await wait("!!document.querySelector('.composer') && !!document.querySelector('nav.chats')")
  const steps0 = await control()
  await emit([{ taskId: 1, game, done: true, status: 'completed' }, { refresh: true }])
  await settle()
  const steps1 = await control()
  check('Etapas nao recarregam com done de outra tarefa nem refresh global', count(steps1, 'listSteps') === count(steps0, 'listSteps'))
  await emit([{ taskId: 2, game, done: true, status: 'completed' }])
  await settle()
  const steps2 = await control()
  check('Etapas recarregam uma vez com done da propria tarefa', count(steps2, 'listSteps') === count(steps1, 'listSteps') + 1)
  check('Um done recarrega as conversas da outra pasta da gaveta uma vez so', callsOf(steps2, 'listTasks', a => a[0] === otherGame) === callsOf(steps1, 'listTasks', a => a[0] === otherGame) + 1)

  await ev("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))")
  // Oculta: o polling para, entao a contagem abaixo e so do evento (pedido de permissao nunca espera o polling).
  const perm0 = await control()
  await emit([{ permissionRequest: true, taskId: 2 }])
  await settle()
  check('Pedido de permissao consulta uma vez para o pop-up global e o cartao do chat juntos', count(await control(), 'listPermissionRequests') === count(perm0, 'listPermissionRequests') + 1)
  const hidden0 = await control()
  await sleep(4500)
  const hidden1 = await control()
  check('Janela oculta nao consulta agentes ativos nem permissoes', count(hidden1, 'listActive') === count(hidden0, 'listActive') && count(hidden1, 'listPermissionRequests') === count(hidden0, 'listPermissionRequests'))
  await ev("delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'))")
  await wait(`window.invoke('loadingFixture','status').then(s=>(s.counts.listActive??0)>${count(hidden1, 'listActive')})`)
  check('Voltar a ficar visivel consulta na hora', true)

  await ev(`[...document.querySelectorAll('.folder-name')].find(b=>b.dataset.path===${JSON.stringify(game)}).click()`)
  await wait("!document.querySelector('.composer') && !!document.querySelector('.home')")
  await settle()
  const git0 = await control()
  await emit([{ taskId: 9, game: otherGame, done: true, status: 'completed' }])
  await settle()
  const git1 = await control()
  check('done de outro projeto nao rele o Git deste', count(git1, 'projectInfo') === count(git0, 'projectInfo'))
  await emit([{ taskId: 1, game, done: true, status: 'completed' }])
  await settle()
  check('done do projeto rele o Git dele uma vez (Nova e visao geral dividem a consulta)', callsOf(await control(), 'projectInfo', a => a[0] === game) === callsOf(git1, 'projectInfo', a => a[0] === game) + 1)

  const allState = await control()
  check('Nenhuma CLI, rede ou login real foi chamado', !fs.existsSync(unexpectedCli) && allState.unexpected.length === 0)
  check('Electron sem excecoes nao tratadas', !/UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError/.test(log))
  passed = true
  console.log(`${checks.length}/${checks.length} verificacoes OK`)
} catch (error) {
  console.error(error.stack)
  console.error(log.slice(-1500))
  console.error('Fixture preservada para diagnostico:', work)
  process.exitCode = 1
} finally {
  socket?.close()
  if (app?.pid) {
    try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  if (passed && safeWork()) {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      // ponytail: caches do Chromium podem continuar bloqueados no Windows; limpar fixtures em lote se acumular.
      console.warn('Windows manteve arquivos temporarios bloqueados; fixture preservada.')
    }
  }
}
