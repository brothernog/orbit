// Rotulos de modelo, esforco e conexao usados pelo chat, Inicio, LinkedIn e Configuracoes.
import { cap } from './Dropdown'

const EFFORT: Record<string, string> = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' }
export const effortLabel = (f: string) => EFFORT[f] ?? cap(f)
// Rotulo do modelo: o nome do catalogo quando existe; senao o id, sem o prefixo do provedor (ele vira o grupo).
// Id completo do Claude vira nome legivel ("claude-sonnet-5-5" = "Sonnet 5.5"); o resto so ganha maiuscula.
export const modelName = (id: string) => { const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id); return m ? `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : cap(id) }

export const CONN_STATE = { connected: 'conectado', disconnected: 'desconectado', unknown: 'não verificado', connecting: 'conectando…', error: 'erro' }
