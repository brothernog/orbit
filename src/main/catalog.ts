// Catalogo de modelos e esforcos por provedor. Prefere a fonte nativa; onde a CLI nao permite descoberta,
// diz isso e aceita so um id explicito validado. Nunca inventa disponibilidade nem substitui modelo em silencio.
// Sem dependencia de 'electron'.
import readline from 'node:readline'
import { cliSpawn, killTree, resolveCli, runCli, sanitize } from './providers.ts'

export type ModelOpt = {
  id: string
  label?: string
  efforts: string[] | null // esforcos deste modelo; null = usa a lista geral do catalogo
  defaultEffort?: string | null
  contextWindow?: number | null // janela do modelo, so quando o catalogo informa
}
export type Catalog = {
  provider: string
  source: 'native' | 'help' | 'manual' // native = a propria CLI/servidor lista; help = texto do --help; manual = sem descoberta
  at: string
  models: ModelOpt[]
  efforts: string[] // esforcos gerais (modelos com efforts:null)
  allowCustomModel: boolean // aceita id digitado (validado) porque a lista nao e completa
  note?: string
  error?: string // falha ao consultar (independente de login/chat)
}

const now = () => new Date().toISOString()

// ---- Claude: sem comando de catalogo; alias e niveis vem do texto do --help da versao instalada.
export function parseClaudeHelp(help: string) {
  const model = /--model <model>([\s\S]*?)(?=\n\s{0,4}-)/.exec(help)?.[1] ?? ''
  const aliases = [...model.matchAll(/'([a-z][\w-]*)'/g)].map(m => m[1])
  const eff = /--effort <level>[\s\S]*?\(([^)]*)\)/.exec(help)?.[1] ?? ''
  return { aliases: [...new Set(aliases)], efforts: eff.split(',').map(s => s.trim()).filter(Boolean) }
}

// O --help so traz apelidos ("sonnet" = o Sonnet mais recente, sem dizer qual). Os ids completos atuais vao na frente
// com nome e versao; o apelido fica como "sempre o mais recente".
// ponytail: lista fixa (a CLI nao lista modelos); acrescente aqui quando sair um modelo novo.
const CLAUDE_IDS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']
export const claudeName = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}
export function claudeModels(aliases: string[]): ModelOpt[] {
  return [
    ...CLAUDE_IDS.map(id => ({ id, label: claudeName(id), efforts: null })),
    ...aliases.map(a => ({ id: a, label: `${a[0].toUpperCase()}${a.slice(1)} (sempre o mais recente)`, efforts: null })),
  ]
}

// ---- OpenCode: `opencode models <provedor> --verbose` imprime "provedor/modelo" seguido do JSON do modelo.
export function parseOpencodeVerbose(text: string): ModelOpt[] {
  const out: ModelOpt[] = []
  let id: string | null = null, buf = '', depth = 0
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    if (depth === 0 && /^[\w.-]+\/\S+$/.test(line.trim())) { id = line.trim(); buf = ''; continue }
    if (!id) continue
    buf += line + '\n'
    depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0)
    if (depth === 0 && buf.trim()) {
      try {
        const m = JSON.parse(buf)
        out.push({ id, label: m.name, efforts: Object.keys(m.variants ?? {}), contextWindow: typeof m.limit?.context === 'number' ? m.limit.context : null })
      } catch {}
      id = null
    }
  }
  return out
}

// Provedores do opencode com credencial (armazenada ou por variavel de ambiente), a partir de `opencode auth list`.
export function parseOpencodeProviders(text: string): string[] {
  const ids = new Set(['opencode']) // os modelos gratuitos do proprio opencode nao exigem credencial
  for (const l of text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const m = /^\s*●\s+(\S+)/.exec(l)
    if (m) ids.add(m[1].toLowerCase())
  }
  return [...ids]
}

// ---- Codex: App Server (JSON-RPC por linhas no stdio). Ciclo de vida: inicia, initialize, model/list, encerra.
export async function codexModels(env?: NodeJS.ProcessEnv, timeout = 20_000): Promise<ModelOpt[]> {
  const exe = await resolveCli('codex')
  if (!exe) throw new Error('codex nao encontrado no PATH')
  const child = cliSpawn(exe, ['app-server'], { env })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map<number, (m: any) => void>()
  let id = 0, stderr = ''
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-500)))
  child.stdin.on('error', () => {})
  rl.on('line', l => {
    try { const m = JSON.parse(l); if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id) } } catch {}
  })
  const call = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    const i = ++id
    pending.set(i, m => (m.error ? reject(new Error(String(m.error.message ?? 'erro do app-server'))) : resolve(m.result)))
    child.stdin.write(JSON.stringify({ id: i, method, params }) + '\n')
  })
  let timer: NodeJS.Timeout | undefined
  const dead = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('tempo esgotado consultando o app-server do codex')), timeout)
    child.on('error', e => reject(e))
    child.on('close', code => reject(new Error(`app-server do codex encerrou (codigo ${code}): ${sanitize(stderr).trim()}`)))
  })
  dead.catch(() => {}) // a corrida abaixo trata o erro
  try {
    return await Promise.race([(async () => {
      await call('initialize', { clientInfo: { name: 'gaming-planning-dashboard', version: '1.0.0' } })
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      const models: ModelOpt[] = []
      let cursor: string | null = null
      do {
        const r: any = await call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })
        for (const m of r.data ?? [])
          if (!m.hidden) models.push({
            id: m.model, label: m.displayName, defaultEffort: m.defaultReasoningEffort,
            efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort ?? e.effort).filter(Boolean)
          })
        cursor = r.nextCursor ?? null
      } while (cursor)
      return models
    })(), dead])
  } finally {
    clearTimeout(timer)
    killTree(child)
  }
}

// ---- Consulta por provedor, com cache curto (falhas tambem, para nao reabrir a CLI a cada clique).
const cache = new Map<string, { at: number; cat: Catalog }>()
const TTL = 10 * 60_000, TTL_ERR = 30_000

async function build(provider: string, env?: NodeJS.ProcessEnv): Promise<Catalog> {
  const base = { provider, at: now() }
  if (provider === 'claude') {
    const r = await runCli('claude', ['--help'], { env })
    const { aliases, efforts } = parseClaudeHelp(r.stdout)
    if (r.code !== 0 || !aliases.length) throw new Error(sanitize(r.failed ?? (r.stderr || 'nao consegui ler os modelos do --help')))
    return { ...base, source: 'help', models: claudeModels(aliases), efforts, allowCustomModel: true,
      note: 'A CLI nao lista modelos por conta: ids completos conhecidos + apelidos do --help; outro id completo pode ser digitado. A CLI valida ao executar; o esforco aceito pode variar por modelo.' }
  }
  if (provider === 'codex')
    return { ...base, source: 'native', models: await codexModels(env), efforts: [], allowCustomModel: false, note: 'Catalogo do App Server do Codex (modelos e esforcos por modelo).' }
  if (provider === 'opencode') {
    const auth = await runCli('opencode', ['auth', 'list'], { env })
    const models: ModelOpt[] = []
    for (const p of parseOpencodeProviders(auth.stdout)) {
      const r = await runCli('opencode', ['models', p, '--verbose'], { env, timeout: 60_000 })
      if (r.code === 0) models.push(...parseOpencodeVerbose(r.stdout))
    }
    if (!models.length) throw new Error('o opencode nao listou modelos para os provedores configurados')
    return { ...base, source: 'native', models, efforts: [], allowCustomModel: false, note: 'Modelos dos provedores com credencial (opencode models); o esforco sao as variantes de cada modelo.' }
  }
  // gemini: sem comando de catalogo nem configuracao de raciocinio comprovada nesta versao.
  return { ...base, source: 'manual', models: [], efforts: [], allowCustomModel: true,
    note: 'A CLI nao lista modelos: informe o id (ex.: o que aparece na documentacao do Gemini CLI). Esforco/raciocinio nao e exposto porque nenhuma configuracao esta comprovada nesta versao.' }
}

// Consultas simultaneas do mesmo provedor (varias telas, envio) compartilham a CLI em andamento, inclusive as forcadas.
const pending = new Map<string, Promise<Catalog>>()
export function getCatalog(provider: string, env?: NodeJS.ProcessEnv, force = false): Promise<Catalog> {
  const c = cache.get(provider)
  if (!force && c && Date.now() - c.at < (c.cat.error ? TTL_ERR : TTL)) return Promise.resolve(c.cat)
  const running = pending.get(provider)
  if (running) return running
  const p = (async () => {
    let cat: Catalog
    try {
      cat = await build(provider, env)
    } catch (e: any) {
      cat = { provider, at: now(), source: provider === 'gemini' ? 'manual' : 'native', models: [], efforts: [], allowCustomModel: false, error: sanitize(String(e?.message ?? e)).slice(0, 300) }
    }
    cache.set(provider, { at: Date.now(), cat })
    return cat
  })().finally(() => pending.delete(provider))
  pending.set(provider, p)
  return p
}

// Valida modelo/esforco escolhidos contra o catalogo. Devolve a mensagem de erro ou null. Nunca troca o pedido do usuario.
export function validateSelection(cat: Catalog, model?: string | null, effort?: string | null): string | null {
  const m = model ? cat.models.find(x => x.id === model) : undefined
  if (model) {
    if (cat.error && !cat.allowCustomModel) return `Catalogo de ${cat.provider} indisponivel (${cat.error}). Escolha "padrao do provedor" ou tente de novo.`
    if (!m && !cat.allowCustomModel) return `O modelo "${model}" nao consta no catalogo de ${cat.provider}.`
  }
  if (effort) {
    if (!m && cat.models.some(x => x.efforts !== null)) return 'Escolha um modelo para definir o esforco (as opcoes dependem do modelo).'
    const options = m?.efforts ?? cat.efforts
    if (!options.length) return `${cat.provider} nao expoe esforco${model ? ` para "${model}"` : ''} nesta versao.`
    if (!options.includes(effort)) return `O esforco "${effort}" nao e suportado${model ? ` por "${model}"` : ''} (opcoes: ${options.join(', ')}).`
  }
  return null
}

// Ultimo catalogo em cache (sem consultar a CLI); usado para complementar medidas depois de uma execucao.
export const peekCatalog = (provider: string) => cache.get(provider)?.cat
