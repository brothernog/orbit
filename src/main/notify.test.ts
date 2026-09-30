import test from 'node:test'
import assert from 'node:assert/strict'
import { activityOf, isTestCommand, agentSummary, DEFAULT_NOTIFY, duration, normalizeNotify, noticeFor, runChanges, snippet, type NoticeInfo } from './notify.ts'

const info: NoticeInfo = { task: { title: 'Corrigir pulo duplo', game: 'C:/g/jogo', project: 'Jogo' } }
const done = (o: object) => ({ taskId: 7, done: true, runId: 3, provider: 'claude', model: 'opus', durationMs: 192_000, ...o })

test('terminou: resumo do agente, arquivos desta execucao, comandos e testes que rodaram', () => {
  const changes = [{ path: 'player.gd', added: 30, removed: 5, isNew: false }, { path: 'test_jump.gd', added: 12, removed: 0, isNew: true }]
  const n = noticeFor(done({ status: 'completed', answer: '## Feito\n\nAjustei o **coyote time** em [player.gd](x).\n\nDetalhes longos...', acts: ['Read a', 'Bash npm test', 'Bash git status', 'Edit player.gd'] }),
    { ...info, changes }, DEFAULT_NOTIFY)!
  assert.equal(n.kind, 'done')
  assert.equal(n.summary, 'Ajustei o coyote time em player.gd.')
  assert.equal(n.summaryFrom, 'agent')
  assert.equal(n.duration, '3 min')
  assert.deepEqual(n.filesTotal, { count: 2, added: 42, removed: 5 })
  assert.deepEqual(n.activity, { tools: 4, commands: 2, tests: 1, passed: 0, failed: 0, lastOk: null, summary: null }) // a CLI nao informou o resultado
  // sem Git: nao inventa zero, fica "nao medido"
  const semGit = noticeFor(done({ status: 'completed', answer: 'ok' }), { ...info, changes: null }, DEFAULT_NOTIFY)!
  assert.equal(semGit.files, null); assert.equal(semGit.filesTotal, null)
})

test('resumo: campo Resultado do bloco de conclusao vence o primeiro paragrafo; resposta vazia e rotulada como do app', () => {
  assert.equal(agentSummary('Oi.\n\n[CONCLUSAO]\nResultado: pulo corrigido\nTestes: 3 passaram\nArquivos: a\nBloqueios: nenhum\n[/CONCLUSAO]'), 'pulo corrigido')
  const n = noticeFor(done({ status: 'completed', answer: '' }), info, DEFAULT_NOTIFY)!
  assert.equal(n.summaryFrom, 'app')
})

test('runChanges: so o que mudou nesta execucao, descontando o que ja estava sujo', () => {
  const before = [{ path: 'a.gd', status: 'M', added: 10, removed: 2 }, { path: 'b.gd', status: 'M', added: 1, removed: 0 }]
  const after = [{ path: 'a.gd', status: 'M', added: 15, removed: 2 }, { path: 'b.gd', status: 'M', added: 1, removed: 0 }, { path: 'c.gd', status: '?', added: 40, removed: 0 }]
  assert.deepEqual(runChanges(before, after), [{ path: 'c.gd', added: 40, removed: 0, isNew: true }, { path: 'a.gd', added: 5, removed: 0, isNew: false }])
})

test('codex informa o proprio comando como ferramenta', () => {
  assert.deepEqual(activityOf(['cargo test', 'ls'], 'codex'), { tools: 2, commands: 2, tests: 1, passed: 0, failed: 0, lastOk: null, summary: null })
  assert.equal(activityOf(undefined, 'claude'), null)
})

test('etapa vira revisao; falha, pausa e cancelamento', () => {
  const r = noticeFor(done({ status: 'completed', answer: 'ok' }), { ...info, step: 'Implementar' }, DEFAULT_NOTIFY)!
  assert.deepEqual([r.kind, r.step], ['review', 'Implementar'])
  const f = noticeFor(done({ status: 'failed', error: 'limite atingido' }), info, DEFAULT_NOTIFY)!
  assert.deepEqual([f.kind, f.summary, f.summaryFrom], ['failed', 'limite atingido', 'app'])
  assert.equal(noticeFor(done({ status: 'cancelled', paused: true }), info, DEFAULT_NOTIFY)!.kind, 'paused')
  assert.equal(noticeFor(done({ status: 'cancelled' }), info, DEFAULT_NOTIFY), null) // voce mesmo cancelou
  assert.equal(noticeFor(done({ status: 'completed' }), { task: null }, DEFAULT_NOTIFY), null) // tarefa apagada
})

test('preferencias desligam cada tipo; valores invalidos voltam ao padrao', () => {
  const off = normalizeNotify({ done: false, failed: false, approval: false, system: 'x' })
  assert.equal(off.system, true)
  assert.equal(noticeFor(done({ status: 'completed' }), info, off), null)
  assert.equal(noticeFor(done({ status: 'failed' }), info, off), null)
  assert.equal(noticeFor({ taskId: 7, permissionRequest: 2 }, { ...info, permission: { provider: 'codex', summary: 'rm x' } }, off), null)
})

test('pedidos de aprovacao levam a referencia para o cartao sumir quando resolvido', () => {
  const p = noticeFor({ taskId: 7, permissionRequest: 2 }, { ...info, permission: { provider: 'codex', summary: 'npm test' } }, DEFAULT_NOTIFY)!
  assert.deepEqual([p.kind, p.provider, p.summary, p.ref], ['permission', 'codex', 'npm test', { permission: 2 }])
  const c = noticeFor({ taskId: 7, contextRequest: 5 }, { ...info, context: { items: 1, recipient: 'Gemini' } }, DEFAULT_NOTIFY)!
  assert.deepEqual([c.kind, c.summary, c.ref], ['context', '1 item para Gemini. Nada foi enviado ainda.', { context: 5 }])
})

test('snippet corta na palavra e ignora blocos de codigo; duracao', () => {
  assert.equal(snippet('texto\n\n```js\nx()\n```'), 'texto')
  const s = snippet('palavra '.repeat(40), 50)
  assert.ok(s.length <= 50 && s.endsWith('palavra…')) // corta no espaco, nunca no meio da palavra
  assert.equal(duration(42_000), '42 s')
  assert.equal(duration(3_900_000), '1 h 05')
  assert.equal(duration(undefined), null)
})

test('testes do agente: vale o ultimo com resultado informado; falhas anteriores ficam contadas', () => {
  const a = activityOf([{ line: 'Bash npm test', ok: false, summary: '3 testes, 2 passaram, 1 falharam' }, { line: 'Edit a.ts' }, { line: 'Bash npm test', ok: true, summary: '3 testes, 3 passaram, 0 falharam' }], 'claude')!
  assert.deepEqual(a, { tools: 3, commands: 2, tests: 2, passed: 1, failed: 1, lastOk: true, summary: '3 testes, 3 passaram, 0 falharam' })
  assert.equal(activityOf([{ line: 'Bash godot --headless -s gut', ok: false }], 'claude')!.summary, 'Último teste falhou')
  assert.ok(isTestCommand('Bash npm run typecheck') && !isTestCommand('Bash git status'))
})

test('comando do projeto: teste/build com exit code e resumo da saida; jogo fechado sem erro e cancelado nao avisam', () => {
  const cmd = (o: object) => ({ taskId: 7, commandDone: { id: 1, name: 'Validar', purpose: 'test', status: 'completed', exitCode: 0, durationMs: 12_000, output: 'ℹ tests 5\nℹ pass 5\nℹ fail 0', ...o } })
  const ok = noticeFor(cmd({}), info, DEFAULT_NOTIFY)!
  assert.deepEqual([ok.kind, ok.heading, ok.summary, ok.duration, ok.command], ['cmd-ok', 'Teste passou', '5 testes, 5 passaram, 0 falharam', '12 s', { name: 'Validar', exitCode: 0 }])
  const bad = noticeFor(cmd({ purpose: 'build', status: 'failed', exitCode: 2, output: 'compilando\nERRO: falta a textura hero.png\n' }), info, DEFAULT_NOTIFY)!
  assert.deepEqual([bad.kind, bad.heading, bad.summary], ['cmd-fail', 'Build falhou', 'compilando · ERRO: falta a textura hero.png'])
  assert.equal(noticeFor(cmd({ purpose: 'run' }), info, DEFAULT_NOTIFY), null)
  assert.equal(noticeFor(cmd({ purpose: 'run', status: 'failed', exitCode: 1 }), info, DEFAULT_NOTIFY)!.heading, 'O jogo fechou com erro')
  assert.equal(noticeFor(cmd({ status: 'cancelled' }), info, DEFAULT_NOTIFY), null)
  assert.equal(noticeFor(cmd({}), info, normalizeNotify({ done: false })), null)
})
