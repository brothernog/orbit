// IPC da producao do projeto: assets, builds, playtests e retencao. Os dialogos de arquivo chegam como funcoes (sem Electron aqui).
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createProductionService } from './production.ts'
import { createPlaytestService } from './playtests.ts'
import { godotBuildFile } from './godotFlow.ts'
import { asInt, asStr, fail, safeJoin, samePath } from './guard.ts'
import type { backupGate } from './backupGate.ts'
import type { Task } from './tasks.ts'

export function createProductionIpc(d: {
  db: DatabaseSync; dir: string; asGame: (v: unknown) => string; asTask: (v: unknown) => Task; taskCwd: (t: Task) => Promise<string>
  emit: (ev: object) => void; backups: ReturnType<typeof backupGate>
  openFile: (defaultPath: string) => Promise<string | null> // caminho escolhido ou null (cancelado)
  saveFile: (fileName: string) => Promise<string | null> // destino da exportacao ou null (cancelado)
}) {
  const { db, asGame, asTask, taskCwd, emit, backups, openFile, saveFile } = d
  const production = createProductionService(db, d.dir)
  const playtests = createPlaytestService(db, d.dir)
  function registerProjectBuild(game: string, raw: any) {
    const run = typeof raw?.commandId === 'number' ? db.prepare('SELECT task_id,name FROM command_runs WHERE id=?').get(raw.commandId) as { task_id: number | null; name: string } | undefined : undefined
    const validateSource = run?.name.startsWith('Godot · ') ? async () => {
      if (!run.task_id) fail('A tarefa de origem deste build não está disponível.')
      const task = asTask(run.task_id), cwd = await taskCwd(task)
      if (!samePath(task.game, game)) fail('Build de outro projeto.')
      const file = godotBuildFile(db, task.id, raw.commandId, cwd)
      if (!samePath(safeJoin(cwd, file), safeJoin(cwd, asStr(raw?.path, 'arquivo', 2000)))) fail('Registre o executável completo produzido pela exportação Godot.')
    } : undefined
    return production.registerBuild(game, raw, validateSource)
  }
  async function productionChange(game: unknown, change: (g: string) => unknown) {
    const g = asGame(game), result = await change(g)
    emit({ productionChanged: true, game: g }); return result
  }
  const handlers = {
    listAssets: (game: string) => production.listAssets(asGame(game)),
    editAsset: (game: string, id: unknown, raw: unknown) => productionChange(game, g => production.editAsset(g, asInt(id, 'asset'), raw)),
    setAssetArchived: (game: string, id: unknown, revision: unknown, archived: unknown) => productionChange(game, g => production.setAssetArchived(g, asInt(id, 'asset'), revision, archived)),
    setAssetVersionPinned: (game: string, id: unknown, hash: unknown, pinned: unknown) => productionChange(game, g => production.setAssetVersionPinned(g, asInt(id, 'versão'), hash, pinned)),
    previewRetention: (game: string, keep: unknown) => production.previewRetention(asGame(game), keep),
    pruneRetention: (game: string, keep: unknown, token: unknown) => backups.exclusive(() => productionChange(game, g => production.pruneRetention(g, keep, token))),
    captureAsset: (game: string, raw: unknown) => productionChange(game, g => production.captureAsset(g, raw)),
    captureAssetVersion: (game: string, id: unknown, note: unknown) => productionChange(game, g => production.captureAssetVersion(g, asInt(id, 'asset'), note)),
    reviewAssetVersion: (game: string, id: unknown, hash: unknown, decision: unknown) => productionChange(game, g => production.reviewAssetVersion(g, asInt(id, 'versão'), hash, decision)),
    assetImage: (game: string, id: unknown) => production.readAssetImage(asGame(game), asInt(id, 'versão')),
    listPlaytests: (game: string) => playtests.list(asGame(game)),
    editPlaytest: (game: string, id: unknown, raw: unknown) => productionChange(game, g => playtests.edit(g, asInt(id, 'playtest'), raw)),
    setPlaytestArchived: (game: string, id: unknown, revision: unknown, archived: unknown) => productionChange(game, g => playtests.setArchived(g, asInt(id, 'playtest'), revision, archived)),
    addPlaytest: (game: string, raw: unknown) => productionChange(game, g => playtests.add(g, raw)),
    setPlaytestState: (game: string, id: unknown, state: unknown) => productionChange(game, g => playtests.setState(g, asInt(id, 'playtest'), state)),
    playtestImages: (game: string, id: unknown) => playtests.images(asGame(game), asInt(id, 'playtest')),
    createPlaytestIssue: (game: string, id: unknown, title: unknown, instruction: unknown) => productionChange(game, g => playtests.createIssue(g, asInt(id, 'playtest'), title, instruction)),
    listBuildCommands: (game: string) => production.listBuildCommands(asGame(game)),
    listBuilds: (game: string) => production.listBuilds(asGame(game)),
    editBuild: (game: string, id: unknown, raw: unknown) => productionChange(game, g => production.editBuild(g, asInt(id, 'build'), raw)),
    setBuildArchived: (game: string, id: unknown, revision: unknown, archived: unknown) => productionChange(game, g => production.setBuildArchived(g, asInt(id, 'build'), revision, archived)),
    registerBuild: (game: string, raw: unknown) => productionChange(game, g => registerProjectBuild(g, raw)),
    reviewBuild: (game: string, id: unknown, hash: unknown, decision: unknown) => productionChange(game, g => production.reviewBuild(g, asInt(id, 'build'), hash, decision)),
    selectProductionFile: async (game: string) => {
      const g = asGame(game), file = await openFile(g)
      if (!file) return null
      const rel = path.relative(g, file); safeJoin(g, rel); return rel
    },
    exportProductionFile: async (game: string, kind: unknown, id: unknown) => {
      const g = asGame(game), n = asInt(id, 'registro')
      const row = kind === 'asset' ? production.listAssets(g).flatMap(a => a.versions).find(v => v.id === n)
        : kind === 'build' ? production.listBuilds(g).find(b => b.id === n) : fail('Tipo inválido.')
      const entry = row ?? fail('Registro inexistente neste projeto.')
      if (entry.state !== 'approved') fail('Aprove a versão antes de exportar.')
      const file = await saveFile(path.basename(entry.file_name))
      if (!file) return false
      await production.exportFile(g, kind as 'asset' | 'build', n, file); return true
    },
  }
  return { productionChange, registerProjectBuild, handlers }
}
