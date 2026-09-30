// Agentes nomeados para delegacao: o usuario da um nome (ex.: "Fabricio") a um provedor + modelo (+ esforco) e os agentes da
// dashboard passam a resolver o nome sozinhos ("delegue para o Fabricio" = codex / gpt-6-luna). So o catalogo (nome, provedor,
// modelo, esforco) vai aos agentes, na descricao da ferramenta; nunca credenciais. Sem dependencia de 'electron'.
import { AGENTS, SAFE_ARG } from './adapters.ts'

export type AgentAlias = { name: string; provider: string; model: string; effort?: string }
export const MAX_ALIASES = 30
export const ALIAS_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u

// Comparacao de nomes: sem acento, sem caixa, espacos colapsados ("Fabrício" == "fabricio").
export const foldName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Leitura tolerante do que esta gravado: entradas invalidas sao ignoradas (nunca derrubam a delegacao).
export function parseAliases(raw: unknown): AgentAlias[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>(), out: AgentAlias[] = []
  for (const a of raw as any[]) {
    if (!a || typeof a.name !== 'string' || typeof a.provider !== 'string' || typeof a.model !== 'string') continue
    const name = a.name.trim(), key = foldName(name)
    if (!ALIAS_NAME.test(name) || seen.has(key) || !Object.hasOwn(AGENTS, a.provider) || !SAFE_ARG.test(a.model)) continue
    if (a.effort != null && a.effort !== '' && !(typeof a.effort === 'string' && SAFE_ARG.test(a.effort))) continue
    seen.add(key)
    out.push({ name, provider: a.provider, model: a.model, ...(a.effort ? { effort: a.effort } : {}) })
  }
  return out
}

// Validacao ao SALVAR: nome unico (sem acento/caixa) e que nao seja o de um provedor; provedor e modelo existentes no catalogo
// (o mesmo teste da delegacao, sem substituir nada em silencio). Qualquer erro recusa a lista inteira, nada e gravado pela metade.
export async function validateAliases(list: unknown, check: (provider: string, model?: string, effort?: string) => Promise<string | null>): Promise<AgentAlias[]> {
  if (!Array.isArray(list)) throw new Error('Envie uma lista de agentes.')
  if (list.length > MAX_ALIASES) throw new Error(`No maximo ${MAX_ALIASES} agentes nomeados.`)
  const seen = new Set<string>(), out: AgentAlias[] = []
  for (const [i, a] of (list as any[]).entries()) {
    const label = `Agente ${i + 1}`
    if (!a || typeof a !== 'object') throw new Error(`${label}: entrada invalida.`)
    const name = typeof a.name === 'string' ? a.name.trim() : ''
    if (!ALIAS_NAME.test(name)) throw new Error(`${label}: o nome deve ter de 1 a 40 caracteres (letras, numeros, espaco, - e _), comecando por letra ou numero.`)
    const key = foldName(name)
    if (seen.has(key)) throw new Error(`Nome repetido: "${name}" (maiusculas e acentos nao diferenciam nomes).`)
    if (Object.hasOwn(AGENTS, key)) throw new Error(`"${name}" e o nome de um provedor; escolha outro nome.`)
    seen.add(key)
    if (typeof a.provider !== 'string' || !Object.hasOwn(AGENTS, a.provider)) throw new Error(`"${name}": provedor invalido. Opcoes: ${Object.keys(AGENTS).join(', ')}.`)
    if (typeof a.model !== 'string' || !SAFE_ARG.test(a.model)) throw new Error(`"${name}": escolha um modelo valido.`)
    if (a.effort != null && a.effort !== '' && !(typeof a.effort === 'string' && SAFE_ARG.test(a.effort))) throw new Error(`"${name}": esforco invalido.`)
    const effort = a.effort ? String(a.effort) : undefined
    const err = await check(a.provider, a.model, effort)
    if (err) throw new Error(`"${name}": ${err}`)
    out.push({ name, provider: a.provider, model: a.model, ...(effort ? { effort } : {}) })
  }
  return out
}

export const resolveAlias = (aliases: AgentAlias[], name: string) => aliases.find(a => foldName(a.name) === foldName(name))

// Catalogo mostrado aos agentes (na descricao da ferramenta de delegacao).
export const describeAliases = (aliases: AgentAlias[]) =>
  aliases.map(a => `${a.name} = ${a.provider} / ${a.model}${a.effort ? ` (esforco ${a.effort})` : ''}`).join('; ')
