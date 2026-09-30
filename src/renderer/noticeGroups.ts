// Avisos do mesmo projeto viram um grupo so, na ordem do aviso mais novo de cada projeto (lista chega do mais novo para o mais velho).
export function groupNotices<T extends { game: string }>(list: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const n of list) {
    const k = n.game.toLowerCase()
    const g = groups.get(k)
    if (g) g.push(n); else groups.set(k, [n])
  }
  return [...groups.values()]
}
