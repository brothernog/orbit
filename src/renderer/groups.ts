import type { EngineConfig, EngineId } from '../main/engines'
export type { GodotConfig } from '../main/godot'
export type { EngineConfig, EngineId } from '../main/engines'
export type EngineSettings = Partial<Record<EngineId, EngineConfig>>
// Organizadores do app; integrações opcionais (Godot/Unity/Blender) só valem para os projetos deste grupo.
export type Group = { id: string; name: string; color: string; games: string[]; open: boolean } & EngineSettings

export const GROUP_COLORS = ['#7cc4ff', '#69d6b5', '#c6a2ff', '#f0a36b', '#f2b45c', '#ff7b6b']
export const SUGGESTED: [string, string][] = [['Pessoais', '#c6a2ff'], ['Trabalho', '#7cc4ff'], ['Jogos', '#69d6b5'], ['Sites', '#f0a36b']]

// Tarefa a lembrar como a ultima da pasta: so a que pertence a ela. Na troca de pasta, taskId/tasks ainda sao da anterior no mesmo render.
export const taskToRemember = (game: string, taskId: number | null, tasks: { id: number; game: string }[] | null) =>
  tasks?.find(t => t.id === taskId && t.game.toLowerCase() === game.toLowerCase())?.id ?? null

export const groupOf = (groups: Group[], game: string) => groups.find(x => x.games.includes(game)) ?? null

// Move o projeto para o grupo (null tira de todos). Um projeto fica em um grupo so; o destino abre para mostrar onde ele foi parar.
export const moveTo = (groups: Group[], game: string, id: string | null): Group[] =>
  groups.map(x => x.id === id
    ? { ...x, open: true, games: x.games.includes(game) ? x.games : [...x.games, game] }
    : { ...x, games: x.games.filter(p => p !== game) })

export const newGroup = (groups: Group[], name: string, color: string, games: string[], engines: EngineSettings = {}): Group[] => {
  const g: Group = { id: Math.random().toString(36).slice(2, 10), name, color, games: [], open: true, ...engines }
  return games.reduce((acc, p) => moveTo(acc, p, g.id), [...groups, g])
}

// Sigla do workspace no trilho: iniciais de ate duas palavras ("Meu Jogo" -> MJ), ou as duas primeiras letras.
export const initials = (n: string) => {
  const w = n.trim().split(/[\s_-]+/).filter(Boolean)
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? '?').slice(0, 2)).toUpperCase()
}

// Reordenar arrastando: tira `item` e coloca antes de `before` (no fim se `before` nao estiver na lista).
export const placeBefore = <T>(list: T[], item: T, before: T | null): T[] => {
  const r = list.filter(x => x !== item)
  const i = before == null ? -1 : r.indexOf(before)
  r.splice(i < 0 ? r.length : i, 0, item)
  return r
}
