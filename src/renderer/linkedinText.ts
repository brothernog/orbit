// Texto da pagina LinkedIn (sem React, testavel com node --test).

// Comandos rapidos: "/post sobre X" vira o pedido completo com o complemento.
export const CMDS: [string, string, string][] = [
  ['/briefing', 'Briefing da semana', 'Faça o briefing da semana.'],
  ['/post', 'Novos rascunhos', 'Escreva 2 rascunhos de post novos.'],
  ['/humanizar', 'Deixar mais humano', 'Reescreva o rascunho mais recente seguindo a seção de escrita que soa como gente, sem mudar os fatos.'],
  ['/perfil', 'Revisar perfil', 'Revise meu perfil do LinkedIn: título, sobre e destaques.'],
  ['/conexoes', 'Sugerir conexões', 'Sugira 5 conexões com a nota de convite de cada uma.'],
  ['/video', 'Vídeo de divulgação', 'Vamos montar um vídeo de divulgação: proponha o roteiro e como gravar.'],
]
export const expand = (t: string) => {
  const m = t.match(/^(\/\w+)\s*(.*)$/s)
  const c = m && CMDS.find(x => x[0] === m[1].toLowerCase())
  return c ? (m![2] ? `${c[2].replace(/\.$/, '')} ${m![2]}` : c[2]) : t
}

// O LinkedIn corta o post no feed depois de ~3 linhas (~210 caracteres) e mostra "ver mais". Aproximado: depende da largura.
const FOLD = 210
export const fold = (t: string) => {
  const lines = t.trim().split('\n')
  let cut = lines.slice(0, 3).join('\n')
  if (cut.length > FOLD) cut = cut.slice(0, FOLD).replace(/\s+\S*$/, '')
  return cut.length < t.trim().length ? cut : null
}
