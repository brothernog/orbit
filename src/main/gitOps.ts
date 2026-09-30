// Branch, commit, push, PR e issues de uma pasta (ou worktree). Git local + GitHub CLI (`gh`) com o login que o usuario ja tem.
// Tudo que publica (push, PR, issue) so roda por clique confirmado na interface. Sem dependencia de 'electron'.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseStatus, run } from './projectInfo.ts'
import { changedFiles } from './fileWatch.ts'

const gh = (cwd: string, args: string[]) => new Promise<string>((ok, fail) =>
  execFile('gh', args, { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 4 << 20 }, (e, out, err) =>
    (e ? fail(new Error(ghError(String(err || e.message)))) : ok(out))))

// Mensagens do gh em portugues curto: o usuario precisa saber o que fazer, nao ler o log.
export function ghError(s: string): string {
  if (/ENOENT|not recognized|nao e reconhecido/i.test(s)) return 'GitHub CLI (gh) não encontrado. Instale em cli.github.com para ver PRs e issues.'
  if (/auth login|not logged|authentication/i.test(s)) return 'O gh não está logado. Rode "gh auth login" num terminal.'
  if (/no pull requests? found/i.test(s)) return 'Sem PR para esta branch.'
  if (/is the same as base branch/i.test(s)) return 'Você está na branch principal. Um PR precisa de outra branch (crie uma e faça o commit nela).'
  if (/could not determine|no git remotes|not a git repository|none of the git remotes/i.test(s)) return 'Esta pasta não tem um remoto do GitHub.'
  return s.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 240) ?? 'Falha no gh.'
}

// Branch sem upstream: o primeiro push cria o remoto e passa a acompanhar (-u).
export const pushArgs = (branch: string | null, upstream: string | null) =>
  upstream || !branch ? ['push'] : ['push', '-u', 'origin', branch]

export type Commit = { sha: string; subject: string; when: string }
const parseLog = (out: string): Commit[] => out.split(/\r?\n/).filter(Boolean).map(l => { const [sha, when, ...s] = l.split('\x1f'); return { sha, when, subject: s.join('\x1f') } })

// Branch principal do remoto (origin/HEAD). Clone antigo sem origin/HEAD: main ou master, o que existir no remoto.
export async function defaultBranch(dir: string): Promise<string | null> {
  try { return (await run(dir, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim().replace(/^origin\//, '') } catch {}
  for (const b of ['main', 'master']) try { await run(dir, ['rev-parse', '--verify', '-q', `origin/${b}`]); return b } catch {}
  return null
}

export async function branchView(dir: string) {
  const st = parseStatus(await run(dir, ['status', '--porcelain=v1', '-b']))
  const { files } = await changedFiles(dir)
  let toPush: Commit[] = [], recent: Commit[] = []
  const fmt = '--format=%h\x1f%cr\x1f%s'
  if (st.upstream) try { toPush = parseLog(await run(dir, ['log', `${st.upstream}..HEAD`, fmt, '-n', '20'])) } catch {}
  try { recent = parseLog(await run(dir, ['log', fmt, '-n', '5'])) } catch {} // repositorio sem commit
  return { branch: st.branch, base: await defaultBranch(dir), upstream: st.upstream, ahead: st.ahead, behind: st.behind, files, toPush, recent }
}

// Sem `paths`: tudo. Com `paths`: so esses (inclusive novos e apagados); o resto do indice fica fora do commit.
// `:(literal)` impede que nomes com * ou : virem padrao do git.
export function commitSteps(message: string, paths?: string[]) {
  const spec = paths?.length ? ['--', ...paths.map(p => `:(literal)${p}`)] : []
  return [['add', '-A', ...spec], ['commit', '-m', message, ...spec]]
}

export type Part = { path: string; skip: string[] } // arquivo com trechos (hunks) desmarcados, pelo cabecalho "@@ ... @@"

// Patch so com os trechos marcados do diff de um arquivo. Cabecalho desmarcado que nao existe mais = o arquivo mudou.
export function pickHunks(diff: string, skip: string[]): string {
  const lines = diff.split('\n') // o CR fica: arquivo CRLF precisa dele para o patch casar
  const first = lines.findIndex(l => l.startsWith('@@'))
  if (first < 0) throw new Error('Sem trechos para escolher neste arquivo.')
  const hunks: string[][] = []
  for (const l of lines.slice(first)) l.startsWith('@@') ? hunks.push([l]) : hunks[hunks.length - 1].push(l)
  const heads = hunks.map(h => h[0].trim())
  if (skip.some(s => !heads.includes(s.trim()))) throw new Error('O arquivo mudou desde que você abriu o diff. Atualize e escolha de novo.')
  const keep = hunks.filter(h => !skip.some(s => s.trim() === h[0].trim()))
  if (!keep.length) throw new Error('Nenhum trecho marcado.')
  return [...lines.slice(0, first), ...keep.flat()].join('\n').replace(/\n*$/, '\n')
}

// Com trechos: monta o commit num indice temporario (a partir do HEAD), para nao misturar com o que ja estava no indice.
// Depois alinha o indice real so nesses caminhos. Sem trechos: `commitSteps`.
export async function commitAll(dir: string, message: string, paths?: string[], parts?: Part[]) {
  if (!parts?.length) { for (const args of commitSteps(message, paths)) await run(dir, args); return }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-idx-'))
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
  const lit = (ps: string[]) => ps.map(p => `:(literal)${p}`)
  try {
    await run(dir, ['read-tree', 'HEAD'], { env })
    if (paths?.length) await run(dir, ['add', '-A', '--', ...lit(paths)], { env })
    for (const p of parts) {
      const patch = path.join(tmp, 'p.diff')
      fs.writeFileSync(patch, pickHunks(await run(dir, ['diff', 'HEAD', '--no-color', '--', lit([p.path])[0]]), p.skip))
      await run(dir, ['apply', '--cached', '--recount', patch], { env })
    }
    await run(dir, ['commit', '-m', message], { env })
    await run(dir, ['reset', '-q', '--', ...lit([...(paths ?? []), ...parts.map(p => p.path)])])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// Antes de publicar: busca o remoto e diz quantos commits novos ha la. Sem rede/remoto: null (o push explica o erro).
export async function remoteAhead(dir: string): Promise<number | null> {
  try { await run(dir, ['fetch', '--quiet'], { timeout: 60_000 }) } catch { return null }
  return parseStatus(await run(dir, ['status', '--porcelain=v1', '-b'])).behind
}

export async function push(dir: string) {
  const st = parseStatus(await run(dir, ['status', '--porcelain=v1', '-b']))
  await run(dir, pushArgs(st.branch, st.upstream), { timeout: 120_000 })
}

// Nova branch a partir de onde esta; as alteracoes nao salvas vao junto (git switch -c). Nome validado pelo proprio git.
export async function createBranch(dir: string, name: string) {
  try { await run(dir, ['check-ref-format', '--branch', name]) } catch { throw new Error(`"${name}" não é um nome de branch válido. Use letras, números, - e /, sem espaços.`) }
  try { await run(dir, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]); throw new Error(`A branch "${name}" já existe.`) } catch (e: any) { if (/já existe/.test(e.message)) throw e }
  await run(dir, ['switch', '-c', name])
}

export async function pull(dir: string) { await run(dir, ['pull', '--ff-only'], { timeout: 120_000 }) }

// Checks do PR resumidos em tres numeros (a lista completa fica no GitHub).
export function summarizeChecks(rollup: any[] | null | undefined) {
  const c = { ok: 0, fail: 0, running: 0 }
  for (const r of rollup ?? []) {
    const s = String(r.conclusion || r.state || r.status || '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) c.ok++
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) c.fail++
    else c.running++
  }
  return c
}

export async function prView(dir: string) {
  try {
    const p = JSON.parse(await gh(dir, ['pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName']))
    return { pr: { number: p.number, title: p.title, url: p.url, state: p.isDraft ? 'DRAFT' : p.state, review: p.reviewDecision || null, base: p.baseRefName, checks: summarizeChecks(p.statusCheckRollup) }, error: null }
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    return { pr: null, error: msg === 'Sem PR para esta branch.' ? null : msg }
  }
}

export async function prCreate(dir: string, title: string, body: string) {
  return (await gh(dir, ['pr', 'create', '--title', title, '--body', body || ' '])).trim().split(/\r?\n/).pop() ?? ''
}

export async function issueList(dir: string) {
  return (JSON.parse(await gh(dir, ['issue', 'list', '--state', 'open', '--limit', '8', '--json', 'number,title,url,labels'])) as any[])
    .map(i => ({ number: i.number, title: i.title, url: i.url, labels: (i.labels ?? []).map((l: any) => l.name).slice(0, 3) }))
}

export async function issueCreate(dir: string, title: string, body: string) {
  return (await gh(dir, ['issue', 'create', '--title', title, '--body', body || ' '])).trim().split(/\r?\n/).pop() ?? ''
}
