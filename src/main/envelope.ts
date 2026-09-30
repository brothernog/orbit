// Envelope curto e recuperavel devolvido ao pai. O alvo de tamanho vale so para a CONCLUSAO: estado, falha, violacoes,
// arquivos e a referencia ao artefato completo nunca sao descartados. Um corte e um extrato, nao um resumo semantico.
// Sem dependencia de 'electron'.
const PT: Record<string, string> = { completed: 'concluida', failed: 'falhou', cancelled: 'cancelada' }

// Corta em limite de paragrafo/linha quando possivel (nunca no meio de uma palavra se houver quebra proxima).
export function excerpt(text: string, max: number) {
  const t = text.trim()
  if (t.length <= max) return { text: t, truncated: false, shown: t.length, total: t.length }
  let cut = t.lastIndexOf('\n\n', max)
  if (cut < max * 0.6) cut = t.lastIndexOf('\n', max)
  if (cut < max * 0.6) cut = max
  return { text: t.slice(0, cut).trimEnd(), truncated: true, shown: cut, total: t.length }
}

// ---- Conclusao final DELIMITADA. O filho e instruido a terminar com um bloco [CONCLUSAO]...[/CONCLUSAO] (resultado, testes/evidencias, arquivos,
// bloqueios; sem raciocinio privado). O evento final nativo da CLI (quando existe) e a fonte preferida do texto; DENTRO dele (ou do ultimo texto
// do agente) um bloco unico e bem formado e reconhecido por regra local. Ausente, duplicado ou sem fechamento = ambiguo: nada e adivinhado e o
// envelope volta ao extrato rotulado (o texto completo continua no artefato). O bloco e uma DECLARACAO do agente: nunca substitui estado, erro,
// violacoes nem arquivos que o dashboard observou.
export const CONCLUSION_OPEN = '[CONCLUSAO]', CONCLUSION_CLOSE = '[/CONCLUSAO]'
export const CONCLUSION_FIELDS = [['Resultado', /^resultado\s*:/i], ['Testes/evidencias', /^(testes?(\/evid[eê]ncias?)?|evid[eê]ncias?)\s*:/i], ['Arquivos', /^arquivos?\s*:/i], ['Bloqueios', /^bloqueios?\s*:/i]] as const
export type Conclusion = { kind: 'block' | 'none' | 'ambiguous'; text: string; missing: string[]; testsNotRun: boolean }
const NOT_RUN = /\b(nao|não)\s+(foram?\s+|foi\s+|consegui\s+|pude\s+)?(executad|rodad|realizad|roda|execut|testad|rod)|\bsem\s+(execu[cç][aã]o\s+de\s+)?testes?\b|\bnenhum\s+teste\s+(foi\s+)?(executad|rodad)/i

export function extractConclusion(answer: string): Conclusion {
  const none: Conclusion = { kind: 'none', text: '', missing: [], testsNotRun: false }
  const lines = answer.split(/\r?\n/)
  const opens = lines.flatMap((l, i) => (l.trim() === CONCLUSION_OPEN ? [i] : []))
  const closes = lines.flatMap((l, i) => (l.trim() === CONCLUSION_CLOSE ? [i] : []))
  if (!opens.length && !closes.length) return none
  if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) return { ...none, kind: 'ambiguous' } // marcador duplicado, sem fechamento ou fora de ordem
  const body = lines.slice(opens[0] + 1, closes[0]).join('\n').trim()
  if (!body) return { ...none, kind: 'ambiguous' }
  const fields = body.split('\n').map(l => l.trim())
  const missing = CONCLUSION_FIELDS.filter(([, re]) => !fields.some(l => re.test(l))).map(([n]) => n)
  const tests = fields.filter(l => CONCLUSION_FIELDS[1][1].test(l)).join(' ')
  return { kind: 'block', text: body, missing, testsNotRun: NOT_RUN.test(tests) }
}

export type EnvelopeIn = {
  id: number; status: 'completed' | 'failed' | 'cancelled'
  answer: string; answerBasis?: 'explicit' | 'limited'
  error?: string; category?: string
  changed: string[] | null // null = nao foi possivel acompanhar
  outOfScope: string[]; violation: boolean
  artifactId?: number; totalChars: number; toolCount: number
  conclusionChars: number
  sessionNote?: string // ex.: "continuacao da delegacao #2"
  conclusion?: Conclusion // ja extraida (evita reprocessar); senao e extraida de `answer`
}

export function buildEnvelope(i: EnvelopeIn): string {
  const lines = [`[Delegacao #${i.id} ${PT[i.status]}${i.sessionNote ? ` · ${i.sessionNote}` : ''}]`]
  const files = i.changed === null ? 'nao foi possivel acompanhar (pasta muito grande)' : i.changed.length ? `${i.changed.length}: ${i.changed.slice(0, 50).join(', ')}${i.changed.length > 50 ? ', …' : ''}` : 'nenhum'
  lines.push(`Arquivos alterados: ${files}`)
  const c = i.conclusion ?? extractConclusion(i.answer)
  // Alertas e erro vem do que o DASHBOARD observou e do estado real: um bloco final que afirma sucesso nao os apaga.
  const alerts = [
    i.outOfScope.length ? `FORA DO ESCOPO: ${i.outOfScope.slice(0, 20).join(', ')}${i.outOfScope.length > 20 ? ', …' : ''}` : '', i.violation ? 'ATENCAO: o modo leitura alterou arquivos' : '',
    c.kind === 'block' && c.testsNotRun ? 'TESTES NAO EXECUTADOS (segundo o proprio agente)' : '',
    c.kind === 'block' && c.missing.length ? `CONCLUSAO INCOMPLETA: falta ${c.missing.join(', ')}` : ''
  ].filter(Boolean)
  if (alerts.length) lines.push(`ALERTAS: ${alerts.join(' · ')}`)
  if (i.error) lines.push(`Erro${i.category ? ` (${i.category})` : ''}: ${i.error}`)
  if (i.answer.trim()) {
    const label = i.status === 'completed' ? 'Conclusao' : 'Resultado parcial'
    if (c.kind === 'block') { // bloco final delimitado: e o que o agente declarou como entrega (o dashboard nao verificou o conteudo)
      const x = excerpt(c.text, i.conclusionChars)
      lines.push(x.truncated
        ? `${label} (bloco final do agente, EXTRATO: ${x.shown} de ${x.total} caracteres; o texto completo esta no artefato):\n${x.text}`
        : `${label} (bloco final delimitado pelo agente; declaracao dele, nao verificada pelo dashboard):\n${x.text}`)
      if (i.status !== 'completed') lines.push('NOTA: o estado acima e o real da execucao; o bloco final do agente nao o substitui.')
    } else {
      const x = excerpt(i.answer, i.conclusionChars)
      lines.push(x.truncated
        ? `${label} (EXTRATO: ${x.shown} de ${x.total} caracteres, o comeco do texto do agente; nao e um resumo):\n${x.text}`
        : `${label} (completa):\n${x.text}`)
      const why = c.kind === 'ambiguous' ? 'Bloco final do agente ausente do formato esperado ou ambiguo (marcador duplicado/sem fechamento): nenhum foi adivinhado; o texto completo esta no artefato.'
        : i.answerBasis === 'limited' ? 'Base da conclusao: a CLI nao marca a resposta final e o agente nao usou o bloco final delimitado; foi usado o texto do agente (extracao limitada).' : ''
      if (why) lines.push(why)
    }
    if (c.kind === 'block' && i.answerBasis === 'limited') lines.push('Base: a CLI nao marca a resposta final; o bloco foi reconhecido no ultimo texto do agente.')
  } else lines.push('Sem texto de resposta do agente.')
  if (i.artifactId) lines.push(`Detalhes completos: artefato #${i.artifactId} (${i.totalChars} caracteres, ${i.toolCount} ferramenta(s) executada(s)). Use read_task_context com {"artifactId": ${i.artifactId}} e "offset" para paginar.`)
  return lines.join('\n')
}
