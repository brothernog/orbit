// Capturas das telas principais (build de out/: rode 'npm run build' antes), com dados sinteticos e CLIs falsas.
// Serve para revisar mudancas visuais sem abrir o app real. Uso: node scripts/shots.mjs [pasta-de-saida]
// Linux sem tela: xvfb-run -a --server-args="-screen 0 1920x1080x24" node scripts/shots.mjs
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'orbit-shots'))
fs.mkdirSync(OUT, { recursive: true })
const electron = createRequire(import.meta.url)('electron')
const tmp = WIN ? os.tmpdir() : fs.realpathSync(os.tmpdir())
const work = fs.mkdtempSync(path.join(tmp, 'orbit-shots-'))
const ud = path.join(work, 'userdata'), bin = path.join(work, 'bin')
const projs = ['nebula-runner', 'pixel-forge', 'site-portfolio'].map(n => path.join(work, n))
for (const d of [ud, bin, ...projs]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(projs[0], 'roadmap.md'), '# Roadmap\n- [x] Movimento base\n- [ ] Inimigos voadores\n- [ ] Chefe da fase 2\n')
fs.writeFileSync(path.join(projs[0], 'README.md'), '# Nebula Runner\nPlataforma 2D.\n')
execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init', { cwd: projs[0] })
fs.copyFileSync(path.join(ROOT, 'scripts/e2e/fake-cli.js'), path.join(bin, 'fake-cli.js'))
for (const k of ['codex', 'opencode']) {
  if (WIN) fs.writeFileSync(path.join(bin, `${k}.cmd`), `@echo off\r\nnode "%~dp0fake-cli.js" ${k} %*\r\n`)
  else fs.writeFileSync(path.join(bin, k), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-cli.js" ${k} "$@"\n`, { mode: 0o755 })
}
const loginSh = path.join(work, 'login-sh')
if (!WIN) { fs.mkdirSync(path.join(work, 'home')); fs.writeFileSync(loginSh, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 }) }

const { MIGRATIONS } = await import(pathToFileURL(path.join(ROOT, 'src/main/db.ts')).href)
{
  const db = new DatabaseSync(path.join(ud, 'dashboard.db'))
  for (const m of MIGRATIONS) m(db)
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
  db.prepare("INSERT INTO accounts (name, config_dir) VALUES ('Principal', NULL)").run()
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('extraGames', JSON.stringify(projs))
  const task = (g, title, state, ago) => Number(db.prepare(`INSERT INTO tasks (game, title, state, updated_at) VALUES (?, ?, ?, datetime('now', ?))`).run(g, title, state, ago).lastInsertRowid)
  const msg = (t, role, text, provider = 'codex') => db.prepare("INSERT INTO messages (chat_key, task_id, role, text, provider, status) VALUES (?, ?, ?, ?, ?, 'completed')").run(`task:${t}`, t, role, text, role === 'user' ? null : provider)
  const t1 = task(projs[0], 'Pulo duplo com coyote time', 'andamento', '-3 minutes')
  msg(t1, 'user', 'Implementa o pulo duplo no player e adiciona coyote time de 120 ms.')
  msg(t1, 'agent', 'Pronto. Mudei três arquivos:\n\n- `player.gd`: contador de pulos e janela de coyote\n- `input_map.tres`: ação `jump` com buffer\n- `tests/test_jump.gd`: 4 casos novos\n\n```gdscript\nif is_on_floor():\n    coyote = COYOTE_TIME\nelif coyote > 0.0:\n    coyote -= delta\n```\n\nTodos os testes passaram. Quer que eu ajuste a altura do segundo pulo?')
  msg(t1, 'user', 'Sim, 80% do primeiro.')
  msg(t1, 'agent', 'Ajustado: `JUMP_2 = JUMP_1 * 0.8`. Rodei a cena de teste e o arco ficou natural.')
  task(projs[0], 'Inimigos voadores na fase 2', 'aberta', '-2 hours')
  task(projs[0], 'Corrigir colisão na rampa', 'aberta', '-1 days')
  task(projs[0], 'Menu de pausa', 'concluida', '-3 days')
  task(projs[1], 'Exportar sprites em lote', 'aberta', '-5 hours')
  task(projs[2], 'Página de contato', 'aberta', '-2 days')
  db.close()
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const listener = createServer()
await new Promise(r => listener.listen(0, '127.0.0.1', r))
const port = listener.address().port
await new Promise(r => listener.close(r))
const { ELECTRON_RENDERER_URL: _dev, ...cleanEnv } = process.env
const iso = WIN ? { PATH: `${bin};${process.env.PATH}` } : { PATH: [bin, '/usr/bin', '/bin'].join(':'), HOME: path.join(work, 'home'), SHELL: loginSh }
const args = process.platform === 'darwin' ? ['--use-mock-keychain'] : WIN ? [] : ['--password-store=basic', '--no-sandbox']
const app = spawn(electron, [ROOT, `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, ...args], { env: { ...cleanEnv, ...iso, E2E_LOG: path.join(work, 'argv.log'), E2E_PIDS: path.join(work, 'pids'), CODEX_HOME: path.join(work, 'codexhome') }, stdio: 'ignore' })
const killAll = () => { try { if (WIN) execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }); else process.kill(app.pid, 'SIGKILL') } catch {} }
try {
  let page
  for (let i = 0; i < 60 && !page; i++) { await sleep(500); try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && !p.url.includes('#')) } catch {} }
  if (!page) throw Error('renderer nao abriu')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => (ws.onopen = r))
  let id = 0; const pend = new Map()
  ws.onmessage = m => { const j = JSON.parse(m.data); pend.get(j.id)?.(j); pend.delete(j.id) }
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result?.value
  const shot = async (n, w = 1600, h = 960) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(900)
    const d = (await send('Page.captureScreenshot', { format: 'png' })).result.data
    fs.writeFileSync(path.join(OUT, `${n}.png`), Buffer.from(d, 'base64'))
    console.log('shot', n)
  }
  const click = async sel => { const ok = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true })()`); if (!ok) console.log('nao achei', sel); await sleep(700); return ok }
  const key = (k, mods = {}) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${!!mods.ctrl}, bubbles: true }))`)
  await sleep(2500)
  const only = (process.env.SHOTS ?? '').split(',').filter(Boolean) // ex.: SHOTS=03-chat,05-configuracoes
  const want = n => !only.length || only.some(o => n.startsWith(o))
  const snap = async (n, w, h) => { if (want(n)) await shot(n, w, h) }
  await snap('01-inicio')
  await snap('01b-inicio-estreito', 1100, 800)
  await click('.rail-ws')
  await sleep(800)
  await snap('02-projeto')
  await click('button.task')
  await sleep(800)
  await snap('03-chat')
  await snap('03b-chat-estreito', 1100, 800)
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false })
  if (await click('.topbar button[aria-label="Abrir painel do projeto"]')) await snap('03c-chat-painel')
  await click('.topbar button[aria-label="Recolher painel do projeto"]')
  await ev(`(() => { const b = document.querySelector('.row-more'); const r = b.getBoundingClientRect(); b.click() })()`)
  await sleep(300)
  await snap('03d-menu-contexto')
  await key('Escape'); await ev("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))"); await sleep(200)
  await click('.dock-btn')
  await snap('03e-dock')
  await click('.dock-btn')
  await key('k', { ctrl: true })
  await sleep(400)
  await snap('04-busca')
  await ev("document.querySelector('.pal-back')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
  await sleep(300)
  await click('.rail button[aria-label="Configurações"]')
  await snap('05-configuracoes')
  const tabs = await ev("[...document.querySelectorAll('.set-head [role=tab]')].map(b => b.textContent)") ?? []
  for (const [i, t] of tabs.entries()) if (i) { await ev(`document.querySelectorAll('.set-head [role=tab]')[${i}].click()`); await sleep(400); await snap(`05${String.fromCharCode(97 + i)}-config-${t.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}`) }
  await click('.rail button[aria-label="LinkedIn"]')
  await snap('06-linkedin')
} finally { killAll(); await sleep(500); try { fs.rmSync(work, { recursive: true, force: true }) } catch {} }
