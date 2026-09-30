// E2E do app Electron real (build em out/: rode 'npm run build' antes) com CLIs falsas e um banco LEGADO sintetico.
// Nenhuma chamada paga e nenhum dado real: usa --user-data-dir temporario. Uso: npm run e2e
import { spawn, execSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-e2e-'))
const ud = path.join(work, 'userdata'), proj = path.join(work, 'projeto'), projGit = path.join(work, 'projgit'), bin = path.join(work, 'bin')
const logFile = path.join(work, 'argv.log'), pidsFile = path.join(work, 'pids.txt')
for (const d of [ud, proj, projGit, bin]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(projGit, 'a.txt'), 'x')
execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init', { cwd: projGit })
fs.writeFileSync(path.join(proj, 'roadmap.md'), '# Roadmap\n- [ ] x\n')
fs.writeFileSync(path.join(work, 'segredo.md'), 'fora do projeto')
fs.copyFileSync(path.join(here, 'fake-cli.js'), path.join(bin, 'fake-cli.js'))
for (const k of ['codex', 'opencode']) fs.writeFileSync(path.join(bin, `${k}.cmd`), `@echo off\r\nnode "%~dp0fake-cli.js" ${k} %*\r\n`)

// Banco LEGADO (so o esquema v1) com pin, chat geral e sessao.
const { MIGRATIONS } = await import(pathToFileURL(path.join(ROOT, 'src/main/db.ts')).href)
{
  const db = new DatabaseSync(path.join(ud, 'dashboard.db'))
  MIGRATIONS[0](db)
  db.prepare("INSERT INTO accounts (name, config_dir) VALUES ('Principal', NULL)").run()
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('extraGames', JSON.stringify([proj, projGit]))
  db.prepare("INSERT INTO pins (game, title, status) VALUES (?, 'Bug antigo', 'andamento')").run(proj)
  const key = `game:${proj}|codex|`
  db.prepare("INSERT INTO messages (chat_key, role, text) VALUES (?, 'user', 'pergunta legada')").run(key)
  db.prepare("INSERT INTO messages (chat_key, role, text) VALUES (?, 'agent', 'resposta legada')").run(key)
  db.prepare("INSERT INTO chats (key, session_id) VALUES (?, 'legacy-sess')").run(key)
  db.close()
}

const results = []
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let app
async function start(userData = ud, entry = ROOT) {
  const listener = createServer()
  await new Promise(r => listener.listen(0, '127.0.0.1', r))
  const port = listener.address().port
  await new Promise(r => listener.close(r)) // porta livre por instancia, sem colidir com outra sandbox/e2e
  // Sem ELECTRON_RENDERER_URL herdada (ex.: de um 'electron-vite dev' em execucao): o e2e testa o renderer COMPILADO em out/, nunca um servidor de desenvolvimento.
  const { ELECTRON_RENDERER_URL: _dev, ...cleanEnv } = process.env
  app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [entry, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env: { ...cleanEnv, PATH: `${bin};${process.env.PATH}`, E2E_LOG: logFile, E2E_PIDS: pidsFile, CODEX_HOME: path.join(work, 'codexhome'), ELECTRON_ENABLE_LOGGING: '1', GPD_DISPLAY: process.env.GPD_DISPLAY ?? '2' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  app.stdout.on('data', d => (log += d)); app.stderr.on('data', d => (log += d))
  app.log = () => log
  let page
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500)
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(p => p.type === 'page') } catch {}
  }
  if (!page) throw new Error('renderer nao abriu: ' + log.slice(-500))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(Error('timeout abrindo CDP')),10000);ws.onopen=()=>{clearTimeout(timer);resolve()};ws.onerror=()=>{clearTimeout(timer);reject(Error('erro abrindo CDP'))} })
  let id = 0; const pend = new Map()
  ws.onmessage = m => { const j = JSON.parse(m.data); pend.get(j.id)?.(j); pend.delete(j.id) }
  const send = (method, params) => new Promise((resolve,reject) => { const requestId=++id;const timer=setTimeout(()=>{pend.delete(requestId);reject(Error('timeout CDP: '+method))},20000);pend.set(requestId,r=>{clearTimeout(timer);resolve(r)});ws.send(JSON.stringify({id:requestId,method,params})) })
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'erro')
    return r.result.result.value
  }
  await sleep(1500)
  return { ws, ev, send, close: () => send('Page.close') }
}
// chama a ponte IPC real (preload + sandbox) e devolve {ok,value}|{ok:false,error}
const inv = (ev, name, ...args) => ev(`window.invoke(${JSON.stringify(name)}, ...${JSON.stringify(args)}).then(v => ({ ok: true, value: v }), e => ({ ok: false, error: String(e.message) }))`)
const waitDone = async (ev, taskId, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const c = (await inv(ev, 'taskChat', taskId, { provider: 'codex' })).value; if (c && !c.running) return c; await sleep(300) } throw new Error('timeout') }
const argvLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []).filter(c => c.argv.includes('--json') || c.argv.includes('--format'))
// Envio em fluxos que NAO testam consentimento: se a mensagem ficar retida por contexto pendente, o "usuario" decide (padrao: executar sem contexto)
// e o resultado devolvido e o da decisao. Os fluxos de consentimento chamam sendTask/decideSend diretamente.
const sendD = async (ev, tid, sel, text, decision = 'reject') => {
  const r = await inv(ev, 'sendTask', tid, sel, text)
  if (r.ok && r.value?.status === 'awaiting_context_approval') {
    const pk = (await inv(ev, 'listContextPackages', tid)).value.find(p => p.id === r.value.packageId)
    return inv(ev, 'decideSend', r.value.sendId, pk.hash, decision)
  }
  return r
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const kill = () => { try { execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }) } catch {} }

try {
  // ---- primeira abertura: pasta de dados nova (sem banco, sem contas, sem tarefas)
  {
    const fresh = path.join(work, 'fresh')
    fs.mkdirSync(fresh)
    const f = await start(fresh)
    const txt = await f.ev('document.body.innerText')
    const shot = (await f.send('Page.captureScreenshot', { format: 'png' })).result.data
    fs.mkdirSync(path.join(os.tmpdir(), 'gpd-e2e-shots'), { recursive: true })
    fs.writeFileSync(path.join(os.tmpdir(), 'gpd-e2e-shots', 'primeira-abertura.png'), Buffer.from(shot, 'base64'))
    check('primeira abertura: abre em Pastas/Configuracoes sem erro e sem tela de marketing', /pastas|projetos/i.test(txt) && /Configura/.test(txt) && !/bem-vindo|comece agora|assine/i.test(txt), JSON.stringify(txt.slice(0, 60)))
    check('primeira abertura: interface pede um projeto e nao ha botao de login fora de Configuracoes', /Escolha um projeto|Adicionar pasta/.test(txt) && !/login/i.test(txt))
    kill()
    await sleep(1500)
    const db0 = new DatabaseSync(path.join(fresh, 'dashboard.db'))
    check('primeira abertura: banco criado na versao atual com a conta Principal e sem backup desnecessario', db0.prepare('PRAGMA user_version').get().user_version === MIGRATIONS.length && db0.prepare('SELECT name FROM accounts').all().map(a => a.name).join() === 'Principal' && !fs.readdirSync(fresh).some(n => n.endsWith('.bak')))
    db0.close()
  }
  let { ev, send, close } = await start()
  const ui = await ev("document.querySelector('.app .rail .projects') ? document.body.innerText.slice(0, 400) : 'sem .app'")
  check('renderer carregou dentro do Electron (sandbox+preload)', /Configura/.test(ui) && /Início/.test(ui), JSON.stringify(ui.slice(0, 80)))

  const games = (await inv(ev, 'listGames')).value
  check('listGames devolve o projeto adicionado', games?.some(g => g.toLowerCase() === proj.toLowerCase().replace(/\//g, '\\')) || games?.includes(proj), JSON.stringify(games))
  const gameArg = games.find(g => g.toLowerCase().endsWith('projeto'))
  const tasks = (await inv(ev, 'listTasks', gameArg, {})).value
  check('migracao real: pin e chat geral viraram tarefas', tasks?.length === 2 && tasks.some(t => t.legacy === 'pin') && tasks.some(t => t.title === 'Chat legado: codex'), JSON.stringify(tasks?.map(t => [t.title, t.legacy, t.messages])))
  const legacy = tasks.find(t => t.legacy === 'chat')

  // ---- validacao da ponte IPC
  const bad = [
    ['readDoc com ..', await inv(ev, 'readDoc', gameArg, '../segredo.md')],
    ['listDocs fora dos projetos', await inv(ev, 'listDocs', 'C:/Windows')],
    ['openFolder fora dos projetos', await inv(ev, 'openFolder', 'C:/Windows')],
    ['tipo invalido em taskChat', await inv(ev, 'taskChat', '1; drop', { provider: 'codex' })],
    ['provedor desconhecido', await inv(ev, 'sendTask', legacy.id, { provider: 'rm -rf' }, 'oi')],
    ['tarefa inexistente', await inv(ev, 'sendTask', 99999, { provider: 'codex' }, 'oi')],
    ['status de pin invalido', await inv(ev, 'setPinStatus', 1, 'hackeado')],
    ['writeDoc nao .md', await inv(ev, 'writeDoc', gameArg, 'x.exe', 'oi')],
    ['canal inexistente', await inv(ev, 'canalQueNaoExiste')]
  ]
  for (const [n, r] of bad) check(`IPC recusa: ${n}`, r.ok === false, r.error?.slice(0, 90))
  check('IPC aceita leitura valida', (await inv(ev, 'readDoc', gameArg, 'roadmap.md')).value?.startsWith('# Roadmap'))

  // ---- retomada exata da sessao legada + sem transferencia de contexto
  await inv(ev, 'sendTask', legacy.id, { provider: 'codex' }, 'segue a conversa')
  let c = await waitDone(ev, legacy.id)
  let calls = argvLog()
  const c1 = calls[0]
  check('codex retoma a sessao LEGADA exata e usa --skip-git-repo-check', c1.argv.join(' ').includes('resume legacy-sess') && c1.argv.includes('--skip-git-repo-check') && c1.argv.at(-1) === '-', c1.argv.join(' '))
  check('mensagem vai pelo stdin (nao pela linha de comando) e sem contexto transferido', c1.input === 'segue a conversa' && !c1.argv.join(' ').includes('segue'), JSON.stringify(c1.input.slice(0, 60)))
  check('resposta gravada como concluida na tarefa', c.messages.at(-1).status === 'completed' && /eco\(codex\)/.test(c.messages.at(-1).text) && c.messages.length === 4)

  // ---- tarefa nova: sessao nova, depois retomada; troca de provedor com contexto explicito
  const tid = (await inv(ev, 'createTask', gameArg)).value
  await inv(ev, 'sendTask', tid, { provider: 'codex' }, 'primeira mensagem')
  await waitDone(ev, tid)
  await inv(ev, 'sendTask', tid, { provider: 'codex' }, 'segunda mensagem')
  c = await waitDone(ev, tid)
  calls = argvLog()
  const [n1, n2] = calls.slice(-2)
  check('tarefa nova comeca sessao nativa nova (sem resume)', !n1.argv.includes('resume'), n1.argv.join(' '))
  check('segunda mensagem retoma EXATAMENTE a sessao criada', n2.argv.join(' ').includes('resume fake-codex-thread'), n2.argv.join(' '))
  check('titulo automatico da tarefa', c.task.title === 'primeira mensagem', c.task.title)

  // ---- Aprovar contexto ANTES de iniciar o trabalho que depende dele (troca de provedor): a mensagem fica retida, nenhum processo e iniciado,
  // e o usuario decide: aprovar e executar, executar sem contexto ou cancelar.
  let nBefore = argvLog().length
  const held = await inv(ev, 'sendTask', tid, { provider: 'opencode' }, 'agora no opencode')
  check('troca de provedor: a mensagem fica RETIDA aguardando a decisao (nenhum processo foi iniciado)', held.ok && held.value.status === 'awaiting_context_approval' && argvLog().length === nBefore, JSON.stringify(held.value ?? held.error))
  await sleep(1500) // se algum processo fosse iniciar por conta propria, ja teria iniciado
  c = (await inv(ev, 'taskChat', tid, { provider: 'opencode' })).value
  check('antes da decisao: zero execucao, tarefa reservada e a mensagem do usuario ainda NAO entrou no historico', argvLog().length === nBefore && c.running === false && c.awaitingContext === true && !c.messages.some(m => m.text === 'agora no opencode'), JSON.stringify({ n: argvLog().length - nBefore, running: c.running, awaiting: c.awaitingContext }))
  const hp = (await inv(ev, 'listContextPackages', tid)).value
  check('pedido pendente mostra conteudo integral, destinatario completo (provedor, perfil, modelo, pasta, escopo) e hash', hp.length === 1 && hp[0].state === 'pending' && hp[0].source === 'history' && hp[0].recipient.provider === 'opencode' && 'profile' in hp[0].recipient && 'model' in hp[0].recipient && hp[0].recipient.workspace.toLowerCase().endsWith('projeto') && Array.isArray(hp[0].recipient.scope) && hp[0].items[0].content.includes('primeira mensagem') && /^[0-9a-f]{64}$/.test(hp[0].hash), JSON.stringify(hp[0]?.recipient))
  const sends1 = (await inv(ev, 'listPendingSends', tid)).value
  check('o envio retido guarda a mensagem e o destino escolhido; consentimento e entrega ainda separados (nada aprovado nem enviado)', sends1.length === 1 && sends1[0].state === 'awaiting_context_approval' && sends1[0].text === 'agora no opencode' && sends1[0].sel.provider === 'opencode' && hp[0].delivery.confirmed === 0 && hp[0].delivery.sent === 0, JSON.stringify(sends1[0]))
  const dup = await inv(ev, 'sendTask', tid, { provider: 'opencode' }, 'clique duplo')
  const wrongSel = await inv(ev, 'sendTask', tid, { provider: 'codex' }, 'mudei a selecao')
  check('segundo envio (clique duplo ou outra selecao) enquanto aguarda e recusado: a tarefa esta reservada', dup.ok === false && wrongSel.ok === false && /aguardando a sua decisao/.test(dup.error) && argvLog().length === nBefore, dup.error?.slice(0, 80))
  const viaPkg = await inv(ev, 'resolveContextPackage', hp[0].id, hp[0].hash, 'approve')
  check('o pedido de uma mensagem retida so se decide pelo cartao do envio (nao pelo pacote solto)', viaPkg.ok === false && /mensagem retida/.test(viaPkg.error), viaPkg.error?.slice(0, 80))
  const badHash = await inv(ev, 'decideSend', sends1[0].id, 'f'.repeat(64), 'approve')
  check('decisao com hash divergente e recusada no processo principal e nada inicia', badHash.ok === false && /hash divergente/.test(badHash.error) && argvLog().length === nBefore && (await inv(ev, 'listContextPackages', tid)).value[0].state === 'pending', badHash.error?.slice(0, 100))
  // cancelar: nenhum processo, texto recuperavel, pedido invalido (aprovar depois nao autoriza nada)
  const cx = await inv(ev, 'decideSend', sends1[0].id, hp[0].hash, 'cancel')
  const lateApprove = await inv(ev, 'resolveContextPackage', hp[0].id, hp[0].hash, 'approve')
  const sendsC = (await inv(ev, 'listPendingSends', tid)).value
  check('cancelar o envio: nenhum processo, pedido invalido e a mensagem continua recuperavel', cx.ok && argvLog().length === nBefore && lateApprove.ok === false && /ja foi resolvido/.test(lateApprove.error) && sendsC.length === 1 && sendsC[0].state === 'cancelled' && sendsC[0].text === 'agora no opencode', JSON.stringify({ cx: cx.value, late: lateApprove.error?.slice(0, 60) }))
  check('recuperar o texto devolve exatamente a mensagem e a tira da lista (nada foi enviado)', (await inv(ev, 'recoverSend', sendsC[0].id)).value === 'agora no opencode' && (await inv(ev, 'listPendingSends', tid)).value.length === 0 && argvLog().length === nBefore)
  // reenviar depois de cancelar: novo pedido (cancelar nao e recusar), decidido com a selecao da TELA trocada: a decisao vale no destino original
  const held2 = await inv(ev, 'sendTask', tid, { provider: 'opencode' }, 'agora no opencode')
  const hp2 = (await inv(ev, 'listContextPackages', tid)).value.find(p => p.state === 'pending')
  check('cancelar nao e recusa: reenviar gera um novo pedido pendente', held2.ok && held2.value.status === 'awaiting_context_approval' && held2.value.sendId !== held.value.sendId && !!hp2 && hp2.id !== hp[0].id, JSON.stringify(held2.value))
  await inv(ev, 'setTaskSel', tid, { provider: 'codex' }) // o usuario mexe na selecao enquanto aguarda
  nBefore = argvLog().length
  const [ap1, ap2] = await Promise.all([inv(ev, 'decideSend', held2.value.sendId, hp2.hash, 'approve'), inv(ev, 'decideSend', held2.value.sendId, hp2.hash, 'approve')]) // clique duplo
  c = await waitDone(ev, tid)
  await sleep(600)
  const oc = argvLog().slice(nBefore)
  check('aprovar e executar (clique duplo): UMA unica execucao, no destino ORIGINAL (opencode), nunca no que estava na tela', ap1.ok && ap2.ok && oc.length === 1 && oc[0].kind === 'opencode', JSON.stringify({ n: oc.length, kinds: oc.map(x => x.kind), a: [ap1.value?.state ?? ap1.error, ap2.value?.state ?? ap2.error] }))
  check('so DEPOIS da aprovacao o processo recebe o pacote exato e a mensagem (sessao do opencode e nova)', oc[0].input.includes('[Contexto aprovado pelo usuario') && oc[0].input.includes('primeira mensagem') && oc[0].input.endsWith('agora no opencode') && !oc[0].argv.includes('--session') && !oc[0].argv.join(' ').includes('fake-codex-thread'), JSON.stringify(oc[0].input.slice(0, 100)))
  check('a mensagem do usuario entra no historico so agora e o historico segue inteiro e rotulado por provedor', c.messages.filter(m => m.text === 'agora no opencode').length === 1 && c.messages.filter(m => m.role === 'agent').map(m => m.provider).join(',') === 'codex,codex,opencode', c.messages.filter(m => m.role === 'agent').map(m => m.provider).join(','))
  const pk = (await inv(ev, 'listContextPackages', tid)).value.find(p => p.id === hp2.id)
  check('consentimento e entrega distintos: pacote aprovado E entregue (confirmado apos a execucao concluir)', pk.state === 'approved' && pk.delivery.confirmed === 1 && pk.delivery.failed === 0, JSON.stringify({ state: pk.state, d: pk.delivery }))
  await inv(ev, 'setTaskSel', tid, { provider: 'opencode' })
  await inv(ev, 'sendTask', tid, { provider: 'opencode' }, 'de novo no opencode')
  await waitDone(ev, tid)
  const oc2 = argvLog().at(-1)
  check('opencode retoma a propria sessao e nao reenvia o pacote ja entregue (nem pede nova decisao)', oc2.argv.join(' ').includes('--session ses_fakeopencode') && !oc2.input.includes('Contexto aprovado') && !oc2.input.includes('Contexto transferido') && oc2.input.endsWith('de novo no opencode'), oc2.argv.join(' '))
  await inv(ev, 'sendTask', tid, { provider: 'opencode' }, 'terceira no opencode')
  await waitDone(ev, tid)
  check('pacote ja entregue nao e reenviado (entrega deduplicada por sessao)', !argvLog().at(-1).input.includes('Contexto aprovado'), argvLog().at(-1).input.slice(0, 60))
  // recusa: executar sem contexto. O agente roda so com o texto do usuario e o contexto recusado nao volta a ser pedido nem enviado.
  const tR = (await inv(ev, 'createTask', gameArg, 'recusa')).value
  await inv(ev, 'sendTask', tR, { provider: 'codex' }, 'ORIGEM secreta do historico')
  await waitDone(ev, tR)
  nBefore = argvLog().length
  const heldR = await inv(ev, 'sendTask', tR, { provider: 'opencode' }, 'segue sem historico')
  const hpR = (await inv(ev, 'listContextPackages', tR)).value[0]
  const noCtx = await inv(ev, 'decideSend', heldR.value.sendId, hpR.hash, 'reject')
  await waitDone(ev, tR)
  const ocR = argvLog().slice(nBefore)
  check('recusa (executar sem contexto): uma execucao so com o texto do usuario, sem nada do historico recusado', noCtx.ok && ocR.length === 1 && ocR[0].kind === 'opencode' && !/ORIGEM|Contexto (aprovado|transferido)/.test(ocR[0].input) && ocR[0].input.endsWith('segue sem historico') && (await inv(ev, 'listContextPackages', tR)).value[0].state === 'rejected', JSON.stringify(ocR[0]?.input.slice(0, 80)))
  await inv(ev, 'sendTask', tR, { provider: 'opencode' }, 'outra depois da recusa')
  await waitDone(ev, tR)
  check('depois da recusa o agente segue sem contexto e o dashboard nao insiste (sem novo pedido nem envio retido)', !argvLog().at(-1).input.includes('ORIGEM') && (await inv(ev, 'listContextPackages', tR)).value.every(p => p.state !== 'pending') && (await inv(ev, 'listPendingSends', tR)).value.length === 0)
  // outra tarefa no mesmo projeto: historico e sessoes separados
  const tid2 = (await inv(ev, 'createTask', gameArg, 'outra')).value
  await inv(ev, 'sendTask', tid2, { provider: 'codex' }, 'mensagem da outra')
  const c2 = await waitDone(ev, tid2)
  check('duas tarefas do mesmo projeto nao compartilham historico nem sessao', c2.messages.every(m => !/primeira|opencode/.test(m.text)) && !argvLog().at(-1).argv.includes('resume'), argvLog().at(-1).argv.join(' '))

  // ---- Fase 5: catalogos nativos, modelo/esforco por execucao e medidas de contexto
  const cCodex = (await inv(ev, 'catalog', 'codex')).value
  check('codex: catalogo vem do App Server (paginado, sem modelos ocultos) com esforcos por modelo', cCodex.source === 'native' && cCodex.models.map(m => m.id).join(',') === 'gpt-6-luna,gpt-5.5' && cCodex.models[0].efforts.join() === 'low,medium,high', JSON.stringify(cCodex.models.map(m => [m.id, m.efforts])))
  const cOc = (await inv(ev, 'catalog', 'opencode')).value
  const dsm = cOc.models.find(m => m.id === 'deepseek/deepseek-flash')
  check('opencode: modelos de provedores com credencial, variantes e janela do catalogo', dsm?.efforts.join() === 'low,high,max' && dsm.contextWindow === 1000000 && cOc.models.some(m => m.id === 'opencode/big-pickle'), JSON.stringify(cOc.models.map(m => m.id)))
  const cGem = (await inv(ev, 'catalog', 'gemini')).value
  check('gemini: sem descoberta e sem esforco (nada nao comprovado e oferecido)', cGem.source === 'manual' && cGem.efforts.length === 0 && cGem.allowCustomModel, cGem.note?.slice(0, 60))
  const cClaude = (await inv(ev, 'catalog', 'claude')).value
  {
    const j = (await inv(ev, 'getJarvisSettings')).value
    const empty = await inv(ev, 'askJarvis', '   ', [], [])
    check('jarvis: padrao Sonnet 5.5 em esforco medio na conta principal; pergunta vazia e recusada sem chamar a CLI', j?.model === 'claude-sonnet-5-5' && j?.effort === 'medium' && !!j?.accountId && !empty.ok, JSON.stringify({ j, empty: empty.error }))
  }
  // Unica verificacao com a CLI real (so --help, gratis). Sem claude instalado (runner do CI) ela nao prova nada: fica de fora, sem contar como falha.
  let hasClaude = true; try { execFileSync('where.exe', ['claude'], { stdio: 'ignore' }) } catch { hasClaude = false }
  if (!hasClaude) console.log('SKIP claude (CLI real, so --help): claude nao instalado')
  else check('claude (CLI real, so --help): apelidos e niveis de esforco lidos da versao instalada', cClaude.source === 'help' && cClaude.models.some(m => m.id === 'opus') && cClaude.efforts.includes('max'), JSON.stringify({ models: cClaude.models.map(m => m.id), efforts: cClaude.efforts }))

  const t5 = (await inv(ev, 'createTask', gameArg, 'config')).value
  const rejects = [
    ['modelo fora do catalogo (codex)', { provider: 'codex', model: 'gpt-inexistente' }],
    ['esforco nao suportado pelo modelo', { provider: 'codex', model: 'gpt-5.5', effort: 'high' }],
    ['esforco sem modelo (depende do modelo)', { provider: 'codex', effort: 'high' }],
    ['esforco no gemini', { provider: 'gemini', model: 'gemini-x', effort: 'high' }],
    ['id com caracteres perigosos', { provider: 'codex', model: 'gpt-6-luna & calc' }]
  ]
  for (const [n, s] of rejects) { const x = await inv(ev, 'setTaskSel', t5, s); check(`selecao recusada: ${n}`, x.ok === false, x.error?.slice(0, 90)) }
  const sane = await inv(ev, 'sendTask', t5, { provider: 'codex', model: 'gpt-inexistente' }, 'nao deve rodar')
  check('enviar com modelo invalido e recusado antes de qualquer execucao', sane.ok === false && (await inv(ev, 'taskChat', t5, { provider: 'codex' })).value.messages.length === 0)

  const n0 = argvLog().length
  await inv(ev, 'sendTask', t5, { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, 'com luna')
  c = await waitDone(ev, t5)
  const lc = argvLog().slice(n0)[0]
  check('codex recebe modelo e esforco escolhidos (-m e model_reasoning_effort)', lc.argv.join(' ').includes('-m gpt-6-luna -c model_reasoning_effort=high') && lc.argv.at(-1) === '-', lc.argv.join(' '))
  const am = c.messages.filter(m => m.role === 'agent').at(-1)
  check('modelo e esforco ficam gravados na execucao/mensagem e a escolha persiste na tarefa', am.model === 'gpt-6-luna' && am.effort === 'high' && c.sel.model === 'gpt-6-luna' && c.sel.effort === 'high', JSON.stringify({ m: am.model, e: am.effort, sel: c.sel }))
  check('contexto do codex: ocupado e janela vem do arquivo da sessao, marcado como estimado, com fonte', c.metric?.occupied === 4000 && c.metric?.capacity === 272000 && c.metric?.estimated === true && /sessao do Codex/.test(c.metric.source), JSON.stringify(c.metric))
  check('consumo fica separado do contexto e identificado como acumulado do thread', c.metric?.consumed_in === 5000 && c.metric?.scope === 'thread')

  await sendD(ev, t5, { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'max' }, 'no deepseek')
  c = await waitDone(ev, t5)
  const oc5 = argvLog().at(-1)
  check('opencode recebe -m provedor/modelo e --variant', oc5.argv.join(' ').includes('-m deepseek/deepseek-flash --variant max'), oc5.argv.join(' '))
  c = (await inv(ev, 'taskChat', t5, { provider: 'opencode', model: 'deepseek/deepseek-flash' })).value
  check('opencode: contexto e aproximacao (entrada+cache), janela vem do catalogo', c.metric?.occupied === 1500 && c.metric?.estimated === true && c.metric?.capacity === 1000000 && /catalogo/.test(c.metric.source), JSON.stringify(c.metric))

  await sendD(ev, t5, { provider: 'codex' }, 'sem escolha')
  await waitDone(ev, t5)
  const dflt = argvLog().at(-1)
  check('sem escolha: nenhum -m/esforco e injetado (padrao da propria CLI)', !dflt.argv.includes('-m') && !dflt.argv.join(' ').includes('model_reasoning_effort'), dflt.argv.join(' '))
  c = (await inv(ev, 'taskChat', t5, { provider: 'codex' })).value
  check('mudar de modelo invalida contexto anterior (ausencia nao vira 0)', c.metric.model === null && c.metric.occupied === 4000, JSON.stringify({ model: c.metric.model, occ: c.metric.occupied }))

  // a execucao ativa mantem a configuracao original mesmo que a escolha mude no meio
  await inv(ev, 'sendTask', t5, { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, 'TRAVAR com luna')
  for (let i = 0; i < 40 && !(await inv(ev, 'taskChat', t5, { provider: 'codex' })).value.live.includes('parcial'); i++) await sleep(250)
  const mid = await inv(ev, 'setTaskSel', t5, { provider: 'codex', model: 'gpt-5.5', effort: 'medium' })
  await inv(ev, 'stopTask', t5)
  c = await waitDone(ev, t5)
  const cancelled = c.messages.filter(m => m.status === 'cancelled').at(-1)
  check('execucao ativa mantem modelo/esforco originais; a nova escolha vale so na proxima', mid.ok && cancelled.model === 'gpt-6-luna' && cancelled.effort === 'low' && c.sel.model === 'gpt-5.5', JSON.stringify({ run: [cancelled.model, cancelled.effort], sel: c.sel.model }))

  // ---- Fase 6: delegacao pai (codex) -> filho (opencode) pela ferramenta MCP local do dashboard
  const tD = (await inv(ev, 'createTask', gameArg, 'delegacao')).value
  const deleg = async (specs, tid = tD) => {
    const n = argvLog().length
    const s = await inv(ev, 'sendTask', tid, { provider: 'codex' }, 'DELEGAR:' + JSON.stringify(specs))
    if (!s.ok) return { err: s.error }
    const chat = await waitDone(ev, tid)
    return { chat, text: chat.messages.filter(m => m.role === 'agent').at(-1).text, calls: argvLog().slice(n) }
  }
  const delegs = async (tid = tD) => (await inv(ev, 'listDelegations', tid)).value
  const runningDeleg = async (tid = tD) => { for (let i = 0; i < 60; i++) { if ((await delegs(tid))[0]?.status === 'running' && fs.existsSync(pidsFile)) return; await sleep(250) } throw new Error('delegacao nao ficou ativa') }

  let d = await deleg([{ objective: 'leia src e resuma', provider: 'opencode', mode: 'read' }])
  const [parentCall, childCall] = d.calls
  check('pai recebe a ferramenta MCP por -c e variavel de ambiente (token nunca na linha de comando)',
    parentCall.argv.some(a => /^mcp_servers\.dashboard\.url=http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(a)) && parentCall.argv.includes('mcp_servers.dashboard.bearer_token_env_var=DASHBOARD_MCP_TOKEN') && parentCall.env.hasToken && !/[0-9a-f]{40}/.test(parentCall.argv.join(' ')), parentCall.argv.join(' ').slice(0, 200))
  // O filho recebe so as ferramentas de contexto do papel dele (o servidor MCP nao anuncia nem aceita delegate_to_agent com o token de filho: mcp.test.ts).
  check('leitura: o filho roda no provedor pedido, na pasta da tarefa, com MCP de contexto (token so na configuracao inline)',
    childCall?.kind === 'opencode' && childCall.cwd.toLowerCase() === proj.toLowerCase() && !childCall.env.hasToken && /"mcp":\{"dashboard"/.test(String(childCall.env.ocConfig)) && !childCall.argv.some(a => /mcp/.test(a)), JSON.stringify(childCall?.env).slice(0, 120))
  check('leitura efetiva: opencode recebe edit/bash/write negados por configuracao MESMO com o MCP (mescladas, nao so por prompt)', /"edit":"deny"/.test(childCall.env.ocConfig) && /"bash":"deny"/.test(childCall.env.ocConfig) && /"write":"deny"/.test(childCall.env.ocConfig))
  check('o filho recebe objetivo e proibicao de delegar; o resultado volta ao pai como envelope da ferramenta', /SOMENTE LEITURA/.test(childCall.input) && /Voce nao pode delegar/.test(childCall.input) && /eco\(opencode\)/.test(d.text) && /\[Delegacao #\d+ concluida\]/.test(d.text) && /Detalhes completos: artefato #\d+/.test(d.text), d.text.slice(0, 160))
  check('atividade da delegacao visivel no chat do pai (inicio e fim)', d.chat.messages.filter(m => m.role === 'system' && /Delegacao #/.test(m.text)).length === 2)
  const dl0 = (await delegs())[0]
  check('delegacao registrada (estado, modo, provedor)', dl0.status === 'completed' && dl0.mode === 'read' && dl0.provider === 'opencode' && dl0.consumed != null, JSON.stringify(dl0.consumed))

  // ---- Skills sob demanda no build COMPILADO (out/): o pai carrega delegacao e memoria, o filho so memoria, e nada disso entra no prompt por padrao
  {
    const tS = (await inv(ev, 'createTask', gameArg, 'skills')).value
    const calls = ['task-delegation', 'task-memory', 'task-memory', '../../package.json', 'dashboard-token-efficiency'].map(name => ({ name: 'read_task_skill', arguments: { name } }))
    const nS = argvLog().length
    await inv(ev, 'sendTask', tS, { provider: 'codex' }, 'MCPCALLS:' + JSON.stringify(calls))
    const cs = await waitDone(ev, tS)
    const parts = cs.messages.filter(m => m.role === 'agent').at(-1).text.split('\n\n---\n\n')
    const promptIn = argvLog().slice(nS)[0].input
    check('skills sob demanda (compilado): o pai carrega delegacao e memoria dos recursos empacotados e a repeticao nao reenvia o texto', /TOOLS:.*read_task_skill/.test(parts[0]) && /Skill task-delegation \(versao [0-9a-f]{12}\)[\s\S]*# Delegar com economia/.test(parts[1]) && /Skill task-memory \(versao [0-9a-f]{12}\)[\s\S]*# Memoria da tarefa/.test(parts[2]) && /ja foi carregada nesta sessao; o texto nao foi reenviado/.test(parts[3]), JSON.stringify(parts.map(p => p.slice(0, 70))))
    check('skills: caminho arbitrario e a skill geral sao recusados; nenhum texto de skill vai no prompt (so o ponteiro)', /\[ERRO\][\s\S]*name invalido/.test(parts[4]) && /\[ERRO\]/.test(parts[5]) && !/# Memoria da tarefa|# Delegar com economia/.test(promptIn) && /read_task_skill \(task-memory, task-delegation, ponytail, linkedin\)/.test(promptIn), promptIn.slice(0, 120))
    const dS = await deleg([{ objective: 'SKILLCHILD', provider: 'opencode', mode: 'read' }], tS)
    check('skills: o filho ve read_task_skill, carrega a memoria e NAO ganha a skill de delegacao nem delegate_to_agent', /filho: ferramentas=[^\n]*read_task_skill/.test(dS.text) && !/filho: ferramentas=[^\n]*delegate_to_agent/.test(dS.text) && /memoria: Skill task-memory \(versao/.test(dS.text) && /delegacao: \[ERRO\] [^\n]*nao esta disponivel para o seu papel/.test(dS.text), dS.text.slice(0, 300))
  }

  d = await deleg([{ objective: 'ESCREVER:src/x.txt implemente', provider: 'opencode', mode: 'edit', paths: ['src'] }])
  check('edicao delimitada: arquivos alterados listados e o que saiu do escopo sinalizado', /Arquivos alterados: 2: fora-do-escopo\.txt, src\/x\.txt/.test(d.text) && /FORA DO ESCOPO: fora-do-escopo\.txt/.test(d.text) && !/deny/.test(String(d.calls[1].env.ocConfig ?? '')), d.text.slice(-220))
  d = await deleg([{ objective: 'ESCREVER:lixo.txt so leia', provider: 'opencode', mode: 'read' }])
  check('leitura que escreveu mesmo assim e denunciada', /ATENCAO: o modo leitura alterou arquivos/.test(d.text))

  d = await deleg([
    { objective: 'x', provider: 'codex', model: 'modelo-inexistente' },
    { objective: 'x', provider: 'opencode', paths: ['../../segredo'] },
    { objective: 'x', provider: 'opencode', model: 'nao/existe' },
    { objective: 'x', provider: 'opencode', cwd: 'C:/Windows', command: 'calc' }
  ])
  const parts = d.text.split('---')
  check('modelo ausente do catalogo: bloqueio informado, sem substituicao', /\[ERRO\][\s\S]*nao consta no catalogo[\s\S]*Nenhuma substituicao/.test(parts[0]), parts[0].slice(0, 200))
  check('tentativa de escapar do escopo (../) recusada', /\[ERRO\][\s\S]*fora da area/.test(parts[1]))
  check('modelo desconhecido no opencode tambem recusado', /nao consta no catalogo/.test(parts[2]))
  check('campos extras (cwd/comando) sao ignorados: o filho roda na pasta da tarefa', !/\[ERRO\]/.test(parts[3]) && /concluida/.test(parts[3]))
  const mcpUrl = parentCall.argv.find(a => a.startsWith('mcp_servers.dashboard.url=')).slice('mcp_servers.dashboard.url='.length)
  const noTok = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  const badTok = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + '0'.repeat(48) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  check('servidor MCP recusa chamadas sem token ou com token invalido/expirado (401)', noTok.status === 401 && badTok.status === 401, `${noTok.status}/${badTok.status}`)
  await inv(ev, 'setDelegationSettings', { allowedProviders: ['claude', 'codex'] })
  d = await deleg([{ objective: 'x', provider: 'opencode' }])
  check('compartilhamento restrito nas configuracoes e respeitado', /nao esta permitido/.test(d.text), d.text.slice(0, 160))
  await inv(ev, 'setDelegationSettings', {})

  // Agentes nomeados: "Leitor" = opencode / deepseek/deepseek-flash. O agente diz so o nome; o dashboard resolve provedor e modelo.
  const badAl = await inv(ev, 'setAgentAliases', [{ name: 'Leitor', provider: 'opencode', model: 'nao/existe' }])
  check('agente nomeado com modelo fora do catalogo e recusado ao salvar (nada gravado)', badAl.ok === false && /nao consta no catalogo/.test(badAl.error) && (await inv(ev, 'getAgentAliases')).value.length === 0, badAl.error?.slice(0, 120))
  const dupAl = await inv(ev, 'setAgentAliases', [{ name: 'Leitor', provider: 'opencode', model: 'deepseek/deepseek-flash' }, { name: 'LEITOR', provider: 'codex', model: 'gpt-6-luna' }])
  check('nome repetido (caixa/acento) e recusado', dupAl.ok === false && /Nome repetido/.test(dupAl.error))
  const okAl = await inv(ev, 'setAgentAliases', [{ name: 'Leitor', provider: 'opencode', model: 'deepseek/deepseek-flash' }])
  check('agente nomeado salvo e listado', okAl.ok && (await inv(ev, 'getAgentAliases')).value[0]?.name === 'Leitor')
  d = await deleg([{ objective: 'leia src e resuma', agent: 'leitor' }])
  const aliasCall = d.calls[1]
  check('delegar por nome: o filho roda em opencode com o modelo do agente, sem o usuario digitar o id', aliasCall?.kind === 'opencode' && aliasCall.argv.join(' ').includes('-m deepseek/deepseek-flash') && /\[Delegacao #\d+ concluida\]/.test(d.text), aliasCall?.argv.join(' '))
  check('anotacao no chat cita o nome do agente', d.chat.messages.some(m => m.role === 'system' && /para Leitor = opencode\/deepseek\/deepseek-flash/.test(m.text)))
  d = await deleg([{ objective: 'x', agent: 'leitor', provider: 'codex' }, { objective: 'x', agent: 'ninguem' }])
  check('agente com provedor diferente ou inexistente e recusado sem executar', d.text.split('---').every(p => /\[ERRO\]/.test(p)) && /nada e substituido em silencio/.test(d.text) && /nao existe/.test(d.text), d.text.slice(0, 200))
  await inv(ev, 'setAgentAliases', []) // limpa: os proximos testes usam a cota de delegacoes por tarefa

  const usedD = (await delegs()).length
  await inv(ev, 'setDelegationSettings', { maxPerTask: usedD })
  d = await deleg([{ objective: 'x', provider: 'opencode' }])
  check('limite de delegacoes por tarefa respeitado', /limite de \d+ delegacoes por tarefa/.test(d.text), d.text.slice(0, 120))
  await inv(ev, 'setDelegationSettings', { maxPerTask: 50 })

  // cancelar o pai cancela o filho ativo
  fs.rmSync(pidsFile, { force: true })
  await inv(ev, 'sendTask', tD, { provider: 'codex' }, 'DELEGAR:' + JSON.stringify([{ objective: 'TRAVAR o filho', provider: 'opencode', mode: 'read' }]))
  await runningDeleg()
  const [kp, kk] = fs.readFileSync(pidsFile, 'utf8').split(',').map(Number)
  check('filho ativo (processo e descendente vivos) antes de cancelar o pai', alive(kp) && alive(kk))
  await inv(ev, 'stopTask', tD)
  c = await waitDone(ev, tD)
  await sleep(1200)
  check('cancelar o pai cancela o filho: processos encerrados e delegacao cancelada', !alive(kp) && !alive(kk) && (await delegs())[0].status === 'cancelled', (await delegs())[0].status)

  // um escritor por area: edicao ativa reserva a pasta para outras tarefas
  const tE = (await inv(ev, 'createTask', gameArg, 'outra tarefa')).value
  fs.rmSync(pidsFile, { force: true })
  await inv(ev, 'sendTask', tD, { provider: 'codex' }, 'DELEGAR:' + JSON.stringify([{ objective: 'TRAVAR editando', provider: 'opencode', mode: 'edit' }]))
  await runningDeleg()
  const blocked = await inv(ev, 'sendTask', tE, { provider: 'codex' }, 'oi')
  check('enquanto o filho edita, outra tarefa na mesma pasta e bloqueada', blocked.ok === false && /reservada por uma delegacao de edicao/.test(blocked.error), blocked.error?.slice(0, 120))
  await inv(ev, 'stopTask', tD)
  await waitDone(ev, tD)
  await sleep(800)
  const freed = await inv(ev, 'sendTask', tE, { provider: 'codex' }, 'agora pode')
  check('reserva liberada quando a delegacao termina', freed.ok === true)
  await waitDone(ev, tE)

  await inv(ev, 'setDelegationSettings', { enabled: false })
  await inv(ev, 'sendTask', tE, { provider: 'codex' }, 'sem delegacao')
  await waitDone(ev, tE)
  check('delegacao desativada: o pai nao recebe a ferramenta', !argvLog().at(-1).argv.some(a => /mcp_servers/.test(a)), argvLog().at(-1).argv.join(' ').slice(0, 120))
  await inv(ev, 'setDelegationSettings', {})

  // ---- falha, cancelamento e reinicio
  await sendD(ev, tid2, { provider: 'opencode' }, 'FALHA aqui')
  c = await waitDone(ev, tid2)
  const failed = c.messages.at(-1)
  check('falha do provedor fica visivel, com mensagem, e nao vira sucesso', failed.status === 'failed' && /falha simulada do provedor/.test(failed.text), failed.text.slice(0, 80))
  const diag = (await inv(ev, 'diagnose')).value
  check('diagnostico mostra a ultima falha (categoria) sem segredos', diag.find(p => p.id === 'opencode').lastError?.detail.includes('falha simulada'), JSON.stringify(diag.find(p => p.id === 'opencode').lastError))
  check('log de diagnostico gravado', fs.existsSync(path.join(ud, 'diagnostics.log')) && fs.readFileSync(path.join(ud, 'diagnostics.log'), 'utf8').includes('"provider":"opencode"'))

  await sendD(ev, tid2, { provider: 'codex' }, 'TRAVAR agora')
  let live = ''
  for (let i = 0; i < 40 && !live.includes('parcial'); i++) { await sleep(250); live = (await inv(ev, 'taskChat', tid2, { provider: 'codex' })).value.live }
  check('streaming visivel via taskChat.live (restauravel ao voltar)', live.includes('texto parcial'), live.slice(0, 60))
  const [p1, p2] = fs.readFileSync(pidsFile, 'utf8').split(',').map(Number)
  check('processo e filho estao vivos antes de cancelar', alive(p1) && alive(p2))
  await inv(ev, 'stopTask', tid2)
  c = await waitDone(ev, tid2)
  await sleep(800)
  check('cancelar: estado cancelled com texto parcial preservado', c.messages.at(-1).status === 'cancelled' && c.messages.at(-1).text.includes('texto parcial'), c.messages.at(-1).text.slice(0, 60))
  check('cancelar: processo e descendentes encerrados', !alive(p1) && !alive(p2))
  const again = await sendD(ev, tid2, { provider: 'codex' }, 'depois do cancelamento')
  check('UI nao fica presa: nova mensagem aceita apos cancelar', again.ok === true)
  await waitDone(ev, tid2)

  // reinicio com execucao em andamento (o app "morre")
  await sendD(ev, tid2, { provider: 'codex' }, 'TRAVAR e morrer')
  for (let i = 0; i < 40 && !(await inv(ev, 'taskChat', tid2, { provider: 'codex' })).value.live.includes('parcial'); i++) await sleep(250)
  const before = (await inv(ev, 'taskChat', tid2, { provider: 'codex' })).value.messages.length
  const taskIdsBeforeRestart=(await inv(ev,'listTasks',gameArg,{})).value.map(t=>t.id).sort((a,b)=>a-b)
  // uma mensagem RETIDA (aguardando decisao sobre contexto) tambem existe quando o app "morre": ao reabrir ela expira, nada inicia e o texto e recuperavel
  const heldK = await inv(ev, 'sendTask', tid, { provider: 'codex' }, 'retida antes do reinicio')
  check('mensagem retida antes do reinicio (nenhum processo iniciado)', heldK.ok && heldK.value.status === 'awaiting_context_approval')
  const callsBeforeKill = argvLog().length
  kill(); await sleep(1500)
  ;({ ev, send, close } = await start())
  await sleep(1500)
  {
    const sk = (await inv(ev, 'listPendingSends', tid)).value
    const pkK = (await inv(ev, 'listContextPackages', tid)).value.find(p => p.id === heldK.value.packageId)
    check('reinicio: a mensagem retida expira sem iniciar nada; pedido invalido e texto recuperavel', argvLog().length === callsBeforeKill && sk.length === 1 && sk[0].state === 'expired' && /reiniciado/.test(sk[0].reason) && sk[0].text === 'retida antes do reinicio' && pkK.state === 'expired' && (await inv(ev, 'taskChat', tid, { provider: 'codex' })).value.awaitingContext === false, JSON.stringify(sk[0]))
    check('reinicio: aprovar o pedido expirado nao faz nada e reenviar volta a funcionar', (await inv(ev, 'decideSend', sk[0].id, pkK.hash, 'approve')).ok === false && argvLog().length === callsBeforeKill && (await inv(ev, 'recoverSend', sk[0].id)).value === 'retida antes do reinicio')
  }
  c = (await inv(ev, 'taskChat', tid2, { provider: 'codex' })).value
  check('reinicio: execucao interrompida reconciliada como falha, uma unica vez', c.running === false && c.messages.length === before + 1 && c.messages.at(-1).status === 'failed' && /interrompida/.test(c.messages.at(-1).text), c.messages.at(-1).text.slice(0, 90))
  kill(); await sleep(1000)
  ;({ ev, send, close } = await start())
  c = (await inv(ev, 'taskChat', tid2, { provider: 'codex' })).value
  const tasksNow = (await inv(ev, 'listTasks', gameArg, {})).value, nTasks = tasksNow.length
  check('segundo reinicio nao duplica mensagens nem tarefas', c.messages.length === before + 1 && JSON.stringify(tasksNow.map(t=>t.id).sort((a,b)=>a-b))===JSON.stringify(taskIdsBeforeRestart), JSON.stringify({ msgs: c.messages.length, before, nTasks, titles: tasksNow.map(t => t.title) }))
  // nucleo da home: gravacoes em memoria e, por projeto, commits e sujeira lidos do git (sem IA)
  const pp = (await inv(ev, 'projectsPulse')).value, pe = (await inv(ev, 'pulseEvents')).value
  const mine = pp.find(p => p.game === gameArg)
  check('nucleo: pulso responde por projeto (commits em lista, sujeira numerica ou null sem Git) e eventos por projeto', !!mine && Array.isArray(mine.commits) && (mine.dirt === null || Number.isFinite(mine.dirt.lines)) && !!pe && typeof pe === 'object', JSON.stringify(mine))
  // renomear projeto: so o nome de exibicao muda; vazio volta ao nome da pasta
  await inv(ev, 'renameProject', gameArg, 'Apelido e2e')
  const alias = (await inv(ev, 'projectNames')).value[gameArg]
  await inv(ev, 'renameProject', gameArg, '')
  check('renomear projeto guarda o apelido sem mexer na pasta; vazio restaura', alias === 'Apelido e2e' && fs.existsSync(gameArg) && (await inv(ev, 'projectNames')).value[gameArg] === undefined, String(alias))

  // ---- projeto SEM Git conversa normalmente; isolar pede Git; projeto COM Git isola por worktree so quando pedido
  const noGit = await inv(ev, 'isolateTask', tid)
  check('projeto sem Git: isolar falha com mensagem clara (conversar continua funcionando)', noGit.ok === false && /nao e um repositorio git/.test(noGit.error), noGit.error?.slice(0, 100))
  const gameGit = (await inv(ev, 'listGames')).value.find(g => g.toLowerCase().endsWith('projgit'))
  const tg = (await inv(ev, 'createTask', gameGit)).value
  await inv(ev, 'sendTask', tg, { provider: 'codex' }, 'oi no projeto git')
  await waitDone(ev, tg)
  const g1 = argvLog().at(-1)
  check('sem isolamento a tarefa roda na pasta do projeto (nenhuma worktree criada)', g1.cwd.toLowerCase() === projGit.toLowerCase() && !fs.existsSync(path.join(projGit, '.worktrees')), g1.cwd)
  const iso = await inv(ev, 'isolateTask', tg)
  check('isolar cria worktree e branch da tarefa', iso.ok && iso.value.worktree && /^task\/\d+-/.test(iso.value.branch) && fs.existsSync(iso.value.worktree), JSON.stringify(iso.value?.branch))
  {
    const gi = (await inv(ev, 'projectInfo', projGit)).value
    const wt = gi?.worktrees?.find(w => w.taskId === tg)
    check('local de trabalho real: repositorio, branch e a worktree ligada a tarefa', gi?.repo === true && !!gi.git?.branch && !!wt && wt.branch === iso.value.branch, JSON.stringify({ repo: gi?.repo, branch: gi?.git?.branch, wt: wt?.branch }))
    const ng = (await inv(ev, 'projectInfo', gameArg)).value
    check('local de trabalho: pasta sem Git e informada sem erro', ng?.repo === false && !ng.error, JSON.stringify({ repo: ng?.repo, error: ng?.error }))
  }
  c = (await inv(ev, 'taskChat', tg, { provider: 'codex' })).value
  check('isolar reinicia sessoes nativas e registra aviso no historico', c.session === null && c.messages.some(m => m.role === 'system' && /worktree/.test(m.text)))
  const nIso = argvLog().length
  const heldG = await inv(ev, 'sendTask', tg, { provider: 'codex' }, 'depois de isolar')
  const gp = (await inv(ev, 'listContextPackages', tg)).value
  check('depois de isolar: sessao nova e o historico anterior vira PEDIDO de aprovacao para a worktree; a mensagem fica retida e nada inicia antes da decisao', heldG.ok && heldG.value.status === 'awaiting_context_approval' && argvLog().length === nIso && gp.some(p => p.state === 'pending' && p.items[0].content.includes('oi no projeto git') && /\.worktrees/.test(p.recipient.workspace)), JSON.stringify(heldG.value ?? heldG.error))
  const decG = await inv(ev, 'decideSend', heldG.value.sendId, gp.find(p => p.state === 'pending').hash, 'reject') // executar sem contexto
  await waitDone(ev, tg)
  const g2 = argvLog().at(-1)
  check('depois de isolar (sem contexto): roda na worktree, sessao nova e sem o historico anterior', decG.ok && /[\\/]\.worktrees[\\/]/.test(g2.cwd) && !g2.argv.includes('resume') && !g2.input.includes('oi no projeto git'), g2.cwd)

  // ---- Permissoes: "sempre permitir" por CLI. Claude pergunta pelo pop-up (permission_prompt, coberto em permissions.test.ts); Codex e OpenCode
  // nao tem prompt no modo headless, entao a escolha vira sandbox/--auto. Nada disso e chamada real: CLIs falsas.
  const ps0 = (await inv(ev, 'getPermissionSettings')).value
  check('permissoes: padroes seguros (pop-up ligado, Codex com sandbox, OpenCode sem --auto)', ps0.prompt === true && ps0.codexSandbox === 'workspace-write' && !ps0.codexNetwork && !ps0.opencodeAuto && ps0.capabilities.claude === 'prompt', JSON.stringify(ps0))
  const noAck = await inv(ev, 'setPermissionSettings', { ...ps0, codexSandbox: 'danger-full-access' })
  check('Codex sem sandbox exige ciencia explicita do risco', noAck.ok === false && /Confirme que entende o risco/.test(noAck.error) && (await inv(ev, 'getPermissionSettings')).value.codexSandbox === 'workspace-write', noAck.error?.slice(0, 100))
  const tp = (await inv(ev, 'createTask', gameArg, 'permissoes')).value
  await inv(ev, 'setPermissionSettings', { ...ps0, codexNetwork: true })
  await inv(ev, 'sendTask', tp, { provider: 'codex' }, 'com rede')
  await waitDone(ev, tp)
  check('Codex: rede liberada dentro da sandbox (network_access) quando configurado', argvLog().at(-1).argv.join(' ').includes('-s workspace-write -c sandbox_workspace_write.network_access=true'), argvLog().at(-1).argv.join(' ').slice(0, 160))
  await inv(ev, 'setPermissionSettings', { ...ps0, codexSandbox: 'danger-full-access', acknowledged: true })
  await inv(ev, 'sendTask', tp, { provider: 'codex' }, 'sem sandbox')
  await waitDone(ev, tp)
  const fullArgs = argvLog().at(-1).argv.join(' ')
  check('Codex sem sandbox (com ciencia): -s danger-full-access e sem rede redundante', fullArgs.includes('-s danger-full-access') && !fullArgs.includes('network_access'), fullArgs.slice(0, 120))
  await inv(ev, 'setPermissionSettings', { ...ps0, opencodeAuto: true })
  await sendD(ev, tp, { provider: 'opencode' }, 'auto')
  await waitDone(ev, tp)
  check('OpenCode: "sempre permitir" vira --auto', argvLog().at(-1).argv.includes('--auto'), argvLog().at(-1).argv.join(' '))
  await inv(ev, 'setPermissionSettings', ps0) // volta ao padrao para os outros testes
  const rBroad = await inv(ev, 'addPermissionRule', { provider: 'claude', kind: 'bash', pattern: 'git *' })
  const rDestr = await inv(ev, 'addPermissionRule', { provider: 'claude', kind: 'bash', pattern: 'rm *', acknowledged: true })
  const rOk = await inv(ev, 'addPermissionRule', { provider: 'claude', kind: 'bash', pattern: 'npm run *' })
  check('regra ampla sem ciencia e recusada; curinga destrutivo nunca; baixo risco salva', rBroad.ok === false && /ampla/.test(rBroad.error) && rDestr.ok === false && /Regra ampla recusada/.test(rDestr.error) && rOk.ok && rOk.value.risk === 'low', `${rBroad.error?.slice(0, 60)} | ${rDestr.error?.slice(0, 60)}`)
  check('avaliar padrao pela interface e listar regras por agente', (await inv(ev, 'assessPermissionRule', 'bash', 'powershell *')).value.risk === 'broad' && (await inv(ev, 'listPermissionRules')).value.some(r => r.pattern === 'npm run *' && r.provider === 'claude'))
  check('regra removida deixa de existir', (await inv(ev, 'removePermissionRule', rOk.value.id)).value === true && !(await inv(ev, 'listPermissionRules')).value.some(r => r.id === rOk.value.id))
  check('sem pedidos pendentes e resposta a pedido inexistente e recusada', (await inv(ev, 'listPermissionRequests')).value.filter(r => r.state === 'pending').length === 0 && (await inv(ev, 'resolvePermissionRequest', 999999, 'allow_once', {})).ok === false)

  // ---- fechar o app com execucao ativa: cancela processos e grava 'cancelled'
  await inv(ev, 'sendTask', tg, { provider: 'codex' }, 'TRAVAR ao fechar')
  for (let i = 0; i < 40 && !(await inv(ev, 'taskChat', tg, { provider: 'codex' })).value.live.includes('parcial'); i++) await sleep(250)
  const [q1, q2] = fs.readFileSync(pidsFile, 'utf8').split(',').map(Number)
  // o usuario fecha a janela (WM_CLOSE): window-all-closed -> app.quit -> before-quit
  try { execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`], { stdio: 'ignore' }) } catch {}
  for (let i = 0; i < 40 && alive(app.pid); i++) await sleep(250)
  for (let i = 0; i < 20 && (alive(q1) || alive(q2)); i++) await sleep(250) // taskkill do before-quit termina depois do app
  { const d = new DatabaseSync(path.join(ud, 'dashboard.db')); const st = d.prepare('SELECT status FROM runs ORDER BY id DESC LIMIT 1').get()?.status; d.close(); console.log('   estado da ultima execucao no banco apos fechar:', st) }
  check('fechar o app: processo do provedor e descendentes encerrados', !alive(q1) && !alive(q2), `app vivo=${alive(app.pid)} provedor vivo=${alive(q1)} filho vivo=${alive(q2)}`)
  ;({ ev, send, close } = await start())
  c = (await inv(ev, 'taskChat', tg, { provider: 'codex' })).value
  check('fechar o app: execucao gravada como cancelada (nao como falha), sem duplicar', c.messages.at(-1).status === 'cancelled' && c.messages.filter(m => m.status === 'cancelled').length === 1, c.messages.at(-1).status)

  // ---- home: /fixar no campo do Jarvis manda o texto para a to-do e ele vira o foco "Agora"
  await ev(`(() => {
    const i = document.querySelector('.jarvis input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '/fixar Testar a lista e2e')
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(100)
  await ev("document.querySelector('.jarvis').requestSubmit()")
  await sleep(300)
  const now = await ev("document.querySelector('.now .now-text')?.textContent")
  check('home: /fixar adiciona item na to-do e ele aparece como Agora', now === 'Testar a lista e2e', String(now))
  await ev("document.querySelector('.now .check-btn')?.click()")
  await sleep(200)
  check('home: concluir o item Agora tira ele do foco', await ev("document.querySelector('.now .now-text')?.textContent !== 'Testar a lista e2e'"))

  // ---- links: a janela nunca navega para fora do app
  try { await ev("location.href = 'file:///C:/Windows/System32/drivers/etc/hosts'") } catch {}
  await sleep(1000)
  check('navegacao para file:// e bloqueada (a janela continua no app)', await ev("!!document.querySelector('.app') && location.pathname.endsWith('index.html')"))

  // ---- Markdown malicioso vindo de um agente, no renderer REAL (sandbox + sanitizacao + CSP)
  const tX = (await inv(ev, 'createTask', gameArg, 'xss')).value
  await inv(ev, 'sendTask', tX, { provider: 'codex' }, 'XSS agora')
  await waitDone(ev, tX)
  await ev("document.querySelector('.group-toggle[aria-expanded=false]')?.click()"); await sleep(200) // grupo Todos pode estar recolhido
  await ev("document.querySelector('.rail-ws.inbox')?.click()"); await sleep(600) // trilho so tem organizadores; as pastas ficam na gaveta
  await ev("[...document.querySelectorAll('.chats [data-path]')].find(b => (b.dataset.path || '').toLowerCase().endsWith('projeto'))?.click()")
  await sleep(1200)
  check('selecionar um projeto abre a visao geral (tarefas recentes, painel de branch, roadmap)', await ev("!!document.querySelector('.home .bridge') && !!document.querySelector('.home .ph-tasks, .home .ph-sec') && !!document.querySelector('.home .branch') && !!document.querySelector('.home .roadmap-card')"))
  await ev("[...document.querySelectorAll('button.task')].find(b => /xss/i.test(b.textContent))?.click()")
  await sleep(1200)
  const xss = await ev(`(() => {
    const m = document.querySelector('.msgs')
    const bad = m.querySelectorAll('script, iframe, img, svg, form, input, style, [onerror], [onclick], [onload], [onmouseover]').length
    const hrefs = [...m.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(Boolean)
    return { bad, hrefs, pwn: window.__pwn ?? null, text: m.innerText.includes('link seguro'), page: location.pathname.endsWith('index.html') }
  })()`)
  check('Markdown malicioso: nenhum elemento/atributo perigoso no DOM, so links http/https/mailto, nada executou', xss.text && xss.bad === 0 && xss.pwn === null && xss.page && xss.hrefs.every(h => /^(https?:|mailto:)/i.test(h)) && xss.hrefs.length === 2, JSON.stringify(xss))
  await ev("[...document.querySelectorAll('.msgs a')].forEach(a => a.click())")
  await sleep(800)
  check('clicar nos links do Markdown nao navega a janela nem executa codigo', await ev("location.pathname.endsWith('index.html') && window.__pwn === undefined && !!document.querySelector('.app')"))

  // ---- Fase 5 na interface real: cartao de decisao (papel, foco, destinatario, tres acoes), envio bloqueado enquanto aguarda, cancelar e recuperar o texto
  {
    const callsUi = argvLog().length
    const heldUi = await inv(ev, 'sendTask', tid, { provider: 'codex' }, 'mensagem retida na interface')
    await ev("[...document.querySelectorAll('button.task')].find(b => /primeira mensagem/i.test(b.textContent))?.click()")
    await sleep(1800)
    const card = await ev(`(() => {
      const r = document.querySelector('.ctx-req[role=region]:not(.unsent)'); if (!r) return null
      return { label: r.getAttribute('aria-label'), btns: [...r.querySelectorAll('.cr-actions button')].map(b => b.textContent.trim()), focus: document.activeElement?.textContent?.trim(),
        dest: r.querySelector('.cr-dest')?.innerText.replace(/\\s+/g, ' '), msg: r.querySelector('.cr-msg q')?.textContent, sendDisabled: document.querySelector('.composer .send')?.disabled,
        ph: document.querySelector('.composer textarea')?.placeholder, timer: r.querySelector('.countdown')?.title }
    })()`)
    check('interface: cartao de decisao acessivel com as tres acoes, foco na primeira e nenhum processo iniciado', heldUi.ok && !!card && card.label === 'Decisão sobre contexto pendente' && card.btns.join('|') === 'Aprovar e executar|Executar sem contexto|Cancelar envio' && card.focus === 'Aprovar e executar' && argvLog().length === callsUi, JSON.stringify(card))
    check('interface: mostra provedor, modelo, pasta e escopo do destinatario e a mensagem retida; envio bloqueado enquanto aguarda', /Provedor Codex/.test(card?.dest ?? '') && /Modelo padrão/.test(card.dest) && /Escopo pasta inteira/.test(card.dest) && card.msg === 'mensagem retida na interface' && card.sendDisabled === true && /Decida sobre o contexto/.test(card.ph), JSON.stringify(card))
    check('interface: o prazo diz que sem decisao a mensagem NAO e enviada (nao promete continuar)', /NÃO é enviada e nenhum agente é iniciado/.test(card?.timer ?? ''), card?.timer)
    await ev("[...document.querySelectorAll('.ctx-req .cr-actions button')].find(b => /Cancelar envio/.test(b.textContent))?.click()")
    await sleep(1500)
    const un = await ev("(() => { const r = document.querySelector('.ctx-req.unsent'); return r ? { text: r.innerText, gone: !document.querySelector('.ctx-req:not(.unsent) .cr-actions') } : null })()")
    check('interface: cancelar pelo botao nao inicia processo e mostra a mensagem como NAO enviada', !!un && /Mensagem não enviada/.test(un.text) && /Nenhum agente foi iniciado/.test(un.text) && un.gone && argvLog().length === callsUi, JSON.stringify(un))
    await ev("[...document.querySelectorAll('.ctx-req.unsent button')].find(b => /Recuperar texto/.test(b.textContent))?.click()")
    await sleep(1000)
    check('interface: recuperar devolve o texto ao campo de mensagem e libera o envio', await ev("document.querySelector('.composer textarea')?.value === 'mensagem retida na interface' && !document.querySelector('.ctx-req.unsent') && document.querySelector('.composer .send')?.disabled === false"))
  }

  // ---- Planejamento persistente -> tarefa -> etapas -> comando local (CLIs/engine simulados).
  const plan = (await inv(ev, 'todoBoard')).value
  plan.topics[0].open = true
  plan.topics[0].items.push({ id: 'feature-e2e', text: 'E2E ciclo de produção', done: false, images: [], project: gameArg, agent: 'codex' })
  check('planejamento: salva no SQLite e rejeita revisão antiga', (await inv(ev,'saveTodo',plan.revision,plan.topics)).ok && !(await inv(ev,'saveTodo',plan.revision,plan.topics)).ok)
  const beforePlan = argvLog().length
  await ev("[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Início'||b.getAttribute('title')==='Início')?.click()")
  await sleep(800)
  await ev("[...document.querySelectorAll('.todo .item')].find(r=>r.querySelector('.item-text')?.textContent==='E2E ciclo de produção')?.querySelector('.todo-task-action button.text-btn')?.click()")
  await sleep(1600)
  const planned = (await inv(ev,'todoBoard')).value.topics[0].items.find(i=>i.id==='feature-e2e')
  check('to-do: Preparar tarefa abre o compositor com a ordem, sem iniciar IA', !!planned.taskId && await ev("document.querySelector('.composer textarea')?.value==='E2E ciclo de produção'") && argvLog().length===beforePlan)
  const productionId=planned.taskId
  const againPlan=(await inv(ev,'todoTask',plan.topics[0].id,planned.id,gameArg)).value
  check('to-do: abrir novamente reutiliza a mesma tarefa', againPlan.taskId===productionId && !againPlan.created)
  const stepA=(await inv(ev,'addStep',productionId,'Investigar','Investigar o pulo')).value
  const stepB=(await inv(ev,'addStep',productionId,'Implementar','Implementar o pulo')).value
  check('etapas: não pula etapa anterior nem aceita etapa não executada', !(await inv(ev,'sendTask',productionId,{provider:'codex'},'fora de ordem',[],stepB)).ok && !(await inv(ev,'reviewStep',stepA,true)).ok)
  await sleep(500)
  await ev("document.querySelector('.workflow:not(.project-commands) > summary')?.click()")
  await ev("[...document.querySelectorAll('.workflow:not(.project-commands) button')].find(b=>b.textContent==='Preparar no chat'&&!b.disabled)?.click()")
  await sleep(300)
  check('etapas: preparar no chat preenche ordem, ainda sem inferência', await ev("document.querySelector('.composer textarea')?.value==='Investigar o pulo'") && argvLog().length===beforePlan)
  await ev("document.querySelector('.composer .send')?.click()")
  await waitDone(ev,productionId); await sleep(600)
  check('etapas: execução concluída exige revisão humana', (await inv(ev,'listSteps',productionId)).value[0].state==='review')
  await ev("[...document.querySelectorAll('.workflow button')].find(b=>b.textContent==='Aceitar etapa')?.click()")
  await sleep(400)
  check('etapas: aceite pela UI libera próxima etapa', (await inv(ev,'listSteps',productionId)).value[0].state==='accepted')
  const stepHeld=await inv(ev,'sendTask',productionId,{provider:'opencode'},'Implementar o pulo',[],stepB)
  check('etapas: troca de provedor aguarda consentimento', stepHeld.ok && stepHeld.value.status==='awaiting_context_approval' && (await inv(ev,'listSteps',productionId)).value[1].state==='awaiting_context')
  const stepPk=(await inv(ev,'listContextPackages',productionId)).value.find(p=>p.id===stepHeld.value.packageId)
  check('etapas: hash inválido não inicia e mantém a etapa pendente', !(await inv(ev,'decideSend',stepHeld.value.sendId,'f'.repeat(64),'approve')).ok && (await inv(ev,'listSteps',productionId)).value[1].state==='awaiting_context')
  await inv(ev,'decideSend',stepHeld.value.sendId,stepPk.hash,'cancel')
  check('etapas: cancelar consentimento permite retomar a etapa', (await inv(ev,'listSteps',productionId)).value[1].state==='cancelled')
  const stepRetry=(await inv(ev,'sendTask',productionId,{provider:'opencode'},'Implementar o pulo',[],stepB)).value
  const stepRetryPk=(await inv(ev,'listContextPackages',productionId)).value.find(p=>p.id===stepRetry.packageId)
  const stepApproved=await inv(ev,'decideSend',stepRetry.sendId,stepRetryPk.hash,'approve')
  await waitDone(ev,productionId)
  const reviewed=(await inv(ev,'listSteps',productionId)).value[1]
  check('etapas: após aprovação vincula a execução correta e exige revisão', stepApproved.ok && reviewed.state==='review' && reviewed.run_id===stepApproved.value.runId)

  // Preset é uma configuração para revisar; substituímos Godot por Node local sem engine ou rede.
  await ev("document.querySelector('.project-commands > summary')?.click()")
  await ev("[...document.querySelectorAll('.project-commands button')].find(b=>b.textContent==='Preset validar Godot')?.click()")
  check('comandos: preset Godot só preenche configuração para revisão', await ev("document.querySelector('.project-commands input[aria-label=Programa]')?.value==='godot'") && argvLog().length===beforePlan+2)
  const localArgs=['-e','require("node:fs").writeFileSync("game-demo.zip","distribuível falso E2E");console.log("build local verificado");console.log(process.cwd())']
  await ev(`(() => { for(const [label,value] of ${JSON.stringify([['Nome do comando','Teste local E2E'],['Programa',process.execPath],['Argumentos JSON',JSON.stringify(localArgs)]])}){const e=document.querySelector('.project-commands [aria-label="'+label+'"]');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))} })()`)
  await sleep(100)
  await ev("document.querySelector('.project-commands form').requestSubmit()")
  await sleep(400)
  check('comandos: salva pela UI sem executar', (await inv(ev,'projectCommands',gameArg)).value.some(c=>c.name==='Teste local E2E'))
  await ev("[...document.querySelectorAll('.command-list button')].find(b=>b.textContent==='Executar')?.click()")
  let commandResult
  for(let i=0;i<60;i++){commandResult=(await inv(ev,'listCommandRuns',productionId)).value[0];if(commandResult&&commandResult.status!=='running')break;await sleep(100)}
  check('comandos: processo local retorna saída/exit/duração na pasta correta, sem IA', commandResult?.status==='completed' && commandResult.exit_code===0 && commandResult.duration_ms>=0 && commandResult.output.includes('build local verificado') && commandResult.workspace.toLowerCase()===gameArg.toLowerCase() && argvLog().length===beforePlan+2)
  const savedCommands=(await inv(ev,'projectCommands',gameArg)).value
  await inv(ev,'saveProjectCommands',gameArg,[...savedCommands,{name:'Espera local',purpose:'run',program:process.execPath,args:['-e','console.log("esperando");setInterval(()=>{},1000)']}])
  const waiting=(await inv(ev,'runProjectCommand',productionId,'Espera local')).value
  check('comandos: impede IA concorrente na mesma pasta e exclusão da tarefa ativa', !(await inv(ev,'sendTask',productionId,{provider:'codex'},'não concorrer')).ok && !(await inv(ev,'deleteTask',productionId)).ok)
  check('comandos: cancelamento exige ownership da tarefa', !(await inv(ev,'cancelProjectCommand',tid,waiting)).ok)
  await inv(ev,'cancelProjectCommand',productionId,waiting)
  for(let i=0;i<60&&(await inv(ev,'listCommandRuns',productionId)).value[0].status==='running';i++)await sleep(100)
  check('comandos: cancelamento persistido', (await inv(ev,'listCommandRuns',productionId)).value[0].status==='cancelled')
  kill();await sleep(1000);({ev,send,close}=await start())
  check('reinício: to-do ligada, etapas e histórico de comandos preservados', (await inv(ev,'todoBoard')).value.topics[0].items.find(i=>i.id==='feature-e2e').taskId===productionId && (await inv(ev,'listSteps',productionId)).value[0].state==='accepted' && (await inv(ev,'listSteps',productionId)).value[1].state==='review' && (await inv(ev,'listCommandRuns',productionId)).value[0].status==='cancelled')

  // ---- Fases 5–7: catálogo/versionamento, playtest humano e distribuível falso do comando Node.
  const beforeLibrary = argvLog().length
  const sprite = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/UAAAAAASUVORK5CYII=', 'base64')
  fs.writeFileSync(path.join(proj, 'sprite.png'), sprite)
  const assetId = (await inv(ev, 'captureAsset', gameArg, { title: 'Jogador E2E', path: 'sprite.png', kind: 'sprite', license: 'Autoral', source: 'Fixture local', tags: 'player, teste', note: 'Primeira versão' })).value
  let asset = (await inv(ev, 'listAssets', gameArg)).value.find(a => a.id === assetId)
  const firstVersion = asset.versions[0]
  check('assets: snapshot com metadados/preview e revisão pendente, sem IA', !!assetId && asset.tags === 'player, teste' && firstVersion.state === 'pending' && (await inv(ev, 'assetImage', gameArg, firstVersion.id)).value === `data:image/png;base64,${sprite.toString('base64')}` && argvLog().length === beforeLibrary)
  check('assets: IPC impede escape, projeto externo e hash de revisão incorreto', !(await inv(ev, 'captureAsset', gameArg, { title: 'Escape', path: '../segredo.md' })).ok && !(await inv(ev, 'listAssets', work)).ok && !(await inv(ev, 'reviewAssetVersion', gameArg, firstVersion.id, '0'.repeat(64), 'approved')).ok)
  check('assets: exportação pendente é recusada antes de abrir a janela nativa', !(await inv(ev, 'exportProductionFile', gameArg, 'asset', firstVersion.id)).ok)
  await inv(ev, 'reviewAssetVersion', gameArg, firstVersion.id, firstVersion.hash, 'approved')
  const repeatedVersion = (await inv(ev, 'captureAssetVersion', gameArg, assetId, 'Mesma versão')).value
  fs.writeFileSync(path.join(proj, 'sprite.png'), Buffer.concat([sprite, Buffer.from('nova versão')]))
  const secondVersion = (await inv(ev, 'captureAssetVersion', gameArg, assetId, 'Revisão visual')).value
  asset = (await inv(ev, 'listAssets', gameArg)).value.find(a => a.id === assetId)
  check('assets: alterar original exige nova revisão e não altera o snapshot aprovado', repeatedVersion === firstVersion.id && secondVersion !== firstVersion.id && asset.versions.length === 2 && asset.versions[0].state === 'pending' && asset.versions[1].state === 'approved' && (await inv(ev, 'assetImage', gameArg, firstVersion.id)).value === `data:image/png;base64,${sprite.toString('base64')}`)

  const availableBuilds = (await inv(ev, 'listBuildCommands', gameArg)).value
  check('builds: lista só comandos locais concluídos, sem cancelamentos', availableBuilds.some(c => c.id === commandResult.id) && !availableBuilds.some(c => c.id === waiting))
  check('builds: recusa comando cancelado, arquivo fora do workspace e destino de outro projeto', !(await inv(ev, 'registerBuild', gameArg, { title: 'Demo', version: '0.1', platform: 'Windows', path: 'game-demo.zip', commandId: waiting })).ok && !(await inv(ev, 'registerBuild', gameArg, { title: 'Demo', version: '0.1', platform: 'Windows', path: '../segredo.md', commandId: commandResult.id })).ok && !(await inv(ev, 'registerBuild', projGit, { title: 'Demo', version: '0.1', platform: 'Windows', path: 'game-demo.zip', commandId: commandResult.id })).ok)
  const buildId = (await inv(ev, 'registerBuild', gameArg, { title: 'Demo E2E', version: '0.1', platform: 'Windows', path: 'game-demo.zip', notes: 'Arquivo falso gerado pelo Node', commandId: commandResult.id })).value
  const buildRecord = (await inv(ev, 'listBuilds', gameArg)).value.find(b => b.id === buildId)
  check('builds: exit 0 guarda origem, mas não aprova qualidade automaticamente', !!buildId && buildRecord.state === 'pending' && buildRecord.source_task_id === productionId && JSON.parse(buildRecord.command).exit_code === 0 && !(await inv(ev, 'exportProductionFile', gameArg, 'build', buildId)).ok)

  const playtestId = (await inv(ev, 'addPlaytest', gameArg, { title: 'Colisão E2E', scenario: 'Pular sobre a plataforma móvel', expected: 'Pousar sobre a plataforma', observed: 'O personagem atravessou a plataforma', outcome: 'fail', severity: 'high', notes: 'Observação humana, não enviada ao agente', images: [`data:image/png;base64,${sprite.toString('base64')}`], buildId })).value
  let playtest = (await inv(ev, 'listPlaytests', gameArg)).value.find(p => p.id === playtestId)
  check('playtests: observações/screenshots persistem e pertencem ao build/projeto', !!playtestId && playtest.imageCount === 1 && playtest.build_id === buildId && playtest.state === 'open' && (await inv(ev, 'playtestImages', gameArg, playtestId)).value.length === 1 && !(await inv(ev, 'playtestImages', projGit, playtestId)).ok && !(await inv(ev, 'addPlaytest', projGit, { title: 'Outro', observed: 'Outro', outcome: 'fail', buildId })).ok)
  const issueTitle = 'Revisar colisão do jogador', issueInstruction = 'Verifique o código de colisão e corrija o pulo.'
  const issueId = (await inv(ev, 'createPlaytestIssue', gameArg, playtestId, issueTitle, issueInstruction)).value
  const sameIssue = (await inv(ev, 'createPlaytestIssue', gameArg, playtestId, issueTitle, issueInstruction)).value
  const issue = (await inv(ev, 'listPins', gameArg)).value.find(p => p.id === issueId)
  check('playtests: problema idempotente recebe só a ordem digitada, sem notas/imagens históricas', issueId === sameIssue && issue.title === issueTitle && issue.body === issueInstruction && argvLog().length === beforeLibrary)
  const issueTask = (await inv(ev, 'taskForPin', issueId)).value
  check('playtests: abrir tarefa não dispara agente nem anexa observações ao chat', !!issueTask && (await inv(ev, 'taskChat', issueTask, { provider: 'codex' })).value.messages.length === 0 && argvLog().length === beforeLibrary)
  await inv(ev, 'setPlaytestState', gameArg, playtestId, 'resolved')
  check('playtests: resolução humana independente da tarefa', (await inv(ev, 'listPlaytests', gameArg)).value.find(p => p.id === playtestId).state === 'resolved' && (await inv(ev, 'taskChat', issueTask, { provider: 'codex' })).value.task.state !== 'concluida')
  await inv(ev, 'deletePin', issueId)
  await inv(ev, 'addPin', gameArg, 'Problema diferente', 'Ordem diferente')
  playtest = (await inv(ev, 'listPlaytests', gameArg)).value.find(p => p.id === playtestId)
  check('playtests: excluir problema limpa vínculo sem perder registro ou reutilizar outro ID', playtest.pin_id === null && (await inv(ev, 'taskChat', issueTask, { provider: 'codex' })).value.task.pin_id === null && (await inv(ev, 'playtestImages', gameArg, playtestId)).value.length === 1)

  kill(); await sleep(1000); ({ ev, send, close } = await start())
  check('reinício: assets/versionamento, playtest/screenshot e build pendente sobrevivem', (await inv(ev, 'listAssets', gameArg)).value.find(a => a.id === assetId).versions.length === 2 && (await inv(ev, 'playtestImages', gameArg, playtestId)).value.length === 1 && (await inv(ev, 'listBuilds', gameArg)).value.find(b => b.id === buildId).state === 'pending' && argvLog().length === beforeLibrary)

  // ---- QA visual no Electron real: capturas e metricas em 1400x900, 1024x768 e 768x1024
  const shotDir = path.join(os.tmpdir(), 'gpd-e2e-shots')
  fs.mkdirSync(shotDir, { recursive: true })
  await ev("document.querySelector('.group-toggle[aria-expanded=false]')?.click()"); await sleep(200) // grupo Todos pode estar recolhido
  await ev("document.querySelector('.rail-ws.inbox')?.click()"); await sleep(600) // trilho so tem organizadores; as pastas ficam na gaveta
  await ev("[...document.querySelectorAll('.chats [data-path]')].find(b => (b.dataset.path || '').toLowerCase().endsWith('projeto'))?.click()")
  await sleep(1200)
  // Produção na interface real: falha conserva rascunho; registros, evidências e revisão são manuais.
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  const productionCalls = argvLog().length
  const setProductionFields = async fields => {
    await ev(`(() => { for(const [label,value] of ${JSON.stringify(fields)}){const e=document.querySelector('.production [aria-label="'+label+'"]');if(!e)throw Error('Campo ausente: '+label);const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))} })()`)
    await sleep(100)
  }
  const activeProduction = '.production > div:not([hidden])'
  check('produção: catálogo aparece na visão geral com três áreas', await ev("!!document.querySelector('.production') && document.querySelectorAll('.production-nav button').length === 3"))
  const uiSprite = await ev("(() => { const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='#7cc4ff';x.fillRect(8,8,48,48);return c.toDataURL('image/png').split(',')[1] })()")
  fs.writeFileSync(path.join(proj, 'sprite-ui.png'), Buffer.from(uiSprite, 'base64'))
  await ev("[...document.querySelectorAll('.production-form-box > summary')].find(s=>s.textContent==='Registrar asset').click()")
  await setProductionFields([['Nome do asset','Asset pela UI'],['Arquivo do asset','arquivo-inexistente.png'],['Tipo do asset','sprite'],['Licença do asset','Autoral'],['Tags do asset','ui, personagem']])
  await ev(`document.querySelector('${activeProduction} .production-form').requestSubmit()`); await sleep(500)
  check('assets UI: falha é visível e não apaga o rascunho', await ev("!!document.querySelector('.production-error') && document.querySelector('[aria-label=\"Nome do asset\"]').value==='Asset pela UI' && document.querySelector('[aria-label=\"Arquivo do asset\"]').value==='arquivo-inexistente.png'"))
  await setProductionFields([['Arquivo do asset','sprite-ui.png']])
  await ev(`document.querySelector('${activeProduction} .production-form').requestSubmit()`); await sleep(500)
  const uiAsset = (await inv(ev,'listAssets',gameArg)).value.find(a=>a.title==='Asset pela UI')
  check('assets UI: correção salva e limpa o rascunho', !!uiAsset && await ev("document.querySelector('[aria-label=\"Nome do asset\"]').value==='' && !document.querySelector('.production-error')"))
  await ev("[...document.querySelectorAll('.production-record > summary')].find(s=>s.textContent.includes('Asset pela UI')).click()")
  await ev("[...document.querySelectorAll('.production-record[open] button')].find(b=>b.textContent==='Aprovar versão').click()"); await sleep(400)
  check('assets UI: aprovação humana associa o hash exibido', (await inv(ev,'listAssets',gameArg)).value.find(a=>a.id===uiAsset.id).versions[0].state==='approved')
  await ev("[...document.querySelectorAll('.production-record[open] button')].find(b=>b.textContent==='Ver imagem').click()"); await sleep(300)
  check('assets UI: preview nativo abre a imagem capturada', await ev("document.querySelector('.production-preview')?.open===true && document.querySelector('.production-preview img')?.naturalWidth===64"))
  await ev("document.querySelector('.production-preview button').click()"); await sleep(100)

  await ev("[...document.querySelectorAll('.production-nav button')].find(b=>b.textContent.includes('Playtests')).click()")
  await ev("[...document.querySelectorAll('.production-form-box > summary')].find(s=>s.textContent==='Registrar playtest').click()")
  await setProductionFields([['Nome do playtest','Playtest pela UI'],['Resultado observado do playtest','O pulo falhou em uma rampa'],['Resultado esperado do playtest','Pular normalmente'],['Build do playtest',String(buildId)]])
  const dom = (await send('DOM.getDocument')).result.root.nodeId
  const fileInput = (await send('DOM.querySelector', { nodeId: dom, selector: '.production [aria-label="Imagens do playtest"]' })).result.nodeId
  await send('DOM.setFileInputFiles', { nodeId: fileInput, files: [path.join(proj,'sprite-ui.png')] }); await sleep(500)
  check('playtests UI: arquivo escolhido vira screenshot revisável', await ev("document.querySelector('.production [aria-label=\"Imagens do playtest\"]').parentElement.textContent.includes('(1/6)')"))
  await ev(`document.querySelector('${activeProduction} .production-form').requestSubmit()`); await sleep(500)
  const uiPlaytest = (await inv(ev,'listPlaytests',gameArg)).value.find(p=>p.title==='Playtest pela UI')
  check('playtests UI: formulário salva observações, build e imagem', !!uiPlaytest && uiPlaytest.build_id===buildId && uiPlaytest.imageCount===1)
  await ev("[...document.querySelectorAll('.production-record > summary')].find(s=>s.textContent.includes('Playtest pela UI')).click()")
  await ev("[...document.querySelectorAll('.production-record[open] .production-issue > summary')].find(s=>s.textContent.includes('Criar problema')).click()")
  check('playtests UI: campos da ordem começam vazios, sem disfarçar histórico', await ev(`document.querySelector('[aria-label="Título do problema do playtest ${uiPlaytest.id}"]').value==='' && document.querySelector('[aria-label="Ordem de correção do playtest ${uiPlaytest.id}"]').value===''`))
  await setProductionFields([[`Título do problema do playtest ${uiPlaytest.id}`,'Corrigir pulo na rampa'],[`Ordem de correção do playtest ${uiPlaytest.id}`,'Reveja a detecção de chão na rampa.']])
  await ev(`document.querySelector('${activeProduction} .production-issue form').requestSubmit()`); await sleep(400)
  const uiIssue = (await inv(ev,'listPins',gameArg)).value.find(p=>p.title==='Corrigir pulo na rampa')
  check('playtests UI: cria problema só com título e ordem digitados', uiIssue?.body==='Reveja a detecção de chão na rampa.' && (await inv(ev,'listPlaytests',gameArg)).value.find(p=>p.id===uiPlaytest.id).pin_id===uiIssue.id && argvLog().length===productionCalls)

  await ev("[...document.querySelectorAll('.production-nav button')].find(b=>b.textContent.includes('Builds')).click()")
  await ev("[...document.querySelectorAll('.production-form-box > summary')].find(s=>s.textContent==='Registrar build').click()")
  await setProductionFields([['Nome da build','Build pela UI'],['Versão da build','0.2'],['Plataforma da build','Windows'],['Arquivo da build','game-demo.zip'],['Comando da build',String(commandResult.id)]])
  await ev(`document.querySelector('${activeProduction} .production-form').requestSubmit()`); await sleep(500)
  const uiBuild = (await inv(ev,'listBuilds',gameArg)).value.find(b=>b.title==='Build pela UI')
  check('builds UI: captura artefato do comando e exige revisão humana', !!uiBuild && uiBuild.state==='pending')
  await ev("[...document.querySelectorAll('.production-record > summary')].find(s=>s.textContent.includes('Build pela UI')).click()")
  await ev("[...document.querySelectorAll('.production-record[open] button')].find(b=>b.textContent==='Aprovar build').click()"); await sleep(400)
  check('builds UI: aprovação habilita exportação sem publicar ou executar', (await inv(ev,'listBuilds',gameArg)).value.find(b=>b.id===uiBuild.id).state==='approved' && await ev("[...document.querySelectorAll('.production-record[open] button')].some(b=>b.textContent==='Exportar cópia')") && argvLog().length===productionCalls)
  // Capturas com formulário e registro expandidos; dados longos não escapam do container.
  for (const [w,h] of [[1400,900],[768,1024]]) {
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});await sleep(300)
    for (const tab of ['Assets','Playtests','Builds']) {
      await ev(`[...document.querySelectorAll('.production-nav button')].find(b=>b.textContent.includes('${tab}')).click();document.querySelector('.production').scrollIntoView({block:'start'})`);await sleep(200)
      const measure = await ev(`(() => { const root=document.querySelector('.production'),bounds=root.getBoundingClientRect();const over=[...root.querySelectorAll('input,textarea,select,button,summary,code')].filter(e=>{const b=e.getBoundingClientRect();return b.width && (b.right>bounds.right+1||b.left<bounds.left-1)}).map(e=>e.getAttribute('aria-label')||e.tagName);return {w:innerWidth,scroll:document.documentElement.scrollWidth,over} })()`)
      check(`produção ${tab} em ${w}: controles dentro do painel`,measure.scroll<=measure.w && !measure.over.length,JSON.stringify(measure))
      fs.writeFileSync(path.join(shotDir,`production-${tab.toLowerCase()}-${w}.png`),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).result.data,'base64'))
    }
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});await sleep(300)
  await ev("document.querySelector('button[aria-label=\"Mostrar conversas\"]')?.click()");await sleep(250)
  await ev("[...document.querySelectorAll('button.task')].find(b=>b.textContent.includes('E2E ciclo de produção'))?.click()")
  await sleep(1200)
  const metrics = `(() => {
    const out = []
    for (const e of document.querySelectorAll('.chat > header *, .composer *, .topbar *')) {
      const b = e.getBoundingClientRect()
      if (b.width && (b.right > innerWidth + 1 || b.left < -1)) out.push(e.className || e.tagName)
    }
    const ta = document.querySelector('.composer textarea').getBoundingClientRect()
    const comp = document.querySelector('.composer').getBoundingClientRect()
    return { scrollW: document.documentElement.scrollWidth, w: innerWidth, over: out, taW: Math.round(ta.width), composerBottom: Math.round(comp.bottom), h: innerHeight,
      side: !!document.querySelector('.app.side-open'), panel: !!document.querySelector('.app.panel-open') }
  })()`
  for (const [w, h] of [[1400, 900], [1024, 768], [768, 1024]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(900)
    const m = await ev(metrics)
    const png = (await send('Page.captureScreenshot', { format: 'png' })).result.data
    fs.writeFileSync(path.join(shotDir, `${w}x${h}.png`), Buffer.from(png, 'base64'))
    check(`layout ${w}x${h}: sem rolagem horizontal, sem controles fora da janela, compositor visivel`, m.scrollW <= m.w && m.over.length === 0 && m.taW >= 200 && m.composerBottom <= m.h, JSON.stringify(m))
  }
  // Painéis novos expandidos: a rolagem fica dentro do painel, sem esconder o envio.
  for(const [w,h] of [[1024,768],[768,1024]]){
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false})
    for(const selector of ['.workflow:not(.project-commands)','.project-commands']){
      await ev(`document.querySelector('${selector}').open=true`);await sleep(250)
      const m=await ev(metrics),p=(await send('Page.captureScreenshot',{format:'png'})).result.data
      fs.writeFileSync(path.join(shotDir,`${selector.includes('project')?'commands':'steps'}-${w}.png`),Buffer.from(p,'base64'))
      check(`painel ${selector} em ${w}: compositor acessível`,m.scrollW<=m.w&&m.over.length===0&&m.taW>=200&&m.composerBottom<=m.h,JSON.stringify(m))
      await ev(`document.querySelector('${selector}').open=false`)
    }
  }
  // listas suspensas do compositor: abrem para cima, com todas as opcoes, e fecham com Esc
  await ev("document.querySelector('.composer .dd-btn[aria-label^=Provedor]')?.click()")
  await sleep(300)
  const dd = await ev("(() => { const b = document.querySelector('.composer .dd-btn[aria-label^=Provedor]').getBoundingClientRect(); const m = document.querySelector('.dd-menu')?.getBoundingClientRect(); return { up: !!m && m.bottom <= b.top, top: m?.top ?? -1, opts: document.querySelectorAll('.dd-menu [role=option]').length } })()")
  await ev("document.querySelector('.dd-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(200)
  const closed = await ev("!document.querySelector('.dd-menu')")
  check('lista de provedor abre para cima, dentro da janela, com as 4 opcoes e fecha com Esc', dd.up && dd.top >= 0 && dd.opts === 4 && closed, JSON.stringify({ ...dd, closed }))
  // estado de execucao (streaming ao vivo) no Electron real
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(300) // aguarda o React aplicar o resize e a coluna automática de conversas
  await ev("document.querySelector('button[aria-label=\"Mostrar conversas\"]')?.click()");await sleep(300)
  let selected=false
  for(let i=0;i<20&&!selected;i++){
    await ev("[...document.querySelectorAll('button.task')].find(b=>/xss/i.test(b.textContent))?.click()");await sleep(250)
    selected=await ev("/xss/i.test(document.querySelector('.chat .title')?.textContent||'')")
  }
  if(!selected)throw Error('A tarefa XSS não ficou visível após o resize.')
  await inv(ev, 'sendTask', tX, { provider: 'codex' }, 'TRAVAR para capturar a execucao')
  for (let i = 0; i < 40 && !(await inv(ev, 'taskChat', tX, { provider: 'codex' })).value.live.includes('parcial'); i++) await sleep(250)
  const probe = "({ live: !!document.querySelector('.msg.streaming .who .avatar.live'), stop: !!document.querySelector('.composer button[aria-label=Parar]'), spin: !!document.querySelector('.tasklist .avatar.live'), dock: !!document.querySelector('.dock-btn.busy') })"
  let running = {}
  for (let i = 0; i < 20 && !(running.live && running.stop && running.spin && running.dock); i++) { await sleep(250); running = await ev(probe) } // dock e lista usam polling de 3 s
  fs.writeFileSync(path.join(shotDir, 'execucao.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
  check('estado de execucao: streaming visivel, botao Parar, indicador na lista de tarefas e no dock de agentes', running.live && running.stop && running.spin && running.dock, JSON.stringify(running))
  const busyBackup = await inv(ev, 'createBackup')
  check('backup: agente ativo impede abrir o seletor nativo', !busyBackup.ok && /Pare as execuções|operações pendentes/.test(busyBackup.error), busyBackup.error)
  await inv(ev, 'stopTask', tX)
  await waitDone(ev, tX)
  await send('Emulation.clearDeviceMetricsOverride')
  console.log('   capturas em', shotDir)

  await inv(ev,'deleteTask',productionId)
  const preservedBuild = (await inv(ev,'listBuilds',gameArg)).value.find(b=>b.id===buildId)
  check('builds: excluir tarefa de origem preserva snapshot/comando e limpa vínculos vivos', preservedBuild.source_task_id===null && preservedBuild.source_command_id===null && JSON.parse(preservedBuild.command).program===process.execPath && (await inv(ev,'listPlaytests',gameArg)).value.find(p=>p.id===playtestId).build_id===buildId)

  // migracao no banco real do teste
  const db = new DatabaseSync(path.join(ud, 'dashboard.db'))
  check('banco na versao atual e backup do estado legado criado', db.prepare('PRAGMA user_version').get().user_version === MIGRATIONS.length && fs.readdirSync(ud).some(f => /^dashboard\.db\.v0\..*\.bak$/.test(f)))
  db.close()
  check('sem erros nao tratados no processo principal', !/UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError/.test(app.log()), app.log().split('\n').filter(l => /Error/.test(l)).slice(0, 3).join(' | '))

  // Backup do estado real deste Electron temporário. Seletores nativos são simulados:
  // o serviço copia os bytes; uma próxima abertura exercita a troca offline no main compilado.
  kill(); await sleep(1500)
  const { createBackup, inspectBackup, stageRestore } = await import(pathToFileURL(path.join(ROOT, 'src/main/backups.ts')).href)
  const backupParent = path.join(work, 'backup-export'); fs.mkdirSync(backupParent)
  const beforeBackup = new DatabaseSync(path.join(ud, 'dashboard.db'))
  beforeBackup.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('linkedinAuth','credencial-e2e-nao-copiar')").run()
  const backup = createBackup(beforeBackup, ud, backupParent)
  check('backup: manifesto e banco exportados sem copiar a credencial', inspectBackup(backup.path).files === backup.files && !fs.readFileSync(path.join(backup.path,'dashboard.db')).includes(Buffer.from('credencial-e2e-nao-copiar')))
  beforeBackup.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('backup-e2e-after','estado posterior')").run()
  beforeBackup.close()
  const extraAttachment = path.join(ud,'attachments','apos-backup.txt')
  fs.mkdirSync(path.dirname(extraAttachment),{recursive:true});fs.writeFileSync(extraAttachment,'posterior')
  const cliBeforeRestore = argvLog().length
  stageRestore(ud, backup.path)
  // Bootstrap só de teste. ContextBridge/IPC/serviços de backup são os compilados reais;
  // os diálogos e as consultas a contas são simulados no main antes de abrir o renderer.
  const backupEntry=path.join(work,'backup-ui.cjs'),confirmFile=path.join(work,'backup-confirm.txt')
  fs.writeFileSync(confirmFile,'cancel')
  fs.writeFileSync(backupEntry, `const {dialog,ipcMain}=require('electron');const fs=require('node:fs');
    dialog.showOpenDialog=async o=>({canceled:false,filePaths:[o.title==='Escolher onde guardar o backup'?${JSON.stringify(backupParent)}:o.title==='Selecionar pasta de backup'?${JSON.stringify(backup.path)}:(()=>{throw Error('Diálogo inesperado')})()]});
    dialog.showMessageBox=async o=>{if(o.title!=='Restaurar backup')throw Error('Confirmação inesperada');return {response:fs.readFileSync(${JSON.stringify(confirmFile)},'utf8')==='confirm'?1:0,checkboxChecked:false}};
    require(${JSON.stringify(path.join(ROOT,'out/main/index.js'))});
    for(const [name,value] of Object.entries({diagnose:[],accountStatus:{state:'disconnected'},accountUsage:{error:'fixture sem credenciais'}})){ipcMain.removeHandler(name);ipcMain.handle(name,()=>value)}
  `)
  ;({ ev, send } = await start(ud,backupEntry))
  const info = (await inv(ev,'backupInfo')).value
  check('backup: startup restaura e informa cópia de segurança anterior', !!info?.lastRestore?.safetyPath && inspectBackup(info.lastRestore.safetyPath).schema === MIGRATIONS.length)
  const secondInstance = spawn(path.join(ROOT,'node_modules/electron/dist/electron.exe'),[ROOT,`--user-data-dir=${ud}`],{stdio:'ignore'})
  const secondExit = await Promise.race([new Promise(resolve=>secondInstance.once('exit',resolve)),sleep(8000).then(()=>null)])
  if(secondExit===null){try{execFileSync('taskkill',['/pid',String(secondInstance.pid),'/T','/F'],{stdio:'ignore'})}catch{}}
  check('backup: segunda instância com os mesmos dados sai antes de abrir o banco',secondExit===0,String(secondExit))
  const restoredDb = new DatabaseSync(path.join(ud,'dashboard.db'),{readOnly:true})
  const safetyDb = new DatabaseSync(path.join(info.lastRestore.safetyPath,'dashboard.db'),{readOnly:true})
  check('backup: restauração substitui dados; cópia de segurança preserva estado posterior', !restoredDb.prepare("SELECT 1 FROM settings WHERE key='backup-e2e-after'").get() && !!safetyDb.prepare("SELECT 1 FROM settings WHERE key='backup-e2e-after'").get() && !fs.existsSync(extraAttachment) && fs.existsSync(path.join(info.lastRestore.safetyPath,'attachments','apos-backup.txt')))
  check('backup: restauração não retoma sessões externas nem preserva credencial no banco restaurado', !restoredDb.prepare('SELECT 1 FROM task_sessions LIMIT 1').get() && !restoredDb.prepare("SELECT 1 FROM settings WHERE key='linkedinAuth'").get())
  restoredDb.close();safetyDb.close()
  const restoredBuilds=(await inv(ev,'listBuilds',gameArg)).value
  check('backup: catálogo, revisões humanas e screenshots sobrevivem à restauração', (await inv(ev,'listAssets',gameArg)).value.some(a=>a.versions.some(v=>v.id===firstVersion.id&&v.state==='approved')) && restoredBuilds.some(b=>b.id===buildId&&b.state===preservedBuild.state&&b.hash===preservedBuild.hash) && restoredBuilds.some(b=>b.id===uiBuild.id&&b.state==='approved') && (await inv(ev,'playtestImages',gameArg,playtestId)).value.length===1 && (await inv(ev,'playtestImages',gameArg,uiPlaytest.id)).value.length===1)
  check('backup: reinício não dispara inferência', argvLog().length===cliBeforeRestore)
  const invalidRestore = await inv(ev,'restoreBackup','token-sem-selecao')
  check('backup: restore sem prévia validada é recusado antes da confirmação', !invalidRestore.ok && /Selecione e confira/.test(invalidRestore.error),invalidRestore.error)

  await ev("document.querySelector('button[aria-label=\"Configurações\"]').click()")
  await sleep(400)
  await ev("[...document.querySelectorAll('.set-head [role=tab]')].find(b=>b.textContent==='Dados').click()")
  await sleep(400)
  check('backup: aba Dados apresenta backup e restauração com informações da instalação', (await ev("document.querySelector('.backup-settings').innerText")).includes(ud))
  await ev("[...document.querySelectorAll('.backup-settings button')].find(b=>b.textContent==='Criar backup…').click()")
  for(let i=0;i<40&&!(await ev("!!document.querySelector('.backup-success')"));i++)await sleep(150)
  check('backup: criar pela UI chama serviço real e publica pasta verificável', await ev("!!document.querySelector('.backup-success')") && fs.readdirSync(backupParent).filter(n=>n.startsWith('orbita-backup-')).length===2)
  await ev("[...document.querySelectorAll('.backup-settings button')].find(b=>b.textContent==='Selecionar backup…').click()")
  for(let i=0;i<40&&!(await ev("!!document.querySelector('.backup-restore-btn')"));i++)await sleep(150)
  check('backup: UI mostra sucesso, prévia e aviso antes da ação destrutiva', await ev("(() => {const t=document.querySelector('.backup-settings').innerText;return t.includes('Backup criado.')&&t.includes('Backup selecionado')&&t.includes('sessões de IA novas')&&!![...document.querySelectorAll('.backup-settings button')].find(b=>b.textContent==='Restaurar e reiniciar')})()"))
  for(const [w,h] of [[1400,900],[768,1024]]){
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});await sleep(200)
    const m=await ev("(() => { const root=document.querySelector('.backup-settings'),b=root.getBoundingClientRect();return {w:innerWidth,scroll:document.documentElement.scrollWidth,over:[...root.querySelectorAll('button,dd,.backup-path')].some(e=>{const r=e.getBoundingClientRect();return r.right>b.right+1||r.left<b.left-1})} })()")
    check(`backup: prévia e caminhos cabem em ${w}`,m.scroll<=m.w&&!m.over,JSON.stringify(m))
    fs.writeFileSync(path.join(shotDir,`backup-${w}.png`),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).result.data,'base64'))
  }
  await ev("[...document.querySelectorAll('.backup-settings button')].find(b=>b.textContent==='Restaurar e reiniciar').click()")
  await sleep(300)
  check('backup: cancelar confirmação não prepara restauração nem fecha o app', !fs.existsSync(path.join(ud,'.restore-pending')) && await ev("!!document.querySelector('.backup-restore-btn')&&!document.querySelector('.backup-settings [role=alert]')&&!document.querySelector('.backup-restore-btn').disabled"))
  // Os bytes são adulterados depois da prévia; o manifesto se mantém e o serviço deve recusar.
  fs.writeFileSync(path.join(backup.path,'dashboard.db'),'backup adulterado')
  fs.writeFileSync(confirmFile,'confirm')
  await ev("document.querySelector('.backup-restore-btn').click()")
  await sleep(400)
  check('backup: erro de restauração mantém a prévia e libera os controles', await ev("!!document.querySelector('.backup-settings [role=alert]')&&!!document.querySelector('.backup-summary')&&![...document.querySelectorAll('.backup-settings button')].some(b=>b.disabled)"))
  check('backup: corrupção detectada após a prévia não altera dados atuais nem agenda reinício', !fs.existsSync(path.join(ud,'.restore-pending')) && (await inv(ev,'listBuilds',gameArg)).value.length===restoredBuilds.length)
  check('backup: sem erros não tratados no Electron restaurado', !/UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError/.test(app.log()),app.log().slice(-300))
} catch (e) {
  check('execucao do E2E sem excecao', false, e.stack)
} finally {
  kill()
  const bad = results.filter(r => !r[0])
  console.log(`\n${results.length - bad.length}/${results.length} verificacoes OK`)
  try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(bad.length ? 1 : 0)
}
