// Validacao de argumentos vindos do renderer e de caminhos. Sem dependencia de 'electron'.
import fs from 'node:fs'
import path from 'node:path'

export const fail = (m: string): never => { throw new Error(m) }
export const asInt = (v: unknown, n: string) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : fail(`${n} invalido`))
export const asStr = (v: unknown, n: string, max = 10_000) => (typeof v === 'string' && v.length <= max ? v : fail(`${n} invalido`))

// Chave de comparacao de caminho: absoluta e sem caixa onde o sistema de arquivos padrao ignora caixa (Windows, APFS do macOS).
// No Linux /home/u/Jogo e /home/u/jogo sao pastas diferentes: a caixa fica.
const FOLD = process.platform === 'win32' || process.platform === 'darwin'
export const pathKey = (p: string) => { const abs = path.resolve(p); return FOLD ? abs.toLowerCase() : abs }
export const sameKey = (a: string, b: string) => pathKey(a) === pathKey(b)
export const inside = (root: string, p: string) => pathKey(p).startsWith(pathKey(root) + path.sep)

// Mesma pasta no disco: caminho real (nome curto RUNNER~1 do Windows, symlink /var -> /private/var do macOS), comparado por pathKey.
const realPath = (p: string) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
export const samePath = (a: string, b: string) => sameKey(realPath(a), realPath(b))

// Devolve o item de `allowed` que corresponde ao caminho pedido (caixa conforme pathKey), ou falha.
export const asAllowedPath = (allowed: string[], v: unknown, what: string) => {
  const abs = pathKey(asStr(v, what, 1024))
  return allowed.find(g => pathKey(g) === abs) ?? fail(`${what} nao permitido.`)
}

// So permite caminhos dentro de `root`. Valida o caminho REAL: links/junctions apontando para fora nao passam.
export function safeJoin(root: string, rel: string) {
  const abs = path.resolve(root, rel)
  const realRoot = fs.realpathSync(root)
  // Caminho novo (ainda inexistente): valida o ancestral existente mais proximo, resolvendo links/junctions.
  let probe = abs
  const rest: string[] = []
  while (!fs.existsSync(probe)) {
    rest.unshift(path.basename(probe))
    const up = path.dirname(probe)
    if (up === probe) break
    probe = up
  }
  const real = path.join(fs.realpathSync(probe), ...rest)
  if (!inside(realRoot, real)) throw new Error('Caminho fora do jogo')
  return real
}

// Projetos permitidos: pastas do Claude Code dentro de Documentos + as que o usuario adicionou de proposito (qualquer lugar).
// A pasta do proprio app so entra se o usuario a adicionou; a descoberta automatica a ignora (nao editar o app sem querer).
// "hidden": projetos que o usuario removeu da lista (nada e apagado; adicionar a pasta de novo traz de volta).
export function pickGames(o: { docs: string; projects: string[]; extra: string[]; hidden?: string[]; appPath: string; isDir: (p: string) => boolean }): string[] {
  const seen = new Map<string, string>()
  const docs = pathKey(o.docs), app = pathKey(o.appPath)
  const extraKeys = new Set(o.extra.map(pathKey))
  const hidden = new Set((o.hidden ?? []).map(pathKey))
  for (const p of [...o.projects, ...o.extra]) {
    const abs = path.resolve(p), key = pathKey(abs)
    const added = extraKeys.has(key)
    if (!key.startsWith(docs + path.sep) && !added) continue
    if ((key === app && !added) || seen.has(key) || hidden.has(key)) continue
    if (o.isDir(abs)) seen.set(key, abs)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// Um caminho relativo (com /) esta dentro do escopo? Escopo vazio = area inteira. Nao e sandbox: so decide o que o app aceita/sinaliza.
export const inScope = (file: string, scope: string[]) => !scope.length || scope.some(s => s === '.' || file === s || file.startsWith(s.replace(/\/$/, '') + '/'))

// Organizadores do app; integrações são opt-in e validadas no backend.
export type ProjectGroup = { id: string; name: string; color: string; games: string[]; open: boolean; godot?: { enabled: boolean; executable: string } }
export function cleanGroups(v: unknown): ProjectGroup[] {
  if (!Array.isArray(v)) throw new Error('grupos invalidos')
  const seen = new Set<string>()
  return v.slice(0, 40).map((g: any) => {
    const name = String(g?.name ?? '').trim().slice(0, 40)
    if (!name) throw new Error('grupo sem nome')
    if (g.godot != null && (typeof g.godot !== 'object' || typeof g.godot.enabled !== 'boolean' || typeof g.godot.executable !== 'string' || g.godot.executable.length > 2000 || /[\0\r\n]/.test(g.godot.executable))) throw Error('Configuração Godot inválida.')
    return {
      id: String(g?.id ?? '').replace(/[^\w-]/g, '').slice(0, 40) || Math.random().toString(36).slice(2, 10),
      name, color: /^#[0-9a-f]{6}$/i.test(g?.color) ? g.color : '#7cc4ff', open: !!g?.open,
      games: (Array.isArray(g?.games) ? g.games : []).filter((p: unknown) => typeof p === 'string' && p.length < 500 && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).slice(0, 200),
      ...(g.godot != null ? { godot: { enabled: g.godot.enabled, executable: g.godot.executable.trim() } } : {}),
    }
  })
}

// Arquivos escolhidos para o commit: relativos a pasta, sem subir de nivel. undefined/[] = todos.
// ponytail: teto de ~24k caracteres por causa da linha de comando do Windows (32k); acima disso, commitar todos.
export function commitPaths(v: unknown): string[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v) || v.length > 2000) fail('Lista de arquivos invalida.')
  const ps = (v as unknown[]).map(p => asStr(p, 'arquivo', 1000))
  if (ps.some(p => !p || /^([a-z]:|[\/])/i.test(p) || p.split(/[\/]/).includes('..'))) fail('Arquivo fora da pasta.')
  if (ps.join('').length > 24_000) fail('Arquivos demais selecionados. Selecione todos ou menos arquivos.')
  return ps.length ? ps : undefined
}

// Nova de uma pasta: so ela (caixa do Windows ignorada). Sem pasta = todas. `soft`: pasta desconhecida da [] em vez de erro.
export function scopeTo(games: string[], project?: string, soft = false): string[] {
  if (!project) return games
  const r = games.filter(g => g.toLowerCase() === project.toLowerCase())
  return r.length || soft ? r : fail('Pasta fora da lista.')
}

// Arquivos com trechos desmarcados: caminho no mesmo criterio de `commitPaths`; `skip` = cabecalhos "@@ ... @@".
export function commitParts(v: unknown): { path: string; skip: string[] }[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v) || v.length > 200) fail('Lista de trechos invalida.')
  const r = (v as any[]).map(x => {
    const skip = x?.skip
    if (!Array.isArray(skip) || !skip.length || skip.length > 1000) fail('Lista de trechos invalida.')
    return { path: commitPaths([x?.path])![0], skip: skip.map((s: unknown) => { const h = asStr(s, 'trecho', 2000); return h.startsWith('@@') ? h : fail('Trecho invalido.') }) }
  })
  return r.length ? r : undefined
}
