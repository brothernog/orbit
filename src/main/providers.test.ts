// node --test src/main/providers.test.ts  (CLIs simuladas: nenhuma chamada paga)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { q } from './adapters.ts'
import { cancelLogin, categorize, claudeEnv, claudeStatus, cliSpawn, hostlessEnv, killTree, logEvent, loginState, macTerminalScript, mergePath, presentEnv, runCli, sanitize, shellArgs, startLogin } from './providers.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-test-'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout no teste'); await sleep(50) } }

// claude.cmd falso no inicio do PATH: `auth login` e `auth status` controlados por FAKE_*.
fs.writeFileSync(path.join(tmp, 'fake-claude.js'), `
const [a, b] = process.argv.slice(2), mode = process.env.FAKE_MODE
if (a === 'auth' && b === 'status') {
  const ok = process.env.FAKE_LOGGED === '1'
  console.log(JSON.stringify(ok ? { loggedIn: true, email: 'a@b.c', subscriptionType: 'pro', authMethod: 'claude.ai' } : { loggedIn: false, authMethod: 'none' }))
  process.exit(ok ? 0 : 1)
}
if (a === 'auth' && b === 'login') {
  if (mode === 'hang') setInterval(() => {}, 1000)
  else if (mode === 'fail') { console.error('erro ao abrir https://claude.ai/oauth/authorize?code=SEGREDO123456 token=abcdef'); process.exit(1) }
  else setTimeout(() => process.exit(0), 200)
}
`)
fs.writeFileSync(path.join(tmp, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n')
const win = process.platform === 'win32'
if (win) process.env.PATH = `${tmp};${process.env.PATH}`
const env = (extra: Record<string, string>) => ({ ...process.env, ...extra })

test('sanitize remove URLs, tokens e chaves', () => {
  const out = sanitize('visit https://claude.ai/oauth?code=abc Bearer abc.def-ghi sk-ant-abcdefgh12345 api_key=zzz123 ' + 'a'.repeat(40))
  assert.doesNotMatch(out, /claude\.ai|abc\.def|sk-ant|zzz123|aaaaaaaa/)
})

test('categorize usa evidencias reais das CLIs', () => {
  assert.equal(categorize('Not inside a trusted directory and --skip-git-repo-check was not specified.'), 'permission')
  assert.equal(categorize('IneligibleTierError: This client is no longer supported'), 'auth')
  assert.equal(categorize('Error: You must provide a message or a command'), 'command')
  assert.equal(categorize('Error: Model provider `x` not found'), 'config')
  assert.equal(categorize("'gemini' is not recognized as an internal or external command"), 'command')
  assert.equal(categorize('Unexpected server error. Check server logs for details.'), 'unknown')
})

test('logEvent grava JSONL sanitizado', () => {
  const file = path.join(tmp, 'diag.log')
  logEvent(file, { provider: 'codex', args: ['exec', 'https://x.y/z'], code: 1, category: 'auth', detail: 'token=segredo https://a.b/c' })
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  assert.equal(line.provider, 'codex')
  assert.doesNotMatch(JSON.stringify(line), /segredo|a\.b|x\.y/)
})

test('claudeEnv ignora credenciais herdadas e escolhe o perfil; presentEnv so lista nomes', () => {
  const base = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: 'x', KEEP: '1' }
  const a = claudeEnv('C:/perfil', base)
  assert.deepEqual(a.stripped, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(a.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(a.env.CLAUDE_CONFIG_DIR, 'C:/perfil')
  assert.equal(a.env.KEEP, '1')
  assert.equal(claudeEnv(null, base).env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(base.ANTHROPIC_API_KEY, 'k') // o processo original nao muda
  assert.deepEqual(presentEnv('claude', base), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'])
})

test('runCli: stdin grande com saida antecipada nao derruba o processo', async () => {
  const script = path.join(tmp, 'early-exit.js')
  fs.writeFileSync(script, "console.error('bad flag'); process.exit(2)")
  const r = await runCli(process.execPath, [script], { input: 'x'.repeat(3_000_000) })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /bad flag/)
})

test('runCli: timeout mata o processo', async () => {
  const script = path.join(tmp, 'hang.js')
  fs.writeFileSync(script, 'setInterval(() => {}, 1000)')
  const r = await runCli(process.execPath, [script], { timeout: 300 })
  assert.equal(r.failed, 'tempo esgotado')
})

test('runCli: executavel ausente vira erro claro', async () => {
  assert.match((await runCli('cli-que-nao-existe-xyz', ['--version'])).failed ?? '', /nao encontrado/)
})

test('claudeStatus le JSON de conectado e de desconectado (exit 1)', { skip: !win }, async () => {
  assert.equal((await claudeStatus(env({ FAKE_LOGGED: '1' }))).state, 'connected')
  assert.equal((await claudeStatus(env({ FAKE_LOGGED: '0' }))).state, 'disconnected')
})

test('login: conecta, confirma por auth status e bloqueia login concorrente', { skip: !win }, async () => {
  const key = 'ok'
  startLogin(key, env({ FAKE_MODE: 'ok', FAKE_LOGGED: '1' }), () => {})
  assert.equal(loginState(key)?.state, 'connecting')
  assert.throws(() => startLogin(key, env({}), () => {}), /em andamento/)
  await until(() => loginState(key)?.state !== 'connecting')
  assert.equal(loginState(key)?.state, 'connected')
})

test('login: falha vira erro sem vazar URL nem token', { skip: !win }, async () => {
  startLogin('fail', env({ FAKE_MODE: 'fail' }), () => {})
  await until(() => loginState('fail')?.state !== 'connecting')
  const s = loginState('fail')!
  assert.equal(s.state, 'error')
  assert.doesNotMatch(s.error!, /SEGREDO|abcdef|claude\.ai/)
})

test('login: termina com codigo 0 mas sem conta autenticada = erro', { skip: !win }, async () => {
  startLogin('nolog', env({ FAKE_MODE: 'ok', FAKE_LOGGED: '0' }), () => {})
  await until(() => loginState('nolog')?.state !== 'connecting')
  assert.equal(loginState('nolog')?.state, 'error')
})

test('login: cancelar e timeout encerram o processo e liberam o perfil', { skip: !win }, async () => {
  startLogin('cancel', env({ FAKE_MODE: 'hang' }), () => {})
  await sleep(500)
  cancelLogin('cancel')
  assert.equal(loginState('cancel')?.state, 'error')
  startLogin('cancel', env({ FAKE_MODE: 'ok', FAKE_LOGGED: '1' }), () => {}) // pode tentar de novo
  await until(() => loginState('cancel')?.state === 'connected')

  startLogin('slow', env({ FAKE_MODE: 'hang' }), () => {}, 500)
  await until(() => loginState('slow')?.state !== 'connecting')
  assert.match(loginState('slow')!.error!, /Tempo esgotado/)
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('argumentos: aspas so para o cmd.exe (.cmd/.bat) e so onde ha espaco; executavel direto recebe o argumento puro', () => {
  assert.deepEqual(shellArgs(['--mcp-config', 'C:\\Users\\Ana Maria\\AppData\\mcp\\mcp-1.json', '-p', '" "', '--tools=']), ['--mcp-config', '"C:\\Users\\Ana Maria\\AppData\\mcp\\mcp-1.json"', '-p', '" "', '--tools='])
  assert.deepEqual(shellArgs(['--resume', 'abc']), ['--resume', 'abc'])
})

test('hostlessEnv: dentro de uma sessao do Claude Code nao repassa o estado dela; fora, nada muda', () => {
  const host = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-host', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_EFFORT: 'max', CLAUDE_PID: '9', CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_CONFIG_DIR: 'C:/perfil', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDEX: 'fica', PATH: '/bin' }
  const h = hostlessEnv(host)
  assert.deepEqual(h.stripped, ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID'])
  assert.deepEqual(Object.keys(h.env).sort(), ['CLAUDEX', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'PATH'])
  assert.equal(host.CLAUDE_CODE_SESSION_ID, 'sess-host') // o ambiente original nao e alterado
  // So o marcador de sessao basta para detectar o anfitriao
  assert.deepEqual(hostlessEnv({ CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9' }).stripped, ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_SESSION_ID'])
  // Sem anfitriao: configuracao propria do usuario segue intacta
  const own = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9', PATH: '/bin' }
  assert.deepEqual(hostlessEnv(own), { env: own, stripped: [] })
  // claudeEnv aplica os dois filtros quando recebe a base sem anfitriao
  const c = claudeEnv('C:/p', hostlessEnv({ ...host, ANTHROPIC_API_KEY: 'k' }).env)
  assert.equal(c.env.CLAUDE_CODE_SESSION_ID, undefined)
  assert.equal(c.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(c.env.CLAUDE_CONFIG_DIR, 'C:/p')
})

test('PATH do shell de login vem primeiro, sem duplicar, e entradas so do processo ficam', () => {
  assert.equal(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', ':'), '/opt/homebrew/bin:/usr/bin:/bin')
  assert.equal(mergePath(null, '/usr/bin', ':'), '/usr/bin')
})

test('script do Terminal (macOS) exporta so o que o perfil mudou, remove o que tirou e protege aspas', () => {
  const s = macTerminalScript("/Users/a/meu jogo's", 'claude', { HOME: '/Users/a', CLAUDE_CONFIG_DIR: "/c/x'y" }, { HOME: '/Users/a', ANTHROPIC_API_KEY: 'k' })
  assert.deepEqual(s.split('\n'), ['#!/bin/sh', "export CLAUDE_CONFIG_DIR='/c/x'\\''y'", 'unset ANTHROPIC_API_KEY', "cd '/Users/a/meu jogo'\\''s' || exit 1", 'claude', ''])
})

test('terminal prompt: cmd.exe drops the dangerous characters; sh gets the literal text in single quotes', () => {
  assert.equal(q('a"b&c%d\n', true), '"a b c d"')
  assert.equal(q("it's $(x) `y` $HOME\nz", false), `'it'\\''s $(x) \`y\` $HOME z'`)
})

test('prompt with $( ), backticks and $VAR executes nothing in the Terminal script', { skip: win }, () => {
  const canary = path.join(tmp, 'pwned')
  const text = `Bug $(touch ${canary}) \`touch ${canary}\` $HOME it's "x"`
  const file = path.join(tmp, 'prompt.command')
  fs.writeFileSync(file, macTerminalScript(tmp, `printf %s ${q(text)}`, process.env))
  assert.equal(execFileSync('/bin/sh', [file], { encoding: 'utf8' }), text)
  assert.equal(fs.existsSync(canary), false)
})

test('killTree fora do Windows derruba os netos da CLI (grupo de processos)', { skip: process.platform === 'win32' }, async () => {
  const child = cliSpawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'])
  const grandchild = Number(await new Promise<string>(r => child.stdout.once('data', d => r(String(d)))))
  killTree(child)
  await new Promise(r => child.once('close', r))
  await new Promise(r => setTimeout(r, 100))
  assert.throws(() => process.kill(grandchild, 0)) // neto nao existe mais
})
