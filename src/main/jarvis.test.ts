import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeTools } from './adapters.ts'
import { buildPrompt, JARVIS_INSTRUCTIONS, JARVIS_SYSTEM_FILE, jarvisArgs, parseReply, retryCompat, sanitizeInput } from './jarvis.ts'

test('jarvis: linhas ACAO viram acoes e somem do texto; projeto desconhecido e descartado', () => {
  const r = parseReply('Feito.\nACAO: {"type":"todo","text":"Testar save","project":"sky raiders"}\nACAO: {"type":"open","project":"Inventado"}\nAÇÃO: {"type":"open","project":"Sky Raiders"}\nACAO: {quebrado', ['Sky Raiders'])
  assert.equal(r.text, 'Feito.')
  assert.deepEqual(r.actions, [{ type: 'todo', text: 'Testar save', project: 'Sky Raiders', topic: undefined }, { type: 'open', project: 'Sky Raiders' }])
})

test('jarvis: entrada do renderer e limitada e o prompt leva o retrato', () => {
  const { todo, history } = sanitizeInput([{ topic: 'Entrada', text: 'x'.repeat(900) }, { text: '' }, 'lixo'], Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `m${i}` })))
  assert.equal(todo.length, 1)
  assert.equal(todo[0].text.length, 300)
  assert.deepEqual(history.map(h => h.text), ['m4', 'm5', 'm6', 'm7', 'm8', 'm9'])
  const p = buildPrompt({ now: 'agora', projects: [{ name: 'Sky', kind: 'game', stack: 'Godot', branch: 'main', uncommitted: 3, worktrees: 1, openTasks: 2, lastActivity: null, recent: ['IA'] }], agents: [], todo }, history, 'o que falta?')
  assert.match(p, /Sky \(jogo, Godot\): branch main, 3 arquivo/)
  assert.match(p, /Pergunta do usuario: o que falta\?/)
})

test('jarvis enxuto: sem ferramentas, sem MCP global, instrucoes no prompt de sistema; compativel igual ao de antes', () => {
  const lean = jarvisArgs({ model: 'claude-sonnet-5-5', effort: 'medium', lean: true })
  assert.ok(lean.includes('--tools=') && !lean.includes('Read,Grep,Glob'))
  assert.ok(lean.includes('--strict-mcp-config') && !lean.includes('--mcp-config')) // nenhum servidor MCP (nem os da configuracao global)
  assert.equal(lean[lean.indexOf('--system-prompt-file') + 1], JARVIS_SYSTEM_FILE) // relativo: nada de caminho com espacos na linha de comando
  assert.ok(!lean.some(a => a === '')) // nenhum argumento vazio
  assert.deepEqual(jarvisArgs({ model: 'm', effort: 'e', lean: false }), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--model', 'm', '--effort', 'e', '--tools', 'Read,Grep,Glob'])
  const snap = { now: 'agora', projects: [], agents: [], todo: [] }
  const leanPrompt = buildPrompt(snap, [], 'oi', { lean: true })
  assert.ok(leanPrompt.startsWith('Retrato (agora)') && !leanPrompt.includes('Voce e o Jarvis'))
  assert.ok(buildPrompt(snap, [], 'oi').startsWith(JARVIS_INSTRUCTIONS)) // compativel: instrucoes na mensagem, como antes
})

test('ferramentas nativas do Claude: lista explicita, vazia sem argumento vazio, e o modo leitura nunca e ampliado', () => {
  assert.deepEqual(claudeTools({ mode: 'read' }), ['--tools', 'Read,Grep,Glob'])
  assert.deepEqual(claudeTools({ mode: 'read', tools: ['Grep', 'Glob'] }), ['--tools', 'Grep,Glob'])
  assert.deepEqual(claudeTools({ mode: 'read', tools: [] }), ['--tools='])
  assert.deepEqual(claudeTools({ mode: 'edit' }), [])
  assert.throws(() => claudeTools({ mode: 'read', tools: ['Grep', 'Bash'] }), /so aceita Read, Grep e Glob/)
  assert.throws(() => claudeTools({ tools: ['Grep;calc'] }), /nao permitidos/)
})

test('jarvis: so repete no modo compativel quando o enxuto falhou sem responder nada', () => {
  assert.equal(retryCompat(true, { status: 'failed', text: '' }), true)
  assert.equal(retryCompat(true, { status: 'failed', text: 'meia resposta' }), false) // nunca duplica resposta
  assert.equal(retryCompat(true, { status: 'cancelled', text: '' }), false)
  assert.equal(retryCompat(false, { status: 'failed', text: '' }), false) // o compativel nao se repete
})
