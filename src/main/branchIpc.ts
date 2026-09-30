// IPC da branch de uma pasta (projeto ou worktree registrada): Git local + gh. Publicar (push/PR/issue) so por clique confirmado na interface.
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileDiff } from './fileWatch.ts'
import { branchView, commitAll, createBranch, issueCreate, issueList, prCreate, prView, pull, push, remoteAhead } from './gitOps.ts'
import { asStr, commitParts, commitPaths, fail, inside, samePath } from './guard.ts'
import type { createWorktreeService } from './worktrees.ts'

export function branchHandlers(d: {
  db: DatabaseSync; listGames: () => string[]; worktrees: ReturnType<typeof createWorktreeService>; openExternal: (url: string) => unknown
}) {
  const { db, listGames, worktrees, openExternal } = d
  // Pasta de repositorio aceita: projeto listado ou worktree registrada de tarefa/problema.
  const asRepoDir = async (p: unknown) => {
    const dirs = [...listGames(), ...(db.prepare('SELECT worktree FROM tasks WHERE worktree IS NOT NULL UNION SELECT worktree FROM pins WHERE worktree IS NOT NULL').all() as any[]).map(r => r.worktree)]
    // Caminho real: a aba da worktree vem do git (nome longo) e o cadastro pode ter o nome curto 8.3 ou um symlink.
    const hit = typeof p === 'string' ? dirs.find(d => samePath(d, p)) : undefined
    if (hit) return hit
    // Tarefas excluídas podem deixar uma worktree: o registro Git continua sendo conferido.
    for (const game of listGames()) if (typeof p === 'string' && inside(path.join(game, '.worktrees'), p)) {
      const source = (await worktrees.view(game)).sources.find(s => samePath(s.path, p))
      if (source) return source.path
    }
    return fail('Pasta de repositório não cadastrada.')
  }
  return {
    // ---- Branch da pasta (ou worktree): Git local + gh. Publicar (push/PR/issue) so por clique confirmado na interface.
    branchView: async (dir: string) => branchView(await asRepoDir(dir)),
    branchDiff: async (dir: string, rel: string) => fileDiff(await asRepoDir(dir), asStr(rel, 'arquivo', 1000)),
    branchCommit: async (dir: string, msg: string, paths?: unknown, parts?: unknown) => { const d = await asRepoDir(dir); await worktrees.assertAvailable(d); return commitAll(d, asStr(msg, 'mensagem', 5000).trim() || fail('Mensagem de commit vazia.'), commitPaths(paths), commitParts(parts)) },
    branchRemoteAhead: async (dir: string) => remoteAhead(await asRepoDir(dir)),
    branchCreate: async (dir: string, name: string) => { const d = await asRepoDir(dir); await worktrees.assertAvailable(d); return createBranch(d, asStr(name, 'nome da branch', 200).trim() || fail('Nome vazio.')) },
    branchPush: async (dir: string) => push(await asRepoDir(dir)),
    branchPull: async (dir: string) => { const d = await asRepoDir(dir); await worktrees.assertAvailable(d); return pull(d) },
    prView: async (dir: string) => prView(await asRepoDir(dir)),
    prCreate: async (dir: string, title: string, body: string) => prCreate(await asRepoDir(dir), asStr(title, 'titulo', 250).trim() || fail('Título vazio.'), asStr(body ?? '', 'descricao', 20000)),
    issueList: async (dir: string) => issueList(await asRepoDir(dir)),
    issueCreate: async (dir: string, title: string, body: string) => issueCreate(await asRepoDir(dir), asStr(title, 'titulo', 250).trim() || fail('Título vazio.'), asStr(body ?? '', 'descricao', 20000)),
    openGithub: (u: string) => { if (/^https:\/\/github\.com\//.test(asStr(u, 'endereco', 500))) openExternal(u) },
  }
}
