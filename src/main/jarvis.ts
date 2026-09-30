// Jarvis: assistente da home. Responde sobre os projetos a partir de um retrato compacto (sem ler arquivos) e pode
// propor acoes simples que a interface executa: mandar algo para a to-do ou abrir um projeto. Sem dependencia de 'electron'.
import { AGENTS } from './adapters.ts'

export type JarvisSettings = { accountId?: number; model: string; effort: string }
export const DEFAULT_JARVIS: JarvisSettings = { model: 'claude-sonnet-5-5', effort: 'medium' }

export type Snapshot = {
  now: string
  projects: { name: string; kind: string; stack: string; branch: string | null; uncommitted: number; worktrees: number; openTasks: number; lastActivity: string | null; recent: string[] }[]
  agents: { provider: string; project: string; task: string; minutes: number }[]
  todo: { topic: string; text: string; done: boolean; project?: string; agent?: string }[]
}
export type Turn = { role: 'user' | 'jarvis'; text: string }
export type Action = { type: 'todo'; text: string; project?: string; topic?: string } | { type: 'open'; project: string }

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// Entrada vinda do renderer (to-do e historico) passa por limites de tamanho: e fronteira de confianca.
export function sanitizeInput(todo: unknown, history: unknown) {
  const t = (Array.isArray(todo) ? todo : []).slice(0, 80).map((i: any) => ({
    topic: clip(i?.topic, 60), text: clip(i?.text, 300), done: i?.done === true, project: i?.project ? clip(i.project, 80) : undefined, agent: i?.agent ? clip(i.agent, 20) : undefined,
  })).filter(i => i.text)
  const h = (Array.isArray(history) ? history : []).slice(-6).map((x: any) => ({ role: x?.role === 'jarvis' ? 'jarvis' : 'user', text: clip(x?.text, 1500) }) as Turn).filter(x => x.text)
  return { todo: t, history: h }
}

// Instrucoes fixas (identicas em toda pergunta). No modo enxuto vao como prompt de SISTEMA (arquivo), no lugar do prompt de agente de codigo
// do Claude Code, que o Jarvis nao usa; no modo compativel vao no inicio da mensagem, como antes.
export const JARVIS_INSTRUCTIONS = `Voce e o Jarvis, assistente do painel de projetos (jogos e apps) do usuario. O usuario tem TDAH: responda em portugues do Brasil, direto, no maximo 4 frases curtas ou uma lista de ate 5 itens, e termine com UM proximo passo concreto quando fizer sentido.
Responda so com base no retrato enviado na mensagem; se faltar informacao, diga o que falta. Nao use ferramentas nem leia arquivos.

Acoes: se o usuario pedir para fixar/anotar/lembrar algo, ou se for claramente util, adicione no FINAL linhas no formato exato (uma por acao, JSON numa linha):
ACAO: {"type":"todo","text":"texto curto","project":"nome exato do projeto ou omita","topic":"topico existente ou omita"}
ACAO: {"type":"open","project":"nome exato do projeto"}
Nunca invente projetos. Nao descreva as linhas ACAO no texto.`
export const JARVIS_SYSTEM_FILE = 'jarvis-system.md' // relativo a pasta de trabalho do Jarvis: nenhum caminho com espacos na linha de comando

// lean: instrucoes no prompt de sistema (arquivo) em vez de na mensagem.
export function buildPrompt(s: Snapshot, history: Turn[], question: string, o: { lean?: boolean } = {}) {
  const projects = s.projects.map(p =>
    `- ${p.name} (${p.kind === 'game' ? 'jogo' : 'app'}, ${p.stack}): branch ${p.branch ?? 'sem git'}, ${p.uncommitted} arquivo(s) sem commit, ${p.worktrees} worktree(s), ${p.openTasks} tarefa(s) aberta(s), ultima atividade ${p.lastActivity ?? 'nunca'}${p.recent.length ? `; recentes: ${p.recent.join(' | ')}` : ''}`).join('\n') || '- nenhum projeto'
  const agents = s.agents.map(a => `- ${a.provider} em ${a.project}: "${a.task}" ha ${a.minutes} min`).join('\n') || '- nenhum'
  const todo = s.todo.map(t => `- [${t.done ? 'x' : ' '}] (${t.topic}) ${t.text}${t.project ? ` #${t.project}` : ''}${t.agent ? ` -> delegado a ${t.agent}` : ''}`).join('\n') || '- vazia'
  const convo = history.map(t => `${t.role === 'user' ? 'Usuario' : 'Jarvis'}: ${t.text}`).join('\n')
  return `${o.lean ? '' : `${JARVIS_INSTRUCTIONS}\n\n`}Retrato (${s.now}):
Projetos:
${projects}
Agentes trabalhando agora:
${agents}
To-do do usuario:
${todo}
${convo ? `\nConversa recente:\n${convo}\n` : ''}
Pergunta do usuario: ${clip(question, 4000)}`
}

// Argumentos do Jarvis. Enxuto: sem ferramentas nativas (o Jarvis so le o retrato), sem servidores MCP da configuracao global do usuario
// (--strict-mcp-config SEM --mcp-config = nenhum; nada e alterado na configuracao) e com o prompt de sistema proprio. Compativel: o de antes
// (modo leitura, instrucoes na mensagem), usado se a CLI recusar o enxuto.
export function jarvisArgs(o: { model?: string; effort?: string; lean: boolean }): string[] {
  const base = { model: o.model, effort: o.effort, mode: 'read' as const }
  return o.lean ? AGENTS.claude.chatArgs(undefined, { ...base, tools: [], extra: ['--strict-mcp-config', '--system-prompt-file', JARVIS_SYSTEM_FILE] }) : AGENTS.claude.chatArgs(undefined, base)
}

// Modo enxuto recusado pela CLI (opcao desconhecida, prompt de sistema nao aceito...): repetir UMA vez no compativel. So quando nada foi
// respondido (falha antes de qualquer texto): nunca duplica uma resposta; cancelamento nunca repete.
export const retryCompat = (lean: boolean, r: { status: string; text: string }) => lean && r.status === 'failed' && !r.text

// Separa o texto da resposta das linhas ACAO. Acao invalida ou com projeto desconhecido e descartada.
export function parseReply(text: string, projects: string[]): { text: string; actions: Action[] } {
  const actions: Action[] = []
  const known = (p: unknown) => projects.find(x => x.toLowerCase() === String(p ?? '').toLowerCase())
  const kept = text.split(/\r?\n/).filter(line => {
    const m = line.match(/^\s*A[CÇ][AÃ]O:\s*(.*)$/i)
    if (!m) return true // linha ACAO malformada tambem sai do texto
    try {
      const a = JSON.parse(m[1])
      if (a?.type === 'todo' && typeof a.text === 'string' && a.text.trim())
        actions.push({ type: 'todo', text: clip(a.text, 300), project: known(a.project), topic: a.topic ? clip(a.topic, 60) : undefined })
      else if (a?.type === 'open' && known(a.project)) actions.push({ type: 'open', project: known(a.project)! })
    } catch {}
    return false
  })
  return { text: kept.join('\n').trim(), actions }
}
