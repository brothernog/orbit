import { Avatar, Icon, PROVIDER } from './icons'
import './toasts.css'

// Mesmo formato de src/main/notify.ts (Notice). O processo principal monta o resumo; aqui so mostra.
export type Kind = 'done' | 'review' | 'failed' | 'paused' | 'permission' | 'question' | 'context' | 'cmd-ok' | 'cmd-fail'
export type Activity = { tools: number; commands: number; tests: number; passed: number; failed: number; lastOk: boolean | null; summary: string | null }
export type FileDelta = { path: string; added: number | null; removed: number | null; isNew: boolean }
export type Notice = {
  key: number; kind: Kind; taskId: number; game: string; heading: string; title: string; project: string
  provider: string | null; model: string | null; duration: string | null; summary: string; summaryFrom: 'agent' | 'app'; step: string | null
  files: FileDelta[] | null; filesTotal: { count: number; added: number; removed: number } | null
  activity: Activity | null; command: { name: string; exitCode: number | null } | null; ref?: { permission?: number; question?: number; context?: number }
}

const BADGE: Record<Kind, string> = { done: 'check', review: 'target', failed: 'alert', paused: 'stop', permission: 'alert', question: 'spark', context: 'layers', 'cmd-ok': 'check', 'cmd-fail': 'alert' }
const ACTION: Record<Kind, string> = { done: 'Abrir tarefa', review: 'Revisar etapa', failed: 'Ver o erro', paused: 'Abrir tarefa', permission: 'Responder', question: 'Responder', context: 'Ver pedido', 'cmd-ok': 'Ver saída', 'cmd-fail': 'Ver saída' }
const ALERT = new Set<Kind>(['failed', 'cmd-fail'])
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// Barra de 5 blocos no estilo do GitHub: proporcao de linhas adicionadas/removidas.
function DiffBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed
  const a = total ? Math.round((added / total) * 5) : 0, r = total ? Math.min(5 - a, Math.max(removed ? 1 : 0, Math.round((removed / total) * 5))) : 0
  return <span className="nc-bar" aria-hidden="true">{[...Array(5)].map((_, i) => <i key={i} className={i < a ? 'a' : i < a + r ? 'r' : ''} />)}</span>
}

// Resultado dos testes que o agente rodou: so com o que a CLI informou (erro da ferramenta ou exit code); sem isso, "sem resultado".
function TestResult({ a }: { a: Activity }) {
  if (!a.tests) return null
  const tip = 'Resultado informado pela CLI do agente (erro da ferramenta ou exit code). O resumo vem da saída do teste, quando o formato é conhecido.'
  if (a.lastOk === null) return <p className="nc-tests" title="A CLI não informou o resultado destes comandos."><Icon n="terminal" size={13} />{plural(a.tests, 'teste rodou', 'testes rodaram')} · sem resultado informado</p>
  return (
    <p className={`nc-tests ${a.lastOk ? 'ok' : 'bad'}`} title={tip}>
      <Icon n={a.lastOk ? 'check' : 'alert'} size={13} /><b>{a.summary}</b>
      {a.failed > 0 && a.lastOk && <span className="nc-retry">{plural(a.failed, 'falha antes', 'falhas antes')}</span>}
    </p>
  )
}

// Cartao de aviso. `life` (s) so vale para "terminou": some sozinho, com a barra de tempo pausando no hover/foco ou quando `hold`.
export function NoticeCard({ n, life, hold, onOpen, onDismiss }: {
  n: Notice; life?: number; hold?: boolean; onOpen: (files: boolean) => void; onDismiss: () => void
}) {
  const t = n.filesTotal, act = n.activity
  const run = n.kind === 'done' || n.kind === 'review' || n.kind === 'failed' || n.kind === 'paused'
  const auto = (n.kind === 'done' || n.kind === 'cmd-ok') && life
  return (
    <article className={`nc k-${n.kind} ${hold ? 'hold' : ''}`} role={ALERT.has(n.kind) ? 'alert' : 'status'} aria-labelledby={`nct${n.key}`}>
      <header className="nc-head">
        <span className="nc-who">
          {n.provider ? <Avatar provider={n.provider} /> : <span className="avatar nc-app"><Icon n={n.command ? 'terminal' : 'layers'} size={15} /></span>}
          <span className="nc-badge"><Icon n={BADGE[n.kind]} size={11} /></span>
        </span>
        <span className="nc-line">
          <span className="nc-kind">{n.heading}{n.duration && <span className="nc-time"> · {n.duration}</span>}</span>
          <button className="nc-title" id={`nct${n.key}`} title="Abrir tarefa" onClick={() => onOpen(false)}>{n.title}</button>
          <span className="nc-meta">{[n.project, n.provider && `${PROVIDER[n.provider]?.label ?? n.provider}${n.model ? ` ${n.model}` : ''}`].filter(Boolean).join(' · ')}</span>
        </span>
        <button className="icon sm nc-x" aria-label="Fechar aviso" onClick={onDismiss}><Icon n="close" size={14} /></button>
      </header>

      {n.step && <p className="nc-step"><Icon n="target" size={13} />Etapa: <b>{n.step}</b></p>}
      {n.command && <p className="nc-step"><Icon n="terminal" size={13} />Comando <b>{n.command.name}</b>{n.command.exitCode !== null && <span className="nc-exit">exit {n.command.exitCode}</span>}</p>}
      <blockquote className={`nc-sum ${n.summaryFrom}`}>
        {n.summaryFrom === 'agent' && <span className="nc-label">O agente diz</span>}
        <p>{n.summary}</p>
      </blockquote>

      {run && (
        <div className="nc-facts">
          <div className="nc-stats">
            {t && t.count > 0 && <span className="nc-stat" title="Medido pela Órbita no Git: só o que mudou nesta execução">
              <Icon n="files" size={13} />{plural(t.count, 'arquivo', 'arquivos')}
              <span className="plus">+{t.added}</span><span className="minus">−{t.removed}</span><DiffBar added={t.added} removed={t.removed} />
            </span>}
            {t && t.count === 0 && <span className="nc-stat quiet"><Icon n="files" size={13} />Nenhum arquivo alterado</span>}
            {!t && n.files === null && n.kind !== 'paused' && <span className="nc-stat quiet" title="Sem Git na pasta: a Órbita não mede as alterações">Alterações não medidas</span>}
            {act && act.commands > 0 && <span className="nc-stat" title="Comandos que o agente rodou"><Icon n="terminal" size={13} />{plural(act.commands, 'comando', 'comandos')}</span>}
          </div>
          {act && <TestResult a={act} />}
        </div>
      )}

      <footer className="nc-actions">
        <button className="primary" onClick={() => onOpen(false)}>{ACTION[n.kind]}</button>
        {!!n.files?.length && <button onClick={() => onOpen(true)}>Ver alterações</button>}
      </footer>
      {auto && <i className="nc-life" aria-hidden="true" style={{ animationDuration: `${life}s` }} onAnimationEnd={onDismiss} />}
    </article>
  )
}

// Som curto gerado na hora (sem arquivo de audio): dois tons subindo para "terminou", descendo para falha/pedido.
export function chime(kind: Kind) {
  try {
    const ctx = new AudioContext(), up = kind === 'done' || kind === 'review' || kind === 'cmd-ok'
    const notes = up ? [659.25, 987.77] : [587.33, 440]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + i * 0.11
      o.type = 'sine'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.07, at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32)
      o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.34)
    })
    setTimeout(() => ctx.close(), 800)
  } catch {}
}

// Varios avisos do mesmo projeto num cartao so: uma linha por tarefa (estado, titulo, resumo curto). Some sozinho so se todos forem
// "terminou"/"passou"; qualquer falha ou pedido segura o grupo ate voce abrir ou fechar.
export function NoticeGroup({ items, life, hold, onOpen, onDismiss, onDismissAll }: {
  items: Notice[]; life?: number; hold?: boolean; onOpen: (n: Notice) => void; onDismiss: (n: Notice) => void; onDismissAll: () => void
}) {
  const worst = items.find(x => ALERT.has(x.kind)) ?? items.find(x => x.kind !== 'done' && x.kind !== 'cmd-ok') ?? items[0]
  const auto = life && items.every(x => x.kind === 'done' || x.kind === 'cmd-ok')
  const bad = items.filter(x => ALERT.has(x.kind)).length
  return (
    <article className={`nc ncg k-${worst.kind} ${hold ? 'hold' : ''}`} role={bad ? 'alert' : 'status'} aria-label={`${items.length} avisos em ${items[0].project}`}>
      <header className="ncg-head">
        <span className="ncg-tile" aria-hidden="true">{items[0].project.slice(0, 1).toUpperCase()}</span>
        <span className="nc-line">
          <span className="nc-kind">{plural(items.length, 'aviso', 'avisos')}{bad > 0 && <span className="nc-time"> · {bad} com erro</span>}</span>
          <b className="ncg-project">{items[0].project}</b>
        </span>
        <button className="icon sm nc-x" aria-label="Fechar todos os avisos deste projeto" onClick={onDismissAll}><Icon n="close" size={14} /></button>
      </header>
      <ul className="ncg-list">
        {items.slice(0, 5).map(x => (
          <li key={x.key} className={`k-${x.kind}`}>
            <button className="ncg-row" onClick={() => onOpen(x)} title={`${x.heading}: ${x.summary}`}>
              <span className="ncg-dot"><Icon n={BADGE[x.kind]} size={10} /></span>
              <span className="ncg-body">
                <span className="ncg-title">{x.title}</span>
                <span className="ncg-sub"><span className="ncg-state">{x.heading}</span>{x.duration && ` · ${x.duration}`}{x.activity?.lastOk != null && ` · ${x.activity.lastOk ? 'testes ok' : 'testes falharam'}`}{x.filesTotal?.count ? ` · ${plural(x.filesTotal.count, 'arquivo', 'arquivos')}` : ''}</span>
              </span>
              <Icon n="chevron" size={14} />
            </button>
            <button className="icon sm ncg-x" aria-label={`Fechar aviso de ${x.title}`} onClick={() => onDismiss(x)}><Icon n="close" size={12} /></button>
          </li>
        ))}
        {items.length > 5 && <li className="nc-more">e mais {items.length - 5}</li>}
      </ul>
      {auto && <i className="nc-life" aria-hidden="true" style={{ animationDuration: `${life}s` }} onAnimationEnd={onDismissAll} />}
    </article>
  )
}
