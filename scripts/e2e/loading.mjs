// Regressao focal: Electron/React/IPC reais, dados de uso e diagnostico simulados.
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
for (const dir of [userdata, bin, home]) fs.mkdirSync(dir)
const unexpectedCli = path.join(work, 'unexpected-cli.log')
for (const provider of ['claude', 'codex', 'gemini', 'opencode']) {
  fs.writeFileSync(path.join(bin, `${provider}.cmd`), `@echo off\r\n>>"${unexpectedCli}" echo ${provider}\r\nexit /b 99\r\n`)
}
const entry = path.join(work, 'loading-ui.cjs')
fs.writeFileSync(entry, `
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  const counts = {}, blocked = new Set(), waiters = new Map(), unexpected = [];
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
  const fixtures = {
    diagnose: () => providers,
    accountStatus: () => ({ state: 'connected', plan: 'fixture' }),
    accountUsageSnapshot: () => quota, accountUsage: () => quota,
    codexUsage: () => quota, codexUsageSnapshot: () => quota,
    planetUsage: () => [], planetState: () => ({on: false, right: true, bottom: true}),
    catalog: provider => ({ provider, source: 'manual', at: new Date().toISOString(), models: [], efforts: [], allowCustomModel: true }),
    listGames: () => []
  };
  const gate = name => blocked.has(name) ? new Promise(resolve => {
    const list = waiters.get(name) ?? []; list.push(resolve); waiters.set(name, list);
  }) : Promise.resolve();
  for(const [name, fn] of Object.entries(fixtures)) {
    ipcMain.removeHandler(name);
    handle(name, async (_e, ...args) => { counts[name]=(counts[name]??0)+1; await gate(name); return fn(...args) });
  }
  for(const [name, fn] of locals) {
    ipcMain.removeHandler(name);
    handle(name, async (e, ...args) => { counts[name]=(counts[name]??0)+1; await gate(name); return fn(e, ...args) });
  }
  handle('loadingFixture', (_e, action, names=[]) => {
    if(action === 'block') names.forEach(name => blocked.add(name));
    if(action === 'release') names.forEach(name => { blocked.delete(name); for(const resolve of waiters.get(name)??[]) resolve(); waiters.delete(name) });
    return {counts, pending: Object.fromEntries([...waiters].map(([name,list])=>[name,list.length])), unexpected};
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

  await tab('Contas')
  await frames("!!document.querySelector('.prov')")
  await click('button[aria-label="Diagnosticar de novo"]')
  check('Atualizar diagnostico preserva o anterior enquanto consulta esta pendente', await frames("!!document.querySelector('.prov')?.textContent.includes('fixture-known') && !document.querySelector('.settings').textContent.includes('Consultando as CLIs')"))
  const finalState = await control()
  check('Refresh manual disparou exatamente um diagnostico pendente', finalState.pending.diagnose === 1 && finalState.counts.diagnose === before.counts.diagnose + 1)
  check('Nenhuma CLI, rede ou login real foi chamado', !fs.existsSync(unexpectedCli) && finalState.unexpected.length === 0)
  check('Electron sem excecoes nao tratadas', !/UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError/.test(log))
  await control('release', ['diagnose', 'accountUsage', 'accountStatus'])
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
