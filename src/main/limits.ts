// Limites iniciais de contexto e retorno (ajustaveis em Configuracoes). Sao valores de partida, nao promessa de economia:
// limites em caracteres nao sao quota real nem contagem de tokens. Sem dependencia de 'electron'.
export type ContextLimits = {
  packageChars: number // pacote automatico candidato
  packageItems: number
  itemChars: number // por item; item maior fica referenciado para selecao separada
  conclusionChars: number // alvo da conclusao devolvida ao pai (metadados obrigatorios nunca entram nessa conta)
  queryChars: number // consulta de artefato/contexto por pagina
  queryResults: number
  approvalTimeoutMin: number // espera humana pela aprovacao (nao conta no timeout de execucao do filho)
  checklistTokens: number // alvo estimado do resumo de instrucoes permanentes do runtime
  maxToolsPerMessage: number // teto de ferramentas numa mensagem; 0 = sem teto. Alto de proposito: so pega execucao autonoma longa (medido: 356 ferramentas em 51 min)
  enabled: boolean // desligado (padrao): valem os tetos de normalizeLimits e nenhuma pausa; os numeros guardados ficam para quando religar
}
export const DEFAULT_LIMITS: ContextLimits = { packageChars: 6000, packageItems: 8, itemChars: 2000, conclusionChars: 3000, queryChars: 6000, queryResults: 10, approvalTimeoutMin: 10, checklistTokens: 500, maxToolsPerMessage: 200, enabled: false }

const clamp = (v: unknown, min: number, max: number, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d)
export function normalizeLimits(raw: any): ContextLimits {
  const d = DEFAULT_LIMITS
  return {
    packageChars: clamp(raw?.packageChars, 500, 100_000, d.packageChars), packageItems: clamp(raw?.packageItems, 1, 50, d.packageItems),
    itemChars: clamp(raw?.itemChars, 200, 20_000, d.itemChars), conclusionChars: clamp(raw?.conclusionChars, 500, 50_000, d.conclusionChars),
    queryChars: clamp(raw?.queryChars, 500, 50_000, d.queryChars), queryResults: clamp(raw?.queryResults, 1, 50, d.queryResults),
    approvalTimeoutMin: clamp(raw?.approvalTimeoutMin, 1, 120, d.approvalTimeoutMin), checklistTokens: clamp(raw?.checklistTokens, 100, 5000, d.checklistTokens),
    maxToolsPerMessage: clamp(raw?.maxToolsPerMessage, 0, 5000, d.maxToolsPerMessage), enabled: raw?.enabled === true
  }
}

// Limites que os servicos usam: desligado, cada tamanho vai ao teto de normalizeLimits (mude os dois juntos) e nao ha pausa por ferramentas.
// O tempo de aprovacao e o resumo de instrucoes nao sao gasto: seguem como estao.
export const effectiveLimits = (l: ContextLimits): ContextLimits => l.enabled ? l
  : { ...l, packageChars: 100_000, packageItems: 50, itemChars: 20_000, conclusionChars: 50_000, queryChars: 50_000, queryResults: 50, maxToolsPerMessage: 0 }

// Estimativa rotulada como tal: ~4 caracteres por token. Nao e contagem do tokenizer de nenhum provedor.
export const estimateTokens = (chars: number) => Math.ceil(chars / 4)
