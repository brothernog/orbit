// Conclusao final delimitada: reconhecida por regra local, sem adivinhar; nunca oculta estado, erro, violacao nem teste nao executado.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEnvelope, extractConclusion } from './envelope.ts'

const BLOCK = '[CONCLUSAO]\nResultado: bug do pulo corrigido em src/player/jump.ts\nTestes/evidencias: npm test (12 passaram, 0 falharam)\nArquivos: src/player/jump.ts\nBloqueios: nenhum\n[/CONCLUSAO]'
const narrative = (n = 400) => Array.from({ length: n }, (_, i) => `Passo ${i}: li o arquivo e comparei com o caso ${i}, sem achar nada relevante ainda.`).join('\n\n')
const env = (over: any) => buildEnvelope({ id: 7, status: 'completed', answer: '', changed: [], outOfScope: [], violation: false, artifactId: 9, totalChars: 1, toolCount: 3, conclusionChars: 3000, ...over })

test('bloco final ao fim de uma narrativa longa: o envelope traz so o bloco, nao o comeco da narrativa', () => {
  const answer = `${narrative()}\n\n${BLOCK}`
  const c = extractConclusion(answer)
  assert.deepEqual([c.kind, c.missing, c.testsNotRun], ['block', [], false]); assert.match(c.text, /^Resultado: bug do pulo/)
  const text = env({ answer, answerBasis: 'limited', totalChars: answer.length })
  assert.ok(text.length < 1200 && answer.length > 20_000, `envelope de ${text.length} caracteres`)
  assert.match(text, /bloco final delimitado pelo agente; declaracao dele, nao verificada pelo dashboard\):\nResultado: bug do pulo/)
  assert.ok(!/Passo 0:/.test(text)); assert.match(text, /Detalhes completos: artefato #9/) // o texto completo continua recuperavel
  assert.match(text, /o bloco foi reconhecido no ultimo texto do agente/)
  // com evento final nativo (explicit) nao ha nota de extracao limitada
  assert.ok(!/extracao limitada|ultimo texto do agente/.test(env({ answer: BLOCK, answerBasis: 'explicit' })))
})

test('ausente, duplicado, sem fechamento ou vazio: nada e adivinhado e o extrato rotulado permanece', () => {
  for (const [name, answer] of [['ausente', narrative(5)], ['duplicado', `${BLOCK}\n${BLOCK}`], ['sem fechamento', '[CONCLUSAO]\nResultado: x'], ['fora de ordem', '[/CONCLUSAO]\nResultado: x\n[CONCLUSAO]'], ['vazio', '[CONCLUSAO]\n\n[/CONCLUSAO]']] as const) {
    const c = extractConclusion(answer)
    assert.equal(c.text, '', name); assert.equal(c.kind, name === 'ausente' ? 'none' : 'ambiguous', name)
    const text = env({ answer, answerBasis: 'limited' })
    assert.ok(!/bloco final delimitado pelo agente/.test(text), name); assert.match(text, /Conclusao \((completa|EXTRATO)/, name)
    if (name !== 'ausente') assert.match(text, /ausente do formato esperado ou ambiguo[\s\S]*nenhum foi adivinhado/, name)
  }
  assert.match(env({ answer: narrative(400), answerBasis: 'limited' }), /EXTRATO: \d+ de \d+ caracteres, o comeco do texto do agente; nao e um resumo/)
  assert.equal(extractConclusion('use o marcador [CONCLUSAO] no fim, e [/CONCLUSAO] tambem').kind, 'none') // menciona no meio de uma frase: nao e um bloco
})

test('o bloco nunca oculta falha, erro, violacao, fora de escopo nem teste nao executado', () => {
  // texto de sucesso, mas a execucao FALHOU: o estado real e o erro aparecem e o bloco recebe a nota
  const failed = env({ status: 'failed', answer: `feito!\n${BLOCK}`, error: 'CLI terminou com codigo 1', category: 'protocol' })
  assert.match(failed, /\[Delegacao #7 falhou\]/); assert.match(failed, /Erro \(protocol\): CLI terminou com codigo 1/)
  assert.match(failed, /Resultado parcial \(bloco final delimitado pelo agente/); assert.match(failed, /NOTA: o estado acima e o real da execucao/)
  // violacoes observadas pelo dashboard vencem o que o bloco afirma
  const viol = env({ answer: BLOCK, violation: true, outOfScope: ['fora.txt'], changed: ['src/x.ts', 'fora.txt'] })
  assert.match(viol, /ALERTAS: FORA DO ESCOPO: fora\.txt · ATENCAO: o modo leitura alterou arquivos/); assert.match(viol, /Arquivos alterados: 2: src\/x\.ts, fora\.txt/)
  // teste nao executado (segundo o proprio agente) e bloco incompleto viram alerta
  for (const tests of ['nao executei os testes por falta de ambiente', 'testes nao foram rodados', 'sem testes', 'Nenhum teste foi executado']) {
    const b = `[CONCLUSAO]\nResultado: ok\nTestes/evidencias: ${tests}\nArquivos: a.ts\nBloqueios: nenhum\n[/CONCLUSAO]`
    assert.equal(extractConclusion(b).testsNotRun, true, tests); assert.match(env({ answer: b }), /TESTES NAO EXECUTADOS \(segundo o proprio agente\)/, tests)
  }
  assert.equal(extractConclusion(BLOCK).testsNotRun, false) // "0 falharam" nao e "nao executado"
  const partial = env({ answer: '[CONCLUSAO]\nResultado: pronto\n[/CONCLUSAO]' })
  assert.match(partial, /CONCLUSAO INCOMPLETA: falta Testes\/evidencias, Arquivos, Bloqueios/)
  assert.match(env({ answer: '', status: 'cancelled' }), /Sem texto de resposta do agente/)
})

test('bloco maior que o alvo vira extrato do bloco, rotulado, com o resto no artefato', () => {
  const big = `[CONCLUSAO]\nResultado: ${'detalhe '.repeat(800)}\nTestes/evidencias: ok\nArquivos: a\nBloqueios: nenhum\n[/CONCLUSAO]`
  const text = env({ answer: big, conclusionChars: 500 })
  assert.match(text, /bloco final do agente, EXTRATO: \d+ de \d+ caracteres; o texto completo esta no artefato/); assert.ok(text.length < 1100)
})
