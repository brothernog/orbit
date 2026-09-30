// Diagnostico das CLIs, log sanitizado e login do Claude com estados.
// Sem dependencia de 'electron' para poder rodar em node --test.
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { q } from './adapters.ts'

export type Category = 'auth' | 'permission' | 'command' | 'config' | 'protocol' | 'unknown'

// Remove URLs (podem carregar codigos de login), tokens e chaves antes de exibir ou gravar.
export const sanitize = (s: string) =>
  s
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|pk|AIza|ghp|gho|xox[bap])[-_A-Za-z0-9]{8,}/g, '<redacted>')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '<redacted>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>')
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1<redacted>')

// Ordem importa: a primeira regra que casar vence.
const RULES: [Category, RegExp][] = [
  ['permission', /trusted directory|untrusted|trust this|permission|EACCES|EPERM|access is denied/i],
  ['auth', /\bauth\b|not logged in|log ?in|unauthori[sz]ed|authenticat|credential|api key|oauth|token|\b40[13]\b|ineligible|subscription/i],
  ['command', /not recognized|ENOENT|command not found|unknown (option|argument|command)|unexpected argument|invalid (value|option)|unrecogni[sz]ed|required option|must provide|usage:/i],
  ['config', /config|settings|toml|provider .*not found|model .*(not found|not available|unknown)|unknown model/i],
  ['protocol', /json|unexpected token|parse|stream|EPIPE|\bEOF\b|malformed/i]
]
export const categorize = (text: string): Category => RULES.find(([, re]) => re.test(text))?.[0] ?? 'unknown'

export type LogEntry = {
  provider: string; profile?: string; cwd?: string; args?: string[]
  code?: number | null; category?: Category; detail?: string
}

// Uma linha JSON por evento. Os argumentos sao os fixos da CLI; o texto do usuario nunca entra aqui.
export function logEvent(file: string, e: LogEntry) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.old`)
    const line = { at: new Date().toISOString(), ...e, args: e.args?.map(sanitize), detail: e.detail && sanitize(e.detail).slice(0, 500) }
    fs.appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {}
}

// sync=true bloqueia ate o taskkill terminar (necessario ao fechar o app: o processo principal sai logo depois).
export function killTree(child: ChildProcess, sync = false) {
  if (!child.pid) return
  // Fora do Windows cliSpawn cria um grupo de processos (detached): o pid negativo mata a CLI e os netos dela.
  if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } return }
  const args = ['/pid', String(child.pid), '/T', '/F']
  if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' })
  else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
}

// Caminho real do executavel (no Windows as CLIs npm sao wrappers .cmd).
export function resolveCli(cmd: string): Promise<string | null> {
  return new Promise(resolve => {
    const c = spawn(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { windowsHide: true })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.on('error', () => resolve(null))
    c.on('close', () => {
      const lines = out.split(/\r?\n/).filter(Boolean)
      resolve((process.platform === 'win32' ? lines.find(l => /\.(cmd|exe|bat)$/i.test(l)) : lines[0]) ?? null)
    })
  })
}

// Inicia uma CLI resolvida por resolveCli. Wrappers .cmd/.bat (npm no Windows) so rodam via cmd.exe, por isso
// os argumentos precisam ser fixos ou validados; texto do usuario nunca vai aqui (use stdin).
// .cmd/.bat so rodam pelo cmd.exe: ali o argumento com espaco precisa de aspas. Executavel direto recebe o argumento como esta (as aspas iriam
// literais para a CLI). Por isso quem monta argumentos passa caminhos SEM aspas; so caracteres ja validados pelo chamador (ver delegation.QUOTE_OK).
export const shellArgs = (args: string[]) => args.map(a => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a))
export function cliSpawn(exe: string, args: string[], o: SpawnOptionsWithoutStdio = {}) {
  const shell = /\.(cmd|bat)$/i.test(exe)
  return spawn(shell ? `"${exe}"` : exe, shell ? shellArgs(args) : args, { ...o, shell, windowsHide: true, detached: process.platform !== 'win32' })
}

// Apps abertos pelo Finder/menu (macOS, Linux) nao herdam o PATH do shell do usuario: sem isso `which claude` falha.
// Le o PATH do shell de login uma vez; marcadores separam o valor de banners impressos pelo .zshrc/.bashrc.
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync(env.SHELL || '/bin/sh', ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.match(/__PATH__(.*)__PATH__/)?.[1] || null
  } catch { return null }
}
// PATH do shell primeiro; entradas que so o processo tinha continuam no fim.
export const mergePath = (login: string | null, current = '', sep = path.delimiter) =>
  login ? [...new Set([...login.split(sep), ...current.split(sep)].filter(Boolean))].join(sep) : current

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
// Script .command do macOS: o `open` entrega o arquivo ao Terminal.app sem repassar o ambiente, entao o script
// exporta so o que o perfil mudou em relacao ao processo (ex.: CLAUDE_CONFIG_DIR) e remove o que o perfil tirou.
export function macTerminalScript(cwd: string, cmdline: string, env: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv = process.env) {
  const ok = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
  const set = Object.keys(env).filter(k => ok(k) && env[k] !== undefined && env[k] !== base[k]).map(k => `export ${k}=${sq(env[k]!)}`)
  const unset = Object.keys(base).filter(k => ok(k) && env[k] === undefined).map(k => `unset ${k}`)
  return ['#!/bin/sh', ...set, ...unset, `cd ${sq(cwd)} || exit 1`, cmdline, ''].join('\n')
}

// Terminal visivel com a CLI (login, sessao interativa). cmdline so leva argumentos fixos/validados, como no cliSpawn.
export function openTerminal(cwd: string, title: string, cmdline: string, env: NodeJS.ProcessEnv) {
  if (process.platform === 'win32') {
    return void spawn('cmd.exe', ['/c', `start ${q(title)} cmd /k ${cmdline}`], { cwd, env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
  }
  if (process.platform === 'darwin') {
    const file = path.join(os.tmpdir(), `orbita-${randomBytes(6).toString('hex')}.command`)
    fs.writeFileSync(file, macTerminalScript(cwd, cmdline, env), { mode: 0o700 })
    return void spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref()
  }
  // Linux: primeiro emulador instalado; o shell no fim mantem a janela aberta, como o `cmd /k` do Windows.
  const terms: [string, string][] = [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']]
  const next = (i: number) => {
    if (i >= terms.length) return
    const c = spawn(terms[i][0], [terms[i][1], 'sh', '-c', `${cmdline}; exec "\${SHELL:-sh}"`], { cwd, env, detached: true, stdio: 'ignore' })
    c.on('error', () => next(i + 1))
    c.unref()
  }
  next(0)
}

export type RunResult = { code: number | null; stdout: string; stderr: string; failed?: string }

// Roda uma CLI com argumentos FIXOS (o texto do usuario nunca vai na linha de comando; use `input`).
export async function runCli(cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number; input?: string } = {}): Promise<RunResult> {
  const exe = path.isAbsolute(cmd) ? cmd : await resolveCli(cmd)
  if (!exe) return { code: null, stdout: '', stderr: '', failed: 'nao encontrado no PATH' }
  return new Promise(resolve => {
    const child = cliSpawn(exe, args, { env: o.env, cwd: o.cwd })
    let stdout = '', stderr = '', failed: string | undefined
    const timer = setTimeout(() => { failed = 'tempo esgotado'; killTree(child) }, o.timeout ?? 30_000)
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    child.stdin.on('error', () => {}) // EPIPE se a CLI sair antes de ler a entrada
    child.stdin.end(o.input)
    child.on('error', e => { failed = e.message })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, failed }) })
  })
}

// ---- Ambiente herdado -----------------------------------------------------------------
// Variaveis que sobrepoem o login do perfil. So os NOMES sao exibidos, nunca os valores.
export const CLAUDE_CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
const WATCHED_ENV: Record<string, string[]> = {
  claude: [...CLAUDE_CREDENTIAL_ENV, 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_SERVER_PASSWORD']
}
export const presentEnv = (provider: string, env: NodeJS.ProcessEnv = process.env) => (WATCHED_ENV[provider] ?? []).filter(k => env[k])

// App aberto de DENTRO de uma sessao do Claude Code (terminal dele, Claude Desktop): o processo herda o estado da sessao anfitria
// (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT, CLAUDE_EFFORT...). Repassado as CLIs, o filho se mistura com a sessao
// do anfitriao (retoma a sessao errada, herda esforco/modo remoto). Com anfitriao detectado, nenhuma CLAUDE*/CLAUDE_CODE_* segue, exceto
// configuracao que o usuario define por conta propria (instalacao/provedor). Sem anfitriao nada muda. So o processo filho e afetado.
const HOST_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']
const USER_CLAUDE_ENV = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])
export function hostlessEnv(base: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; stripped: string[] } {
  if (!HOST_MARKERS.some(k => base[k] !== undefined)) return { env: base, stripped: [] }
  const env = { ...base }
  const stripped = Object.keys(env).filter(k => /^CLAUDE(CODE$|_)/.test(k) && !USER_CLAUDE_ENV.has(k)).sort()
  for (const k of stripped) delete env[k]
  return { env, stripped }
}

// Ambiente de um perfil Claude: usa o CLAUDE_CONFIG_DIR do perfil e ignora credenciais herdadas
// do processo (elas sobreporiam o login da conta). So o processo filho e afetado.
export function claudeEnv(configDir: string | null, base: NodeJS.ProcessEnv = hostlessEnv().env) {
  const env = { ...base }
  const stripped = CLAUDE_CREDENTIAL_ENV.filter(k => env[k])
  for (const k of CLAUDE_CREDENTIAL_ENV) delete env[k]
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  else delete env.CLAUDE_CONFIG_DIR
  return { env, stripped }
}

// ---- Diagnostico por provedor ---------------------------------------------------------
// Consultas gratuitas: --version/--help e comandos de status. Nenhuma chamada de inferencia.
const PROBES: Record<string, { helps: { args: string[]; flags: string[] }[] }> = {
  claude: { helps: [{ args: ['--help'], flags: ['--resume', '--effort', '--permission-mode', '--output-format'] }, { args: ['auth', 'login', '--help'], flags: ['--claudeai'] }] },
  codex: { helps: [{ args: ['exec', '--help'], flags: ['--json', '--skip-git-repo-check', '--sandbox', 'resume'] }] },
  gemini: { helps: [{ args: ['--help'], flags: ['--resume', '--session-id', '--approval-mode', 'stream-json'] }] },
  opencode: { helps: [{ args: ['run', '--help'], flags: ['--session', '--format', '--variant', '--model'] }] }
}

export type ProviderInfo = {
  id: string; exe: string | null; version: string | null
  capabilities: string[]; missing: string[]; env: string[]; failed?: string
}

export async function probeProvider(id: string): Promise<ProviderInfo> {
  const exe = await resolveCli(id)
  const info: ProviderInfo = { id, exe, version: null, capabilities: [], missing: [], env: presentEnv(id) }
  if (!exe) return { ...info, failed: 'Nao instalado ou fora do PATH.' }
  const [v, ...helps] = await Promise.all([
    runCli(exe, ['--version']),
    ...PROBES[id].helps.map(h => runCli(exe, h.args))
  ])
  info.version = v.code === 0 ? v.stdout.trim().split(/\r?\n/)[0] : null
  if (v.code !== 0) info.failed = sanitize(v.failed ?? (v.stderr || v.stdout)).slice(0, 300)
  PROBES[id].helps.forEach((h, i) => {
    const text = helps[i].stdout + helps[i].stderr
    for (const f of h.flags) (helps[i].code === 0 && text.includes(f) ? info.capabilities : info.missing).push(f)
  })
  return info
}

export type AuthState = { state: 'connected' | 'disconnected' | 'unknown'; detail?: string; email?: string; plan?: string }

export async function claudeStatus(env: NodeJS.ProcessEnv): Promise<AuthState> {
  const r = await runCli('claude', ['auth', 'status'], { env })
  try {
    const j = JSON.parse(r.stdout) // logado: exit 0; deslogado: exit 1 com JSON valido
    return j.loggedIn
      ? { state: 'connected', email: j.email, plan: j.subscriptionType, detail: j.authMethod }
      : { state: 'disconnected' }
  } catch {
    return { state: 'unknown', detail: sanitize(r.failed ?? (r.stderr || r.stdout)).slice(0, 300) }
  }
}

export async function providerAuth(id: string): Promise<AuthState> {
  if (id === 'codex') {
    const r = await runCli('codex', ['login', 'status'])
    const line = sanitize((r.stdout || r.stderr).trim().split(/\r?\n/)[0] ?? '')
    return r.failed ? { state: 'unknown', detail: r.failed } : { state: r.code === 0 ? 'connected' : 'disconnected', detail: line }
  }
  if (id === 'opencode') {
    const r = await runCli('opencode', ['auth', 'list'])
    const n = Number(/(\d+) credentials?/.exec(r.stdout.replace(/\x1b\[[0-9;]*m/g, ''))?.[1] ?? 0)
    return r.failed ? { state: 'unknown', detail: r.failed } : n ? { state: 'connected', detail: `${n} credencial(is) salva(s)` } : { state: 'disconnected' }
  }
  if (id === 'gemini') {
    // Sem comando de status: `--list-sessions` autentica ao iniciar (sem inferencia) e sai com 0 mesmo
    // quando a autenticacao falha, avisando so no stderr.
    const r = await runCli('gemini', ['--list-sessions'], { timeout: 60_000 })
    const bad = /Error authenticating:?\s*([^\r\n]*)/.exec(r.stderr)
    if (r.failed) return { state: 'unknown', detail: r.failed }
    if (bad) return { state: 'disconnected', detail: sanitize(bad[1]).slice(0, 300) }
    return { state: r.code === 0 ? 'connected' : 'unknown', detail: r.code === 0 ? 'autenticacao validada sem inferencia' : sanitize(r.stderr).slice(0, 300) }
  }
  return { state: 'unknown' }
}

// ---- Login Claude ---------------------------------------------------------------------
// `claude auth login` abre o navegador e espera o retorno; roda oculto, com timeout e um por perfil.
export type LoginState = { state: 'connecting' | 'connected' | 'error'; error?: string }
const logins = new Map<string, LoginState & { child?: ChildProcess }>()
export const loginState = (key: string): LoginState | undefined => {
  const l = logins.get(key)
  return l && { state: l.state, error: l.error }
}

export function startLogin(key: string, env: NodeJS.ProcessEnv, log: (e: Partial<LogEntry>) => void, timeout = 300_000) {
  if (logins.get(key)?.state === 'connecting') throw new Error('Ja existe um login em andamento para esta conta.')
  const entry: LoginState & { child?: ChildProcess } = { state: 'connecting' }
  logins.set(key, entry)
  const fail = (error: string, code?: number | null) => {
    entry.state = 'error'; entry.error = error; entry.child = undefined
    log({ code, category: categorize(error), detail: error })
  }
  ;(async () => {
    const exe = await resolveCli('claude')
    if (entry.state !== 'connecting') return // cancelado enquanto resolvia o executavel
    if (!exe) return fail('claude nao encontrado no PATH.')
    const child = cliSpawn(exe, ['auth', 'login'], { env })
    child.stdin.end() // sem entrada: o retorno do login chega pelo navegador
    child.stdout.resume() // descarta a saida (contem a URL de login, que nao deve ser exibida nem registrada)
    entry.child = child
    let err = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeout)
    child.stderr.on('data', d => { err = (err + d).slice(-2000) })
    child.on('error', e => { clearTimeout(timer); fail(sanitize(e.message)) })
    child.on('close', async code => {
      clearTimeout(timer)
      if (entry.state !== 'connecting') return
      if (timedOut) return fail('Tempo esgotado esperando o login no navegador.', code)
      if (code !== 0) return fail(sanitize(err).trim() || `login terminou com codigo ${code}`, code)
      const s = await claudeStatus(env)
      if (s.state === 'connected') { entry.state = 'connected'; entry.child = undefined; log({ code, detail: 'login confirmado por auth status' }) }
      else fail('O login terminou, mas a conta nao aparece autenticada em `claude auth status`.', code)
    })
  })()
}

export function cancelLogin(key: string) {
  const l = logins.get(key)
  if (l?.state !== 'connecting') return
  l.state = 'error'; l.error = 'Login cancelado.'
  if (l.child) killTree(l.child)
}
