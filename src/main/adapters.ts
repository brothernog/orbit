// Adaptadores das CLIs: argumentos de cada operacao e traducao da saida JSON em eventos tipados.
// Formatos conferidos nas versoes instaladas (claude 2.1.284, codex 0.147.0, gemini 0.60.0, opencode 1.18.31);
// os campos de eventos que so aparecem em chamadas reais estao marcados em docs/roadmap.md como nao validados.
import path from 'node:path'

// Medidas de tokens. Cada campo so existe quando o provedor o informa; nada e inferido do texto visivel.
export type Metric = {
  occupied?: number // tokens ocupando a janela na ultima chamada (contexto ocupado)
  capacity?: number // tamanho da janela do modelo
  consumedIn?: number // consumo de entrada (como o provedor rotula; cache pode estar dentro ou fora: ver cacheReadIncluded)
  consumedOut?: number // consumo de saida (como o provedor rotula)
  cacheRead?: number // tokens de entrada servidos do cache, quando informado
  cacheWrite?: number // tokens gravados no cache, quando informado
  reasoning?: number // raciocinio, quando informado separadamente
  reasoningIncluded?: boolean // true = ja esta dentro de consumedOut (nao somar); false = separado; ausente = desconhecido
  cacheReadIncluded?: boolean // true = cacheRead ja esta dentro de consumedIn
  scope?: 'run' | 'thread' // consumo da execucao ou acumulado do thread (thread = cumulativo entre execucoes)
  estimated?: boolean // aproximacao (ex.: soma de campos que o provedor nao rotula como contexto)
  source: string // de onde veio (evento/arquivo/catalogo)
}

export type Ev =
  | { kind: 'session'; id: string }
  | { kind: 'text'; text: string; delta?: boolean } // delta: pedaco de um texto maior, concatenar sem separador
  | { kind: 'tool'; name: string; detail?: string } // detail: alvo curto (arquivo, padrao, comando), so para mostrar o que o agente faz agora
  | { kind: 'usage'; data: any } // janelas de limite da CONTA (rate limit), nao e contexto
  | { kind: 'context'; metric: Metric; accumulate?: boolean; key?: string } // accumulate: somar consumo ao anterior (eventos por passo); key: id do passo, repetido = ignorado
  | { kind: 'note'; text: string } // aviso nao fatal (ex.: acao negada pela protecao do provedor)
  | { kind: 'error'; message: string; fatal: boolean }
  | { kind: 'done'; text?: string } // conclusao explicita; text = resposta final quando nao houve texto antes

// Modelo/esforco escolhidos para a execucao; ausentes = padrao da propria CLI (nada e substituido em silencio).
// mode 'read' = execucao somente leitura, limitada pelas proprias ferramentas/sandbox do provedor (delegacoes):
// claude so recebe Read/Grep/Glob, codex usa a sandbox read-only, gemini usa approval-mode plan. (opencode: ver delegation.ts.)
// extra = argumentos ja montados e confiaveis pelo app (ex.: ferramenta MCP de delegacao).
// sandbox/network: politica nativa do Codex (que nao pergunta no modo headless); so vale fora do modo leitura, que nunca e alargado.
// tools (so Claude): lista EXPLICITA de ferramentas nativas, no lugar da padrao do modo; [] = nenhuma (Jarvis; filho com escopo que usa so o MCP).
// Nunca amplia o modo leitura: quem chama so passa subconjuntos de Read/Grep/Glob. Vazio vai como `--tools=` (sem argumento vazio na linha de comando).
export type ChatOpts = { model?: string; effort?: string; mode?: 'read' | 'edit'; extra?: string[]; sandbox?: 'workspace-write' | 'danger-full-access'; network?: boolean; permissionMode?: 'auto'; tools?: string[]; images?: string[] } // images: caminhos ja validados (attachments.ts)
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
export function claudeTools(o?: ChatOpts): string[] {
  if (o?.tools) {
    if (o.mode === 'read' && o.tools.some(t => !READ_TOOLS.has(t))) throw new Error('Modo leitura so aceita Read, Grep e Glob.')
    return o.tools.length ? ['--tools', o.tools.map(safeArg).join(',')] : ['--tools=']
  }
  return o?.mode === 'read' ? ['--tools', 'Read,Grep,Glob'] : []
}

export type Agent = {
  cmd: string
  promptArgs: (p: string) => string[] // terminal interativo com prompt inicial
  resumeArgs: (sid: string) => string[] // terminal continuando a sessao exata do chat
  chatArgs: (sid?: string, o?: ChatOpts) => string[] // modo headless; a mensagem vai pelo stdin, nunca na linha de comando
  parse: (ev: any) => Ev[] // uma linha JSON da saida headless
}

// ponytail: cmd.exe nao tem escape confiavel dentro de aspas; removemos os caracteres perigosos.
export const q = (s: string) => `"${s.replace(/["%^\r\n&|<>]+/g, ' ').trim()}"`

// Ids de sessao, modelos e esforcos entram na linha de comando: so caracteres inofensivos (sem espaco, aspas, & | < > ^ %).
export const SAFE_ARG = /^[\w.:@=+/-]{1,200}$/
export const safeArg = (s: string) => {
  if (!SAFE_ARG.test(s)) throw new Error('Argumento com caracteres nao permitidos.')
  return s
}
// Alvo curto de uma ferramenta: nome do arquivo (sem a pasta), padrao de busca ou inicio do comando.
export const toolDetail = (i: any): string | undefined => {
  const f = i?.file_path ?? i?.notebook_path ?? i?.path
  if (typeof f === 'string' && f) return f.split(/[\\/]/).filter(Boolean).pop() // os dois separadores: a CLI pode rodar em outro sistema que o app
  const c = i?.command ?? i?.pattern ?? i?.query ?? i?.url
  return typeof c === 'string' && c ? c.replace(/\s+/g, ' ').slice(0, 60) : undefined
}
const flag = (name: string, v?: string) => (v ? [name, safeArg(v)] : [])
// Claude e Gemini leem a imagem citada no texto com a propria ferramenta de leitura: basta liberar a pasta dos anexos.
const imgDirs = (name: string, o?: ChatOpts) => [...new Set((o?.images ?? []).map(f => path.dirname(f)))].flatMap(d => [name, d])

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const msg = (v: any) => str(v?.message) ?? str(v?.error?.message) ?? str(v?.data?.message) ?? str(v?.name) ?? (v ? JSON.stringify(v).slice(0, 300) : 'erro sem detalhe')

export const AGENTS: Record<string, Agent> = {
  claude: {
    cmd: 'claude', promptArgs: p => [q(p)], resumeArgs: s => ['--resume', safeArg(s)],
    chatArgs: (s, o) => ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', o?.permissionMode === 'auto' && o.mode !== 'read' ? 'auto' : 'acceptEdits', ...flag('--model', o?.model), ...flag('--effort', o?.effort), ...imgDirs('--add-dir', o), ...claudeTools(o), ...(o?.extra ?? []), ...(s ? ['--resume', safeArg(s)] : [])],
    parse: ev => {
      const out: Ev[] = []
      if (str(ev.session_id)) out.push({ kind: 'session', id: ev.session_id })
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text })
          else if (c.type === 'tool_use') { const detail = toolDetail(c.input); out.push(detail ? { kind: 'tool', name: c.name, detail } : { kind: 'tool', name: c.name }) }
        }
        // Contexto ocupado = entrada total da ULTIMA chamada ao modelo (entrada + cache lido + cache criado).
        const u = ev.message?.usage
        if (u && num(u.input_tokens) !== undefined)
          out.push({ kind: 'context', metric: { occupied: u.input_tokens + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0), source: 'usage da ultima mensagem do Claude' } })
      }
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.unifiedWindows) out.push({ kind: 'usage', data: ev.rate_limit_info.unifiedWindows })
      if (ev.type === 'result') {
        // Em headless a CLI nao pergunta: o que exigiria permissao e negado e listado aqui.
        const denied = (ev.permission_denials ?? []).map((d: any) => d.tool_name).filter(Boolean)
        if (denied.length) out.push({ kind: 'note', text: `Acoes negadas pela protecao do Claude: ${[...new Set(denied)].join(', ')}. Use o Terminal para aprovar de forma interativa.` })
        // Janela do modelo, quando o resultado a informa (modelUsage.<modelo>.contextWindow).
        const win = Object.values(ev.modelUsage ?? {}).map((m: any) => num(m?.contextWindow)).find(Boolean)
        const m: Metric = {
          source: 'resultado da execucao do Claude', scope: 'run', consumedIn: num(ev.usage?.input_tokens), consumedOut: num(ev.usage?.output_tokens), capacity: win,
          cacheRead: num(ev.usage?.cache_read_input_tokens), cacheWrite: num(ev.usage?.cache_creation_input_tokens), cacheReadIncluded: false // input_tokens exclui cache (soma-se a entrada total)
        }
        if (m.capacity !== undefined || m.consumedIn !== undefined || m.consumedOut !== undefined || m.cacheRead !== undefined) out.push({ kind: 'context', metric: m })
        if (ev.is_error) out.push({ kind: 'error', message: str(ev.result) ?? str(ev.subtype) ?? 'erro sem detalhe', fatal: true })
        else out.push({ kind: 'done', text: str(ev.result) })
      }
      return out
    }
  },
  codex: {
    cmd: 'codex', promptArgs: p => [q(p)], resumeArgs: s => ['resume', safeArg(s)],
    // --skip-git-repo-check: pastas sem Git continuam permitindo chat (a sandbox workspace-write continua valendo).
    // Modelo e esforco vao antes de `resume` (opcoes do `exec`); o esforco e o override de config model_reasoning_effort.
    chatArgs: (s, o) => ['exec', '--json', '--skip-git-repo-check', '-s', o?.mode === 'read' ? 'read-only' : o?.sandbox ?? 'workspace-write', ...(o?.network && o.mode !== 'read' && (o.sandbox ?? 'workspace-write') === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []), ...flag('-m', o?.model), ...(o?.effort ? ['-c', `model_reasoning_effort=${safeArg(o.effort)}`] : []), ...(o?.extra ?? []), ...(s ? ['resume', safeArg(s)] : []), ...(o?.images ?? []).map(f => `--image=${f}`), '-'], // `-i a -` engoliria o '-' como imagem
    parse: ev => {
      switch (ev.type) {
        case 'thread.started': return str(ev.thread_id) ? [{ kind: 'session', id: ev.thread_id }] : []
        case 'item.started': return ev.item?.type === 'command_execution' ? [{ kind: 'tool', name: String(ev.item.command) }] : []
        case 'item.completed': return ev.item?.type === 'agent_message' && ev.item.text ? [{ kind: 'text', text: ev.item.text }] : []
        // `exec --json` so informa o uso acumulado do thread; janela e contexto ocupado nao vem neste fluxo.
        case 'turn.completed': return [
          // Semantica conferida no arquivo de sessao do codex 0.147.0: cached_input_tokens esta dentro de input_tokens e
          // reasoning_output_tokens dentro de output_tokens (total_tokens = entrada + saida). O formato do turn.completed em si so muda com chamada real.
          ...(ev.usage ? [{ kind: 'context', metric: {
            consumedIn: num(ev.usage.input_tokens), consumedOut: num(ev.usage.output_tokens), cacheRead: num(ev.usage.cached_input_tokens), cacheWrite: num(ev.usage.cache_write_input_tokens),
            reasoning: num(ev.usage.reasoning_output_tokens), reasoningIncluded: true, cacheReadIncluded: true, scope: 'thread', source: 'turn.completed do codex exec (acumulado do thread)'
          } } as Ev] : []),
          { kind: 'done' }
        ]
        case 'turn.failed': return [{ kind: 'error', message: msg(ev.error ?? ev), fatal: true }]
        // "Reconnecting... n/5" e semelhantes: transitorio, so vira falha se a execucao terminar mal.
        case 'error': return [{ kind: 'error', message: msg(ev), fatal: false }]
        default: return []
      }
    }
  },
  gemini: {
    // Retoma pelo id exato da sessao (o Gemini 0.60 aceita `--resume <uuid>`); nunca `latest`.
    // Sem esforco: nenhuma configuracao de raciocinio esta comprovada como suportada pela CLI.
    cmd: 'gemini', promptArgs: p => ['-i', q(p)], resumeArgs: s => ['--resume', safeArg(s)],
    chatArgs: (s, o) => ['-p', '" "', '-o', 'stream-json', '--approval-mode', o?.mode === 'read' ? 'plan' : 'auto_edit', ...flag('-m', o?.model), ...imgDirs('--include-directories', o), ...(o?.extra ?? []), ...(s ? ['--resume', safeArg(s)] : [])],
    parse: ev => {
      switch (ev.type) {
        case 'init': return str(ev.session_id) ? [{ kind: 'session', id: ev.session_id }] : []
        case 'message': return ev.role === 'assistant' && ev.content ? [{ kind: 'text', text: String(ev.content), delta: !!ev.delta }] : []
        case 'tool_use': return [{ kind: 'tool', name: String(ev.tool_name) }]
        case 'error': return [{ kind: 'error', message: msg(ev), fatal: ev.severity === 'error' }]
        case 'result': {
          if (ev.status === 'error') return [{ kind: 'error', message: 'O Gemini terminou com erro.', fatal: true }]
          const s = ev.stats
          const m: Metric = { source: 'estatisticas do resultado do Gemini', scope: 'run', consumedIn: num(s?.input_tokens ?? s?.input), consumedOut: num(s?.output_tokens ?? s?.output), cacheRead: num(s?.cached) }
          return [...(m.consumedIn !== undefined || m.consumedOut !== undefined ? [{ kind: 'context', metric: m } as Ev] : []), { kind: 'done' }]
        }
        default: return []
      }
    }
  },
  opencode: {
    cmd: 'opencode', promptArgs: p => ['--prompt', q(p)], resumeArgs: s => ['--session', safeArg(s)],
    // --print-logs --log-level ERROR: o evento de erro do stdout e generico ("Unexpected server error"); a causa real (ex.: modelo inexistente
    // no opencode.json do projeto) so aparece no stderr, e so com logs de erro ligados. Nao muda o stdout.
    chatArgs: (s, o) => ['run', '--format', 'json', '--print-logs', '--log-level', 'ERROR', ...flag('-m', o?.model), ...flag('--variant', o?.effort), ...(o?.images?.length ? ['-f', ...o.images] : []), ...(o?.extra ?? []), ...(s ? ['--session', safeArg(s)] : [])],
    parse: ev => {
      const out: Ev[] = []
      if (str(ev.sessionID)) out.push({ kind: 'session', id: ev.sessionID })
      if (ev.type === 'text' && ev.part?.text) out.push({ kind: 'text', text: ev.part.text })
      else if (ev.type === 'tool_use') out.push({ kind: 'tool', name: String(ev.part?.tool) })
      else if (ev.type === 'step_finish') {
        const t = ev.part?.tokens
        if (t) { // por passo: o consumo soma; a entrada do ultimo passo e uma APROXIMACAO do contexto ocupado
          const cache = (num(t.cache?.read) ?? 0) + (num(t.cache?.write) ?? 0)
          // consumedOut = so `output`; raciocinio fica separado e sem afirmar se ja esta dentro de `output` (nao verificado).
          out.push({ kind: 'context', accumulate: true, key: str(ev.part?.id) ?? str(ev.part?.messageID), metric: {
            occupied: num(t.input) !== undefined ? t.input + cache : undefined, estimated: true, scope: 'run',
            consumedIn: num(t.input), consumedOut: num(t.output), reasoning: num(t.reasoning), cacheRead: num(t.cache?.read), cacheWrite: num(t.cache?.write), source: 'step_finish do opencode'
          } })
        }
        if (ev.part?.reason === 'stop') out.push({ kind: 'done' })
      } else if (ev.type === 'error') out.push({ kind: 'error', message: msg(ev.error), fatal: true })
      return out
    }
  }
}
