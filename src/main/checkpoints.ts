// Checkpoints de turno: antes de cada mensagem ao agente a dashboard congela o estado Git da pasta
// (projeto ou worktree da tarefa) num commit `orbita-checkpoint:`. Voltar atras e `reset --hard` +
// `clean -fd` explicitos, so por clique confirmado na interface, com previa e token contra estado
// obsoleto (mesmo criterio das integracoes de worktree). Arquivos ignorados (.env, .godot/) nunca entram
// no commit e nunca sao tocados na volta. Sem IA, sem rede, sem dependencia de 'electron'.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { commitSteps } from './gitOps.ts'
import { asInt, fail, samePath } from './guard.ts'
import { run } from './projectInfo.ts'

export const CHECKPOINT_PREFIX = 'orbita-checkpoint:'
const KEEP = 20 // por tarefa; apagar o registro nao apaga o commit do Git (o historico da branch continua la)
// ponytail: mesma lista de operacoes pendentes de worktrees.ts; extrair helper quando uma terceira precisar.
const OPS = ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']

export type Checkpoint = {
  id: number; task_id: number; run_id: number | null; workspace: string
  head: string | null; base: string | null; committed: number; message: string; created_at: string
}
export type RewindPreview = {
  checkpoint: Checkpoint; headNow: string | null; dirtyNow: boolean; token: string; blocked: string[]
}

const row = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT * FROM task_checkpoints WHERE id=?').get(id) as Checkpoint | undefined
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

async function gitDirOf(dir: string): Promise<string> {
  let out: string
  try { out = (await run(dir, ['rev-parse', '--git-dir'])).trim() }
  catch { throw new Error('Esta pasta não é um repositório Git: checkpoint indisponível.') }
  return path.resolve(dir, out)
}

async function opPending(dir: string): Promise<string | null> {
  return opPendingSync(await gitDirOf(dir))
}

function opPendingSync(gitDir: string): string | null {
  return OPS.find(name => { try { fs.lstatSync(path.join(gitDir, name)); return true } catch { return false } }) ?? null
}

const headOf = (dir: string) => run(dir, ['rev-parse', '--verify', 'HEAD']).then(s => s.trim(), () => null)
const dirty = (dir: string) => run(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).then(s => s.length > 0)

// Congela o estado atual: com mudancas, commit `orbita-checkpoint:` (add -A, como o commit manual);
// limpo, so registra o HEAD. Falha em pasta sem Git ou com operacao pendente. Nunca bloqueia o turno:
// quem chama (index.ts) trata o erro como best-effort no automatico e mostra no manual.
export async function createCheckpoint(db: DatabaseSync, dir: string, taskId: number, o: { runId?: number; note?: string } = {}): Promise<Checkpoint> {
  const task = asInt(taskId, 'tarefa')
  if (o.runId !== undefined) asInt(o.runId, 'execução')
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 200) : ''
  const op = await opPending(dir)
  if (op) fail('Conclua ou aborte a operação Git pendente antes do checkpoint.')
  const base = await headOf(dir)
  const hasChanges = await dirty(dir)
  let head = base, committed = 0
  if (hasChanges) {
    const message = `${CHECKPOINT_PREFIX} tarefa ${task}${o.runId ? ` execução ${o.runId}` : ''} ${new Date().toISOString()}${note ? ` ${note}` : ''}`
    for (const args of commitSteps(message)) await run(dir, args)
    head = await headOf(dir)
    committed = 1
  }
  const id = Number(db.prepare('INSERT INTO task_checkpoints (task_id, run_id, workspace, head, base, committed, message) VALUES (?,?,?,?,?,?,?)')
    .run(task, o.runId ?? null, dir, head, base, committed, note).lastInsertRowid)
  db.prepare(`DELETE FROM task_checkpoints WHERE task_id=? AND id NOT IN
    (SELECT id FROM task_checkpoints WHERE task_id=? ORDER BY id DESC LIMIT ${KEEP})`).run(task, task)
  return row(db, id)!
}

export function listCheckpoints(db: DatabaseSync, taskId: number): Checkpoint[] {
  return db.prepare('SELECT * FROM task_checkpoints WHERE task_id=? ORDER BY id DESC').all(asInt(taskId, 'tarefa')) as Checkpoint[]
}

// Previa da volta: o que sera descartado e o token que autoriza. `blocked` nao vazio = a interface desabilita o confirmar.
export async function previewRewind(db: DatabaseSync, dir: string, taskId: number, id: number): Promise<RewindPreview> {
  const cp = row(db, asInt(id, 'checkpoint'))
  if (!cp || cp.task_id !== asInt(taskId, 'tarefa')) fail('Checkpoint inexistente nesta tarefa.')
  if (!samePath(cp!.workspace, dir)) fail('Este checkpoint é de outra pasta. Volte a tarefa para a pasta dele antes.')
  if (!cp!.head) fail('Este checkpoint não guardou estado Git (repositório vazio e limpo). Nada a restaurar.')
  const op = await opPending(dir)
  const headNow = await headOf(dir)
  const token = fingerprint({ id: cp!.id, ws: path.resolve(dir).toLowerCase(), head: cp!.head, now: headNow })
  return {
    checkpoint: cp!, headNow, dirtyNow: await dirty(dir), token,
    blocked: op ? ['Conclua ou aborte a operação Git pendente antes de voltar.'] : [],
  }
}

// Volta a pasta ao HEAD guardado: descarta mudancas nao salvas e remove arquivos novos nao versionados
// criados depois (ignores como .env/.godot ficam intactos). Exige a previa atual (token).
export async function rewindCheckpoint(db: DatabaseSync, dir: string, taskId: number, id: number, token: string): Promise<{ head: string }> {
  const prev = await previewRewind(db, dir, taskId, id)
  if (typeof token !== 'string' || token !== prev.token) fail('O estado Git mudou. Gere a prévia de novo antes de voltar.')
  if (prev.blocked.length) fail(prev.blocked.join(' '))
  await run(dir, ['reset', '--hard', prev.checkpoint.head!])
  await run(dir, ['clean', '-fd'])
  return { head: prev.checkpoint.head! }
}
