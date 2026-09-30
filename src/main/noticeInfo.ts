// Dados do aviso de uma execucao/pedido: tarefa, etapa, arquivos mudados desde o inicio da execucao e o pedido pendente. So leitura.
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { changedFiles } from './fileWatch.ts'
import { getPackage } from './consent.ts'
import { providerLabel, runChanges, type NoticeInfo } from './notify.ts'
import { getTask } from './tasks.ts'

export function createNoticeInfo(db: DatabaseSync, projectNames: () => Record<string, string>) {
  type GitStat = { path: string; status: string; added: number | null; removed: number | null }
  const snapFiles = (cwd: string): Promise<GitStat[] | null> => changedFiles(cwd).then(r => (r.repo ? r.files : null), () => null)
  const baselines = new Map<number, { cwd: string; files: Promise<GitStat[] | null> }>() // runId -> estado do Git no inicio
  function runStart(_taskId: number, runId: number, cwd: string) {
    baselines.set(runId, { cwd, files: snapFiles(cwd) })
    if (baselines.size > 40) baselines.delete(baselines.keys().next().value!)
  }
  async function noticeInfo(ev: any): Promise<NoticeInfo> {
    const t = typeof ev?.taskId === 'number' ? getTask(db, ev.taskId) : null
    if (!t) return { task: null }
    const info: NoticeInfo = { task: { title: t.title, game: t.game, project: projectNames()[t.game] ?? path.basename(t.game) } }
    if (ev.done && ev.runId) {
      info.step = (db.prepare('SELECT title FROM task_steps WHERE run_id=?').get(ev.runId) as any)?.title ?? null
      const b = baselines.get(ev.runId)
      baselines.delete(ev.runId)
      if (b) { const [before, after] = await Promise.all([b.files, snapFiles(b.cwd)]); info.changes = before && after ? runChanges(before, after) : null }
    }
    if (ev.permissionRequest) {
      const perm = db.prepare('SELECT provider, summary FROM permission_requests WHERE id=?').get(ev.permissionRequest) as any
      info.permission = perm && { provider: perm.provider, summary: perm.summary ?? '' }
    }
    if (ev.contextRequest) {
      const pkg = getPackage(db, ev.contextRequest)
      info.context = pkg && { items: pkg.items.length, recipient: `${providerLabel(pkg.recipient.provider)}${pkg.recipient.model ? ` ${pkg.recipient.model}` : ''}` }
    }
    return info
  }
  return { runStart, noticeInfo }
}
