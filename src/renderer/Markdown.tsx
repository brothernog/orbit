import { useMemo } from 'react'
import { renderMarkdown } from './renderMarkdown'
import { splitTools, toolSummary } from './toolRuns'

// Grupos abertos sobrevivem a re-render/remontagem (fim do streaming, pedido de permissao): chave = inicio da mensagem + posicao.
const opened = new Set<string>()

export function Markdown({ text }: { text: string }) {
  const segs = useMemo(() => splitTools(text).map(s => ('md' in s ? { html: renderMarkdown(s.md) } : s)), [text])
  return (
    <div className="md">
      {segs.map((s, i) => 'html' in s
        ? <div key={i} dangerouslySetInnerHTML={{ __html: s.html }} />
        : <details key={i} className="tool-run" open={opened.has(`${text.slice(0, 80)}|${i}`)} onToggle={e => { const k = `${text.slice(0, 80)}|${i}`; if (e.currentTarget.open) opened.add(k); else opened.delete(k) }}>
            <summary>Executou {s.tools.length} {s.tools.length === 1 ? 'ação' : 'ações'} <small>{toolSummary(s.tools)}</small></summary>
            <ul>{s.tools.map((t, j) => <li key={j}><code>{t}</code></li>)}</ul>
          </details>)}
    </div>
  )
}
