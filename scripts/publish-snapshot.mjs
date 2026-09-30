// Copia os arquivos rastreados de um commit (sem historico) para um clone separado da repo publica e procura dados pessoais.
// Nao faz commit nem push: revise o diff la e decida.
// Uso: node scripts/publish-snapshot.mjs <pasta-do-clone-publico> [ref=HEAD]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'

const [target, ref = 'HEAD'] = process.argv.slice(2)
if (!target) { console.error('Uso: node scripts/publish-snapshot.mjs <pasta-do-clone-publico> [ref]'); process.exit(1) }
const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const fail = (m) => { console.error(`ERRO: ${m}`); process.exit(1) }

const root = git(['rev-parse', '--show-toplevel'])
const dest = resolve(target)
if (!existsSync(join(dest, '.git'))) fail(`${dest} nao e um clone git (esperado .git proprio, nao worktree)`)
if (resolve(root) === dest || dest.startsWith(resolve(root) + '\\') || dest.startsWith(resolve(root) + '/')) fail('destino dentro desta repo')
const origin = (cwd) => { try { return git(['remote', 'get-url', 'origin'], cwd) } catch { return '' } }
if (origin(dest) && origin(dest) === origin(root)) fail('destino aponta para o mesmo origin desta repo')
if (git(['status', '--porcelain'], dest)) fail('clone publico tem mudancas pendentes; resolva antes')
if (ref === 'HEAD' && git(['status', '--porcelain', '--untracked-files=no'])) console.warn('Aviso: mudancas nao commitadas aqui NAO vao no snapshot (so o commit HEAD).')

// Arquivos privados nunca podem estar no commit exportado, mesmo que alguem os tenha forcado no Git.
const PRIVATE = /^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.claude\/|docs\/|marketing\/|\.env)/
const files = git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean)
const leaked = files.filter((f) => PRIVATE.test(f))
if (leaked.length) fail(`arquivos privados no commit ${ref}: ${leaked.join(', ')}`)

for (const e of readdirSync(dest)) if (e !== '.git') rmSync(join(dest, e), { recursive: true, force: true })
await new Promise((ok, ko) => {
  const a = spawn('git', ['archive', '--format=tar', ref], { cwd: root })
  const t = spawn('tar', ['-xf', '-'], { cwd: dest, stdio: ['pipe', 'inherit', 'inherit'] })
  a.stdout.pipe(t.stdin)
  t.on('close', (c) => (c ? ko(new Error(`tar saiu com ${c}`)) : ok()))
  a.on('error', ko); t.on('error', ko)
})

// Padroes vindos do ambiente (nunca escritos aqui) + extras opcionais em docs/publish-patterns.txt (privado, um por linha).
const extra = join(root, 'docs', 'publish-patterns.txt')
const tryGit = (args) => { try { return git(args) } catch { return '' } }
const emails = [tryGit(['config', '--global', 'user.email']), git(['log', '-1', '--format=%ae', ref])].filter((e) => e && !e.includes('noreply'))
const needles = [...new Set([userInfo().username, homedir(), homedir().replace(/\\/g, '/'), root, root.replace(/\\/g, '/'), ...emails,
  ...(existsSync(extra) ? readFileSync(extra, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [])])]
  .filter((n) => n.length >= 3).map((n) => n.toLowerCase())
const hits = []
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (e === '.git') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { walk(p); continue }
    const buf = readFileSync(p)
    if (buf.length > 5e6 || buf.includes(0)) continue // binario
    const text = buf.toString('utf8').toLowerCase()
    const rel = relative(dest, p).toLowerCase()
    for (const n of needles) if (text.includes(n) || rel.includes(n)) hits.push(`${relative(dest, p)}: contem "${n}"`)
  }
}
walk(dest)

console.log(`Snapshot de ${git(['rev-parse', '--short', ref])} copiado para ${dest}.`)
console.log(git(['status', '--short'], dest) || '(nada mudou em relacao ao publico)')
if (hits.length) { console.error(`\n${hits.length} possivel(is) dado(s) pessoal(is):\n${hits.join('\n')}`); process.exit(2) }
console.log('\nNenhum padrao pessoal encontrado. Revise o diff no clone publico, depois commit e push la.')
