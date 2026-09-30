// Instancia SECUNDARIA da dashboard para testar correcoes sem fechar a que esta em uso.
// Usa o build de out/ (rode 'npm run build' antes), uma pasta de dados TEMPORARIA (nunca o banco real) e porta de debug propria.
// Uso: npm run dev:sandbox [-- --keep] [-- --seed <dashboard.db copiado>]
//   GPD_DISPLAY=2 abre no segundo monitor; GPD_SANDBOX_PORT fixa a porta de debug (padrao: livre a partir de 9400).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const seedAt = args.indexOf('--seed')
const seed = seedAt >= 0 ? path.resolve(args[seedAt + 1] ?? '') : null

if (!fs.existsSync(path.join(ROOT, 'out/main/index.js'))) {
  console.error("Build ausente: rode 'npm run build' antes.")
  process.exit(1)
}
if (seed && !fs.existsSync(seed)) { console.error(`--seed nao encontrado: ${seed}`); process.exit(1) }

const freePort = start => new Promise(resolve => {
  const tryPort = p => {
    const s = net.createServer().once('error', () => tryPort(p + 1)).once('listening', () => s.close(() => resolve(p))).listen(p, '127.0.0.1')
  }
  tryPort(start)
})

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-sandbox-'))
const userData = path.join(work, 'userdata')
fs.mkdirSync(userData, { recursive: true })
// O seed e sempre uma COPIA que o usuario forneceu; o banco real nunca e aberto por este script.
if (seed) fs.copyFileSync(seed, path.join(userData, 'dashboard.db'))
const port = process.env.GPD_SANDBOX_PORT ? Number(process.env.GPD_SANDBOX_PORT) : await freePort(9400)

// Sem ELECTRON_RENDERER_URL herdada (ex.: de um 'electron-vite dev' em execucao): a sandbox abre o renderer COMPILADO em out/, isolado do servidor de desenvolvimento.
const { ELECTRON_RENDERER_URL: _dev, ...cleanEnv } = process.env
const electron = createRequire(import.meta.url)('electron') // binary path on any OS
const app = spawn(electron, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
  env: { ...cleanEnv, CODEX_HOME: path.join(work, 'codexhome'), GPD_DISPLAY: process.env.GPD_DISPLAY ?? '2' }, stdio: 'inherit'
})
console.log(`sandbox: pid ${app.pid}, dados em ${userData}, debug em http://127.0.0.1:${port}/json/list`)
console.log('CODEX_HOME isolado; logins das outras CLIs continuam os do usuario (nao ha mock aqui: use o e2e para CLIs falsas).')

// Encerra SOMENTE o processo criado por este script (nunca por nome de imagem).
const stop = () => { try { app.kill() } catch {} }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
app.on('exit', code => {
  if (!keep) fs.rmSync(work, { recursive: true, force: true })
  else console.log(`dados mantidos em ${work}`)
  process.exit(code ?? 0)
})
