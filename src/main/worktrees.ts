// Integracao local: Git mantem o indice/conflitos; a dashboard so confirma estados revisados.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { inside, samePath } from './guard.ts'
import { run } from './projectInfo.ts'

export type WorktreeRef = { path: string; branch: string; head: string }
export type WorktreePending = { token: string; source: WorktreeRef; target: WorktreeRef; conflicts: string[]; staged: string[]; unstaged: boolean; owned: boolean; mergeStarted: boolean; blocked: string[] }
export type WorktreeRemoval = { path: string; branch: string; missing: boolean; blocked: string[] }
type Checkout = WorktreeRef & { gitDir: string; commonDir: string }
type Marker = { source: WorktreeRef; target: Checkout }
type RemovalIntent = Marker & { parent: { path: string; identity: number[] }; commonIdentity: number[] }
const nativeOps = ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']
const indexFlagWarning = 'Ha arquivos marcados como skip-worktree ou assume-unchanged. Remova essas marcas no Git para revisar alteracoes ocultas.'
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ref = ({ path: p, branch, head }: WorktreeRef): WorktreeRef => ({ path: p, branch, head })
const nul = (s: string) => s.split('\0').filter(Boolean)
const key = (game: string) => `worktreeMerge:${fs.realpathSync.native(game).toLowerCase()}`
const removalKey = (game: string) => `worktreeRemoval:${fs.realpathSync.native(game).toLowerCase()}`
const operations = (dir: string) => nativeOps.filter(name => fs.existsSync(path.join(dir, name)))
const identity = (dir: string) => { const s = fs.statSync(dir); return [s.dev, s.ino, s.birthtimeMs] }
const exists = (p: string) => { try { fs.lstatSync(p); return true } catch (e: any) { if (e.code === 'ENOENT') return false; throw e } }
const sameTarget = (m: Marker, c: Checkout) => samePath(m.target.path, c.path) && samePath(m.target.commonDir, c.commonDir) && m.target.branch === c.branch
const completed = (m: Marker, parents: string) => { const p = parents.trim().split(' '); return p.length === 3 && p[1] === m.target.head && p[2] === m.source.head }
const ancestors = async (cwd: string, head: string, target: string) => {
  try { await run(cwd, ['merge-base', '--is-ancestor', head, target]); return true } catch (e: any) { if (e.code === 1) return false; throw e }
}
const registry = async (game: string) => {
  const out = await run(game, ['worktree', 'list', '--porcelain', '-z'])
  return out.split('\0\0').filter(Boolean).map(block => Object.fromEntries(nul(block).map(line => { const at = line.indexOf(' '); return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)] })))
}
async function checkout(dir: string): Promise<Checkout> {
  const p = fs.realpathSync.native(dir)
  const top = (await run(p, ['rev-parse', '--show-toplevel'])).trim()
  if (!samePath(top, p)) throw new Error('Escolha a raiz da pasta Git.')
  let branch: string
  try { branch = (await run(p, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() } catch { throw new Error('Escolha uma branch local; HEAD esta destacado.') }
  let head: string
  try { head = (await run(p, ['rev-parse', '--verify', 'HEAD'])).trim() } catch { throw new Error('A branch ainda nao tem commits.') }
  const gitDir = fs.realpathSync.native(path.resolve(p, (await run(p, ['rev-parse', '--git-dir'])).trim()))
  const commonDir = fs.realpathSync.native(path.resolve(p, (await run(p, ['rev-parse', '--git-common-dir'])).trim()))
  return { path: p, branch, head, gitDir, commonDir }
}
async function state(c: Checkout) {
  const before = identity(c.path)
  const [status, diff, staged, ignored, flags] = await Promise.all([
    run(c.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run(c.path, ['diff', '--no-ext-diff', '--no-textconv', '--binary']),
    run(c.path, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary']),
    run(c.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
    run(c.path, ['ls-files', '-v', '-z']),
  ])
  const after = await checkout(c.path)
  if (fingerprint(after) !== fingerprint(c) || fingerprint(before) !== fingerprint(identity(c.path))) throw new Error('O estado Git mudou durante a leitura. Atualize a previa.')
  return { ...c, identity: before, status, diff, staged, ignored, indexFlags: nul(flags).filter(record => /^[Sa-z]/.test(record)), operations: operations(c.gitDir) }
}

export function createWorktreeService(db: DatabaseSync) {
  const marker = (game: string): Marker | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key(game)) as { value: string } | undefined
    if (!row) return null
    try { const m = JSON.parse(row.value); if (m?.source?.path && m.source.branch && m.source.head && m?.target?.path && m.target.branch && m.target.head && m.target.commonDir) return m } catch {}
    throw new Error('Registro de integracao invalido; confira os dados antes de continuar.')
  }
  const save = (game: string, m: Marker | null) => {
    if (m) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key(game), JSON.stringify(m))
    else db.prepare('DELETE FROM settings WHERE key=?').run(key(game))
  }
  const removalIntent = (game: string): RemovalIntent | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(removalKey(game)) as { value: string } | undefined
    if (!row) return null
    try { const m = JSON.parse(row.value); if (m?.source?.path && m.source.branch && m?.target?.path && m.target.commonDir && m?.parent?.path && Array.isArray(m.commonIdentity) && Array.isArray(m.parent.identity)) return m } catch {}
    throw new Error('Registro de limpeza invalido; confira os dados antes de continuar.')
  }
  const removalState = async (game: string, target: Checkout): Promise<WorktreeRemoval | null> => {
    const m = removalIntent(game)
    if (!m) return null
    const missing = !exists(m.source.path), blocked: string[] = []
    const managed = path.resolve(target.path, '.worktrees')
    if (!samePath(target.path, m.target.path) || !samePath(target.commonDir, m.target.commonDir) || fingerprint(identity(target.commonDir)) !== fingerprint(m.commonIdentity) || !inside(managed, path.resolve(m.source.path))) blocked.push('A identidade do repositorio ou o caminho da limpeza mudou.')
    try {
      const parent = fs.realpathSync.native(m.parent.path)
      if (!(samePath(managed, parent) || inside(fs.realpathSync.native(managed), parent)) || !inside(target.path, parent) || fingerprint(identity(parent)) !== fingerprint(m.parent.identity)) blocked.push('A pasta que continha a worktree foi substituida ou esta fora do projeto.')
    } catch { blocked.push('A pasta que continha a worktree nao esta disponivel.') }
    if (!missing) blocked.push('A pasta ainda existe. Revise a limpeza novamente.')
    if ((await registry(game)).some(w => typeof w.worktree === 'string' && samePath(w.worktree, m.source.path))) blocked.push('O registro da worktree ainda existe no Git.')
    return { path: m.source.path, branch: m.source.branch, missing, blocked }
  }
  const pair = async (game: string, source: string, knownTarget?: Checkout, knownRegistry?: Awaited<ReturnType<typeof registry>>) => {
    const target = knownTarget ?? await checkout(game)
    const managed = path.resolve(target.path, '.worktrees'), requested = path.resolve(source)
    if (!inside(managed, requested) || !fs.existsSync(requested) || !fs.existsSync(managed)) throw new Error('Worktree fora da pasta gerenciada ou ausente.')
    const realManaged = fs.realpathSync.native(managed), realSource = fs.realpathSync.native(requested)
    if (!inside(target.path, realManaged) || !inside(realManaged, realSource)) throw new Error('Worktree fora da pasta gerenciada.')
    const item = (knownRegistry ?? await registry(game)).find(w => typeof w.worktree === 'string' && samePath(w.worktree, requested))
    if (!item) throw new Error('Pasta nao registrada como worktree deste projeto.')
    const from = await checkout(requested)
    if (!samePath(from.commonDir, target.commonDir) || samePath(from.path, target.path) || from.branch === target.branch) throw new Error('Origem e destino precisam ser worktrees distintas do mesmo repositorio.')
    if (item.HEAD !== from.head || item.branch !== `refs/heads/${from.branch}`) throw new Error('A identidade da worktree mudou. Revise o registro Git.')
    return { source: from, target, item }
  }
  const pending = async (game: string, target: Checkout): Promise<WorktreePending | null> => {
    let m = marker(game)
    const ops = operations(target.gitDir)
    // O commit pode terminar antes de o processo limpar o registro no SQLite.
    if (m && !ops.length && sameTarget(m, target) && completed(m, await run(game, ['rev-list', '--parents', '-n', '1', 'HEAD']))) { save(game, null); m = null }
    if (!m && !ops.length) return null
    const s = await state(target)
    const mergeFile = path.join(target.gitDir, 'MERGE_HEAD'), origFile = path.join(target.gitDir, 'ORIG_HEAD')
    const mergeHead = fs.existsSync(mergeFile) ? fs.readFileSync(mergeFile, 'utf8').trim() : ''
    const origHead = fs.existsSync(origFile) ? fs.readFileSync(origFile, 'utf8').trim() : ''
    const owned = !!m && sameTarget(m, target) && m.target.head === target.head && (!ops.length || (ops.length === 1 && ops[0] === 'MERGE_HEAD' && mergeHead === m.source.head && origHead === m.target.head))
    const conflicts = nul(await run(game, ['diff', '--name-only', '--diff-filter=U', '-z']))
    const staged = nul(await run(game, ['diff', '--cached', '--name-only', '-z']))
    const unstaged = !!s.diff
    const untracked = nul(await run(game, ['ls-files', '--others', '--exclude-standard', '-z']))
    const blocked = [!owned ? 'Operacao Git iniciada fora da dashboard ou estado alterado.' : '', s.indexFlags.length ? indexFlagWarning : '', ...ops.filter(o => o !== 'MERGE_HEAD').map(o => `Operacao Git pendente: ${o}.`), ...(unstaged ? ['Ha alteracoes ainda nao adicionadas ao indice.'] : []), ...(untracked.length ? ['Ha arquivos novos ainda nao adicionados ao indice.'] : [])].filter(Boolean)
    return { token: fingerprint({ m, s, mergeHead, origHead, conflicts, staged, untracked }), source: m?.source ?? { path: '', branch: 'Operacao externa', head: mergeHead }, target: ref(target), conflicts, staged, unstaged, owned, mergeStarted: !!mergeHead, blocked }
  }
  const view = async (game: string) => {
    const target = await checkout(game), sources: WorktreeRef[] = [], entries = await registry(game)
    for (const w of entries) {
      if (typeof w.worktree !== 'string' || samePath(w.worktree, game)) continue
      try { sources.push(ref((await pair(game, w.worktree, target, entries)).source)) } catch {}
    }
    return { target: ref(target), sources, pending: await pending(game, target), removal: await removalState(game, target) }
  }
  const mergePreview = async (game: string, source: string) => {
    const p = await pair(game, source), a = await state(p.source), b = await state(p.target)
    if (removalIntent(game)) throw new Error('Conclua a limpeza pendente antes de integrar outra worktree.')
    if (marker(game) || a.operations.length || b.operations.length) throw new Error('Conclua ou aborte a operacao Git pendente antes de integrar.')
    if (a.indexFlags.length || b.indexFlags.length) throw new Error(indexFlagWarning)
    if (a.status || b.status) throw new Error('Origem e destino precisam estar sem alteracoes ou arquivos novos. Faca commit ou guarde-os primeiro.')
    const integrated = await ancestors(game, a.head, b.head)
    const commits = (await run(game, ['log', '--format=%H %s', `${b.head}..${a.head}`])).trim().split('\n').filter(Boolean).map(line => ({ sha: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }))
    const files = nul(await run(game, ['diff', '--name-only', '-z', `${b.head}...${a.head}`]))
    const ignored = nul(b.ignored).map(p => p.replace(/\\/g, '/').toLowerCase())
    if (files.some(file => { const f = file.replace(/\\/g, '/').toLowerCase(); return ignored.some(p => p === f || p.startsWith(f + '/') || f.startsWith(p + '/')) })) throw new Error('A integracao pode sobrescrever arquivos ignorados do destino. Guarde-os fora da pasta antes de continuar.')
    return { preview: { token: fingerprint({ a, b, item: p.item }), source: ref(a), target: ref(b), commits, files, integrated }, target: p.target, source: p.source }
  }
  const previewMerge = async (game: string, source: string) => (await mergePreview(game, source)).preview
  const beginMerge = async (game: string, source: string, token: string) => {
    const { preview, target: reviewed, source: from } = await mergePreview(game, source)
    if (preview.token !== token) throw new Error('A previa mudou. Revise novamente antes de integrar.')
    if (preview.integrated) throw new Error('Todos os commits desta worktree ja estao integrados.')
    const target = await checkout(game)
    if (fingerprint(target) !== fingerprint(reviewed)) throw new Error('O destino mudou. Revise novamente antes de integrar.')
    if (operations(target.gitDir).length || operations(from.gitDir).length) throw new Error('Uma operacao Git comecou durante a previa. Revise novamente.')
    save(game, { source: preview.source, target })
    try { await run(game, ['merge', '--no-ff', '--no-commit', '--no-autostash', '--no-overwrite-ignore', preview.source.head], { timeout: 30_000 }) } catch (e) {
      const now = await pending(game, await checkout(game))
      if (!now?.mergeStarted) { save(game, null); throw e }
      if (!now.owned) throw e
    }
    return view(game)
  }
  const checkedPending = async (game: string, token: string) => {
    const p = await pending(game, await checkout(game))
    if (!p?.owned) throw new Error('Esta operacao Git nao pertence a dashboard. Resolva-a pelo Git.')
    if (p.token !== token) throw new Error('A integracao mudou. Atualize e revise antes de continuar.')
    if (p.blocked.includes(indexFlagWarning)) throw new Error(indexFlagWarning)
    return p
  }
  const finishMerge = async (game: string, token: string) => {
    const p = await checkedPending(game, token)
    if (!p.mergeStarted || p.conflicts.length || p.blocked.length) throw new Error('Resolva os conflitos e adicione todas as resolucoes ao indice antes de concluir.')
    await run(game, ['commit', '--no-edit'], { timeout: 30_000 })
    save(game, null)
    return view(game)
  }
  const abortMerge = async (game: string, token: string) => {
    const p = await checkedPending(game, token)
    if (p.mergeStarted) await run(game, ['merge', '--abort'], { timeout: 30_000 })
    save(game, null)
    return view(game)
  }
  const dismissMerge = async (game: string, token: string) => {
    const target = await checkout(game), m = marker(game)
    if (!m || !samePath(m.target.path, target.path) || !samePath(m.target.commonDir, target.commonDir)) throw new Error('Esta revisao nao pertence ao repositorio atual.')
    const p = await pending(game, target)
    if (!p || p.token !== token) throw new Error('A integracao mudou. Atualize e revise antes de continuar.')
    if (operations(target.gitDir).length) throw new Error('Resolva a operacao Git pendente antes de encerrar a revisao.')
    save(game, null)
    return view(game)
  }
  const previewRemoval = async (game: string, source: string) => {
    const p = await pair(game, source), a = await state(p.source), b = await state(p.target)
    const intent = removalIntent(game)
    if (intent && !samePath(intent.source.path, p.source.path)) throw new Error('Conclua a limpeza pendente antes de remover outra worktree.')
    const submodules = nul(await run(source, ['ls-files', '--stage', '-z'])).some(line => line.startsWith('160000 '))
    const integrated = await ancestors(game, a.head, b.head)
    const blockers = [a.status ? 'Ha alteracoes ou arquivos novos na worktree.' : '', a.indexFlags.length ? indexFlagWarning : '', a.ignored ? 'Ha arquivos ignorados na worktree. Copie-os ou remova-os manualmente primeiro.' : '', a.operations.length || b.operations.length || marker(game) ? 'Ha uma operacao Git pendente.' : '', p.item.locked ? 'A worktree esta bloqueada pelo Git.' : '', submodules ? 'A worktree contem submodulos.' : '', !integrated ? 'Ha commits que ainda nao estao integrados na branch de destino.' : ''].filter(Boolean)
    return { token: fingerprint({ a, b, item: p.item, submodules, integrated }), source: ref(a), target: ref(b), blockers }
  }
  const remove = async (game: string, source: string, token: string) => {
    const p = await previewRemoval(game, source)
    if (p.token !== token) throw new Error('A worktree mudou. Revise novamente antes de remover.')
    if (p.blockers.length) throw new Error(p.blockers.join(' '))
    const target = await checkout(game), from = await checkout(p.source.path), parent = fs.realpathSync.native(path.dirname(p.source.path))
    if (fingerprint(ref(target)) !== fingerprint(p.target) || fingerprint(ref(from)) !== fingerprint(p.source) || !samePath(from.commonDir, target.commonDir) || operations(target.gitDir).length || operations(from.gitDir).length) throw new Error('O estado Git mudou. Revise novamente antes de remover.')
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(removalKey(game), JSON.stringify({ source: p.source, target, parent: { path: parent, identity: identity(parent) }, commonIdentity: identity(target.commonDir) } satisfies RemovalIntent))
    await run(game, ['worktree', 'remove', p.source.path], { timeout: 30_000 })
    return { path: p.source.path }
  }
  const recoverRemoval = async (game: string) => {
    const p = await removalState(game, await checkout(game))
    if (!p || !p.missing || p.blocked.length) throw new Error(p?.blocked.join(' ') || 'Nao ha limpeza pendente para recuperar.')
    return { path: p.path }
  }
  const ackRemoval = (game: string, source: string) => {
    const m = removalIntent(game)
    if (!m || !samePath(m.source.path, source)) throw new Error('Registro de limpeza nao corresponde a worktree removida.')
    db.prepare('DELETE FROM settings WHERE key=?').run(removalKey(game))
  }
  const assertAvailable = (cwd: string) => {
    let dirs: string[]
    try { dirs = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/).map(d => fs.realpathSync.native(path.resolve(cwd, d))) } catch (e: any) {
      if (/not a git repository/i.test(String(e.stderr))) return
      if (e.code === 'ENOENT') {
        let p = path.resolve(cwd)
        while (!exists(path.join(p, '.git'))) { const up = path.dirname(p); if (up === p) return; p = up }
      }
      throw new Error('Nao foi possivel verificar o estado Git da pasta.')
    }
    if (operations(dirs[0]).length) throw new Error('Conclua ou aborte a operacao Git pendente antes de executar.')
    for (const row of db.prepare("SELECT key,value FROM settings WHERE key LIKE 'worktreeMerge:%'").all() as { key: string; value: string }[]) {
      let m: Marker
      try { m = JSON.parse(row.value) } catch { throw new Error('Registro de integracao invalido; confira os dados antes de executar.') }
      if (!m?.target?.path || !m.target.commonDir) throw new Error('Registro de integracao invalido; confira os dados antes de executar.')
      if (samePath(m.target.path, cwd) && samePath(m.target.commonDir, dirs[1])) {
        const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }).trim()
        const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true })
        if (branch === m.target.branch && completed(m, parents)) db.prepare('DELETE FROM settings WHERE key=?').run(row.key)
        else throw new Error('Conclua ou aborte a integracao de worktree antes de executar.')
      }
    }
  }
  return { view, previewMerge, beginMerge, finishMerge, abortMerge, dismissMerge, previewRemoval, remove, recoverRemoval, ackRemoval, assertAvailable }
}
