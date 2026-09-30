// O runner grava cada ferramenta como uma linha `> Nome` no texto. Sequencias dessas linhas viram um bloco recolhivel.
export type Seg = { md: string } | { tools: string[] }

const TOOL = /^`> (.+)`$/

export function splitTools(text: string): Seg[] {
  const out: Seg[] = []
  let md: string[] = [], tools: string[] = []
  const flushMd = () => { if (md.join('').trim()) out.push({ md: md.join('\n') }); md = [] }
  for (const line of text.split('\n')) {
    const m = TOOL.exec(line.trim())
    if (m) { flushMd(); tools.push(m[1]); continue }
    if (!line.trim() && tools.length) continue // linha em branco entre ferramentas nao quebra o grupo
    if (tools.length) { out.push({ tools }); tools = [] }
    md.push(line)
  }
  if (tools.length) out.push({ tools })
  flushMd()
  return out
}

// "Edit ×14, Read": nomes na ordem em que apareceram, com contagem.
export function toolSummary(tools: string[]) {
  const n = new Map<string, number>()
  for (const t of tools) { const k = t.split(/\s/)[0].slice(0, 40); n.set(k, (n.get(k) ?? 0) + 1) }
  return [...n].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(', ')
}
