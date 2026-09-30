// Resumo da Nova, feito pelo app (sem IA): transforma o estado das pastas em poucas frases, na ordem do que pede acao.
// Uma frase por coisa a fazer; a interface mostra as primeiras e recolhe o resto (foco para quem tem deficit de atencao).
export type Tone = 'wait' | 'live' | 'push' | 'pull' | 'dirty'
export type DigestItem = { key: string; tone: Tone; text: string; meta: string; game: string; taskId?: number }
type Git = { branch: string | null; ahead: number; behind: number; files: unknown[] }
type Info = { repo: boolean; git: Git | null; worktrees: (Git & { task: string | null })[] } | undefined
type Live = { taskId: number; game: string; title: string; provider: string; startedAt: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const mins = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h ${m % 60} min` }

export function digest(o: {
  games: string[]; info: Record<string, Info>; active: Live[]; waiting: { id: number; game: string; title: string; why: string }[]
  name: (g: string) => string; label: (provider: string) => string; now: number
}) {
  // Caminho como esta na lista de pastas (a caixa pode vir diferente do banco/agente): e o que o clique precisa abrir.
  const canon = (g: string) => o.games.find(x => x.toLowerCase() === g.toLowerCase())
  const items: DigestItem[] = []
  for (const w of o.waiting) { const g = canon(w.game); if (g)
    items.push({ key: `w${w.id}`, tone: 'wait', text: `"${w.title}" espera você`, meta: `${w.why} · ${o.name(g)}`, game: g, taskId: w.id }) }
  for (const a of o.active) { const g = canon(a.game); if (g)
    items.push({ key: `l${a.taskId}`, tone: 'live', text: `${o.label(a.provider)} em "${a.title}"`, meta: `${o.name(g)} · ${mins(o.now - a.startedAt)}`, game: g, taskId: a.taskId }) }
  for (const g of o.games) {
    const i = o.info[g]
    if (!i?.repo || !i.git) continue
    const trees = [i.git, ...i.worktrees]
    const ahead = trees.reduce((n, t) => n + t.ahead, 0), behind = i.git.behind
    const files = trees.reduce((n, t) => n + t.files.length, 0)
    if (ahead) items.push({ key: `p${g}`, tone: 'push', text: `${plural(ahead, 'commit', 'commits')} para enviar`, meta: `${o.name(g)} · ${i.git.branch ?? 'HEAD'}`, game: g })
    if (behind) items.push({ key: `b${g}`, tone: 'pull', text: `${plural(behind, 'commit novo', 'commits novos')} no remoto`, meta: `${o.name(g)} · puxe antes de mexer`, game: g })
    if (files) items.push({ key: `d${g}`, tone: 'dirty', text: `${plural(files, 'arquivo', 'arquivos')} sem commit`, meta: `${o.name(g)}${i.worktrees.some(w => w.files.length) ? ' · inclui worktrees' : ''}`, game: g })
  }
  const n = (t: Tone) => items.filter(i => i.tone === t).length
  const headline = n('wait') ? `${plural(n('wait'), 'coisa espera', 'coisas esperam')} por você.`
    : n('live') ? `${plural(n('live'), 'agente trabalhando', 'agentes trabalhando')}. Nada esperando você.`
    : n('push') + n('dirty') + n('pull') ? 'Nenhum agente agora. Falta fechar o que ficou aberto no Git.'
    : 'Tudo em dia. Nada pede você agora.'
  return { items, headline }
}
