// Eventos simulados; nenhuma chamada de modelo ou login. Contratos publicos das CLIs e SDKs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS, type Ev } from './adapters.ts'
import { activityStream, MAX_ACTIVITY_TEXT, patchActivity, toolActivity, type Activity } from './agentActivity.ts'
import { runChat } from './runner.ts'

const activities = (events: Ev[]) => events.filter((e): e is Extract<Ev, { kind: 'activity' }> => e.kind === 'activity').map(e => e.activity)

test('Claude: leituras numeradas, imagem, edicao e multi-edicao usam apenas parametros declarados', () => {
  const content = [
    { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'src/a.ts', offset: 12, limit: 3 } },
    { type: 'tool_use', id: 'i', name: 'Read', input: { file_path: 'assets/a.png' } },
    { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' } },
    { type: 'tool_use', id: 'm', name: 'MultiEdit', input: { file_path: 'src/b.ts', edits: [{ old_string: 'x', new_string: 'y' }] } },
    { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'src/new.ts', content: 'x\ny\n' } }
  ]
  const ev = AGENTS.claude.parse({ type: 'assistant', message: { content } })
  assert.equal(ev.filter(e => e.kind === 'tool').length, 5)
  assert.deepEqual(activities(ev), [
    { kind: 'read', tool: 'Read', path: 'src/a.ts', line: 12, endLine: 14, position: 'reported', ref: 'r' },
    { kind: 'image', tool: 'Read', path: 'assets/a.png', ref: 'i' },
    { kind: 'edit', tool: 'Edit', path: 'src/a.ts', ref: 'e' },
    { kind: 'edit', tool: 'MultiEdit', path: 'src/b.ts', ref: 'm' },
    { kind: 'edit', tool: 'Write', path: 'src/new.ts', ref: 'w' }
  ]) // contagens e linha de edicao nao sao inventadas a partir da proposta
  assert.deepEqual(toolActivity('claude', 'Grep', { path: 'src', pattern: 'a.ts:12' }), [])
  assert.deepEqual(toolActivity('codex', 'exec_command', { command: 'cat src/a.ts' }), [])
  assert.deepEqual(toolActivity('claude', 'Read', { file_path: 'a.ts', offset: -1, limit: 3 }), [{ kind: 'read', tool: 'Read', path: 'a.ts' }])
})

test('Claude: resultado estruturado informa linhas lidas e diff aplicado, sem contar erro ou escrita retida', () => {
  const result = (value: any, error = false) => activities(AGENTS.claude.parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit1', is_error: error, content: 'ok' }] }, tool_use_result: value }))
  assert.deepEqual(result({ type: 'text', file: { filePath: 'a.ts', startLine: 8, numLines: 2 } }), [{ kind: 'read', path: 'a.ts', ref: 'edit1', line: 8, endLine: 9, position: 'reported' }])
  const value = { filePath: 'a.ts', structuredPatch: [{ newStart: 10, lines: [' context', '-old', '+new', '+extra', ' tail'] }] }
  assert.deepEqual(result(value), [{ kind: 'edit', path: 'a.ts', ref: 'edit1', line: 11, endLine: 12, position: 'diff', added: 2, removed: 1 }])
  assert.deepEqual(result(value, true), [])
  assert.deepEqual(result({ ...value, staged: true }), [])
  assert.deepEqual(result({ filePath: 'a.ts', structuredPatch: [] }), [{ kind: 'edit', path: 'a.ts', ref: 'edit1' }])
})

test('Codex: file_change so identifica arquivos; raciocinio e MCP permanecem observabilidade', () => {
  const p = AGENTS.codex.parse
  assert.deepEqual(activities(p({ type: 'item.completed', item: { id: 'edit2', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] } })), [
    { kind: 'edit', tool: 'file_change', path: 'src/a.ts', ref: 'edit2' }, { kind: 'edit', tool: 'file_change', path: 'src/b.ts', ref: 'edit2' }
  ])
  assert.deepEqual(p({ type: 'item.completed', item: { type: 'file_change', status: 'failed', changes: [{ path: 'a.ts' }] } }), [])
  assert.deepEqual(activities(p({ type: 'item.completed', item: { id: 'think1', type: 'reasoning', text: 'Revisando o trecho exposto.' } })), [{ kind: 'thinking', ref: 'think1', summary: 'Revisando o trecho exposto.' }])
  assert.deepEqual(activities(p({ type: 'item.started', item: { id: 'mcp1', type: 'mcp_tool_call', tool: 'read_file_range', arguments: { path: 'a.ts', startLine: 3, endLine: 6 } } })), [{ kind: 'read', tool: 'read_file_range', path: 'a.ts', ref: 'mcp1', line: 3, endLine: 6, position: 'reported' }])
  assert.deepEqual(activities(p({ type: 'item.started', item: { id: 'img1', type: 'mcp_tool_call', tool: 'view_image', arguments: { path: 'assets/x.webp' } } })), [{ kind: 'image', tool: 'view_image', path: 'assets/x.webp', ref: 'img1' }])
  assert.deepEqual(p({ type: 'item.completed', item: { type: 'reasoning', encrypted_content: 'opaque' } }), [])
  assert.deepEqual(activities(p({ type: 'item.started', item: { id: 'collab1', type: 'collab_tool_call', tool: 'send_input', receiver_thread_ids: ['native2'], prompt: 'Confira a implementacao.' } })), [{ kind: 'message', tool: 'send_input', agent: 'native2', direction: 'sent', title: 'Mensagem ao subagente CLI', ref: 'collab1:sent:native2', summary: 'Confira a implementacao.' }])
  assert.deepEqual(activities(p({ type: 'item.completed', item: { id: 'collab2', type: 'collab_tool_call', tool: 'wait', status: 'completed', agents_states: { native2: { status: 'completed', message: 'Revisao concluida.' } } } })), [{ kind: 'message', tool: 'wait', agent: 'native2', direction: 'received', title: 'Mensagem do subagente CLI', ref: 'collab2:received:native2', summary: 'Revisao concluida.' }])
})

test('Gemini: parameters fornecem arquivo e range; resultado conserva ref e estado informado', () => {
  const p = AGENTS.gemini.parse
  const read = p({ type: 'tool_use', tool_name: 'read_file', tool_id: 'g1', parameters: { file_path: 'src/g.ts', start_line: 20, end_line: 23 } })
  assert.deepEqual(read[0], { kind: 'tool', name: 'read_file', detail: 'g.ts', ref: 'g1' })
  assert.deepEqual(activities(read), [{ kind: 'read', tool: 'read_file', path: 'src/g.ts', ref: 'g1', line: 20, endLine: 23, position: 'reported' }])
  assert.equal(activities(p({ type: 'tool_use', tool_name: 'read_file', parameters: { file_path: 'assets/x.jpg' } }))[0].kind, 'image')
  assert.deepEqual(activities(p({ type: 'tool_use', tool_name: 'replace', parameters: { file_path: 'src/g.ts', old_string: 'a', new_string: 'b' } })), [{ kind: 'edit', tool: 'replace', path: 'src/g.ts' }])
  assert.deepEqual(p({ type: 'tool_result', tool_id: 'g1', status: 'error', output: 'falhou' }), [{ kind: 'toolResult', ref: 'g1', ok: false, output: 'falhou' }])
})

test('OpenCode: state.input e metadata.files/filediff observam leitura e edicoes multi-arquivo', () => {
  const p = AGENTS.opencode.parse
  const read = p({ type: 'tool_use', part: { id: 'p1', callID: 'o1', tool: 'read', state: { status: 'completed', input: { filePath: 'src/o.ts', offset: 5, limit: 4 } } } })
  assert.deepEqual(activities(read), [{ kind: 'read', tool: 'read', path: 'src/o.ts', ref: 'o1', line: 5, endLine: 8, position: 'reported' }])
  const patch = '--- a\n+++ a\n@@ -4,3 +4,4 @@\n context\n-old\n+new\n+extra\n tail\n'
  const edit = p({ type: 'tool_use', part: { callID: 'o2', tool: 'apply_patch', state: { status: 'completed', input: {}, metadata: { files: [{ filePath: 'a.ts', patch, additions: 2, deletions: 1 }, { filePath: 'b.ts', additions: 4, deletions: 0 }] } } } })
  assert.deepEqual(activities(edit), [
    { kind: 'edit', tool: 'apply_patch', path: 'a.ts', ref: 'o2', line: 5, endLine: 6, position: 'diff', added: 2, removed: 1 },
    { kind: 'edit', tool: 'apply_patch', path: 'b.ts', ref: 'o2', added: 4, removed: 0 }
  ])
  const failed = p({ type: 'tool_use', part: { callID: 'o3', tool: 'edit', state: { status: 'error', input: { filePath: 'a.ts' }, metadata: { filediff: { file: 'a.ts', additions: 9 } } } } })
  assert.equal(activities(failed)[0].added, undefined)
  assert.equal(activities(p({ type: 'reasoning', part: { id: 'rp', text: 'Raciocinio exposto.' } }))[0].summary, 'Raciocinio exposto.')
})

test('limites: previa rotulada conserva raciocinio completo, patch grande nao publica contagem parcial', () => {
  const events = AGENTS.claude.parse({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x'.repeat(MAX_ACTIVITY_TEXT + 1) }, { type: 'redacted_thinking', data: 'secret' }] } })
  assert.equal(activities(events).length, 1)
  assert.equal(activities(events)[0].summary!.length, MAX_ACTIVITY_TEXT)
  assert.equal(activities(events)[0].truncated, true)
  assert.equal(activities(events)[0].fullText, 'x'.repeat(MAX_ACTIVITY_TEXT + 1))
  assert.deepEqual(patchActivity('a.ts', '@@ -1 +1 @@\n+' + 'x'.repeat(1_000_001)), { kind: 'edit', path: 'a.ts' })
  assert.deepEqual(patchActivity('a.ts', [{ newStart: 1, lines: ['+++literal', '---literal'] }]), { kind: 'edit', path: 'a.ts', line: 1, endLine: 2, position: 'diff', added: 1, removed: 1 })
})

test('streamed Claude: pensamento e mensagens continuam completos depois do limite da previa', () => {
  const stream = activityStream()
  const wrap = (event: any) => ({ type: 'stream_event', parent_tool_use_id: 'native-long', event })
  const long = 'x'.repeat(MAX_ACTIVITY_TEXT + 3)
  stream.observe(wrap({ type: 'message_start', message: { id: 'long1' } }))
  stream.observe(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
  const first = stream.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: long } }))[0]
  assert.equal(first.summary!.length, MAX_ACTIVITY_TEXT)
  assert.equal(first.fullText, long)
  assert.equal(first.truncated, true)
  const next = stream.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fim' } }))[0]
  assert.equal(next.fullText, long + 'fim')
  assert.equal(next.ref, first.ref)
  stream.observe(wrap({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: long } }))
  const message = stream.observe(wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'resposta' } }))[0]
  assert.equal(message.kind, 'message')
  assert.equal(message.fullText, long + 'resposta')
  const prompt = activities(AGENTS.codex.parse({ type: 'item.started', item: { id: 'long-prompt', type: 'collab_tool_call', tool: 'send_input', receiver_thread_ids: ['native-long'], prompt: long } }))[0]
  assert.equal(prompt.fullText, long)
})

test('streamed Claude: blocos locais por execucao, texto cumulativo, assinaturas cifradas ignoradas', () => {
  const a = activityStream(), b = activityStream()
  const wrap = (event: any) => ({ type: 'stream_event', event })
  a.observe(wrap({ type: 'message_start', message: { id: 'msg1' } }))
  a.observe(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
  assert.equal(a.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'A' } }))[0].summary, 'A')
  assert.equal(a.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'B' } }))[0].summary, 'AB')
  assert.deepEqual(a.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } })), [])
  assert.deepEqual(b.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'outro' } })), [])
  assert.ok(a.seen('msg1:0')); assert.ok(!b.seen('msg1:0'))
  a.observe(wrap({ type: 'message_stop' }))
  assert.deepEqual(a.observe(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'terminado' } })), [])
})

test('runner: public thinking e transcript nativo nunca entram em resposta, memoria ou contagem de ferramentas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-observe-'))
  try {
    const events = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Pensamento exposto' } } },
      { type: 'assistant', message: { id: 'msg1', content: [{ type: 'thinking', thinking: 'Pensamento exposto' }, { type: 'text', text: 'Resposta principal' }, { type: 'tool_use', id: 'mainread', name: 'Read', input: { file_path: 'a.ts' } }] } },
      { type: 'assistant', session_id: 'child-session', parent_tool_use_id: 'native1', message: { id: 'childmsg', content: [{ type: 'text', text: 'Mensagem do subagente' }, { type: 'thinking', thinking: 'Pensamento do subagente' }, { type: 'tool_use', id: 'childread', name: 'Read', input: { file_path: 'b.ts' } }] } },
      { type: 'user', uuid: 'notice1', origin: { kind: 'coordinator' }, message: { content: 'Mensagem de coordenacao' } },
      { type: 'result', result: 'Conclusao principal' }
    ]
    const script = path.join(dir, 'fake.cjs')
    fs.writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e))})`)
    const live: Activity[] = [], tools: string[] = []
    const r = await runChat({ cmd: process.execPath, args: [script], cwd: dir, input: 'x', parse: AGENTS.claude.parse, onActivity: a => live.push(a), onTool: name => tools.push(name), maxTools: 1 }).result
    assert.equal(r.status, 'completed')
    assert.equal(r.answer, 'Conclusao principal')
    assert.deepEqual(r.messages, ['Resposta principal'])
    assert.deepEqual(r.tools, ['Read']); assert.deepEqual(tools, ['Read'])
    assert.equal(r.session, undefined)
    assert.doesNotMatch(r.text, /Pensamento|subagente/)
    assert.equal(live.filter(a => a.summary === 'Pensamento exposto').length, 1)
    assert.equal(live.find(a => a.summary === 'Mensagem do subagente')?.agent, 'native1')
    assert.equal(live.find(a => a.path === 'b.ts')?.agent, 'native1')
    assert.equal(live.find(a => a.summary === 'Mensagem de coordenacao')?.direction, 'received')
    assert.deepEqual(live.find(a => a.kind === 'tool' && a.ref === 'mainread'), { kind: 'tool', tool: 'Read', summary: 'a.ts', ref: 'mainread' })
    assert.ok(AGENTS.claude.chatArgs().includes('--include-partial-messages'))
    assert.ok(AGENTS.claude.chatArgs().includes('--forward-subagent-text'))
    assert.ok(AGENTS.opencode.chatArgs().includes('--thinking'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
