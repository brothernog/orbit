// Painel de branch da pasta (no resumo do projeto): o que mudou, commit, push, PR e issues, sem sair do app.
// Uma acao principal por vez: o botao em destaque e sempre o proximo passo (commit -> push -> PR). Publicar pede confirmacao.
// Arquivos desmarcados ficam fora do commit (continuam alterados na pasta).
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, errText } from './api'
import { Icon } from './icons'
import { Confirm } from './Nav'

type File = { path: string; status: 'M' | 'A' | 'D' | '?'; added: number | null; removed: number | null }
type Commit = { sha: string; subject: string; when: string }
type View = { branch: string | null; base: string | null; upstream: string | null; ahead: number; behind: number; files: File[]; toPush: Commit[]; recent: Commit[] }
type Pr = { number: number; title: string; url: string; state: string; review: string | null; base: string; checks: { ok: number; fail: number; running: number } }
type Issue = { number: number; title: string; url: string; labels: string[] }

const STATE: Record<string, string> = { OPEN: 'Aberto', DRAFT: 'Rascunho', MERGED: 'Mesclado', CLOSED: 'Fechado' }
const REVIEW: Record<string, string> = { APPROVED: 'Aprovado', CHANGES_REQUESTED: 'Pediram mudanças', REVIEW_REQUIRED: 'Aguardando revisão' }

const heads = (text: string) => text.split(/\r?\n/).filter(l => l.startsWith('@@'))

// Diff de um arquivo. Com `onHunk`, cada trecho (@@) ganha uma caixa: desmarcado fica fora do commit.
function DiffLines({ text, skip = [], onHunk }: { text: string; skip?: string[]; onHunk?: (h: string) => void }) {
  let off = false
  return <pre className="fp-diff">{text.split(/\r?\n/).map((l, i) => {
    const h = l.startsWith('@@')
    if (h) off = skip.includes(l)
    const cls = `${l[0] === '+' ? 'p' : l[0] === '-' ? 'm' : h ? 'h' : ''}${off ? ' off' : ''}`
    return h && onHunk
      ? <label key={i} className={`${cls} hunk`}><input type="checkbox" className="bf-check" checked={!off} onChange={() => onHunk(l)} aria-label={`Incluir o trecho ${l} no commit`} />{l}{'\n'}</label>
      : <span key={i} className={cls}>{l}{'\n'}</span>
  })}</pre>
}

// Sugestao de nome a partir da mensagem do commit: "Corrige login no Safari" -> "corrige-login-no-safari".
const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

// Criar branch: um campo, Enter cria. As alteracoes nao salvas vao junto.
function NewBranch({ initial, onSubmit, onClose }: { initial: string; onSubmit: (n: string) => Promise<unknown>; onClose: () => void }) {
  const [n, setN] = useState(initial), [busy, setBusy] = useState(false), [err, setErr] = useState('')
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [])
  return createPortal(
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal publish" role="dialog" aria-modal="true" aria-label="Nova branch"
        onSubmit={e => { e.preventDefault(); setBusy(true); setErr(''); onSubmit(n.trim()).then(onClose, x => { setErr(errText(x)); setBusy(false) }) }}>
        <header><h2>Nova branch</h2><button type="button" className="icon sm" aria-label="Fechar" onClick={onClose}><Icon n="close" size={15} /></button></header>
        <input autoFocus aria-label="Nome da branch" placeholder="ex.: feat/tela-de-login" value={n} maxLength={200} onChange={e => setN(e.target.value.replace(/\s/g, '-'))} />
        <p className="muted">As alterações que ainda não foram salvas vão junto para a nova branch. Depois é só fazer commit, push e abrir o PR.</p>
        {err && <p className="err">{err}</p>}
        <footer><span /><button className="primary" disabled={!n.trim() || busy}>{busy ? 'Criando…' : 'Criar e trocar'}</button></footer>
      </form>
    </div>, document.body)
}

// Formulario curto de publicar (PR ou issue): titulo + descricao; o botao ja diz que publica.
function Publish({ kind, initial, onSubmit, onClose }: { kind: 'pr' | 'issue'; initial: string; onSubmit: (t: string, b: string) => Promise<unknown>; onClose: () => void }) {
  const [t, setT] = useState(initial), [b, setB] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('')
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [])
  return createPortal(
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal publish" role="dialog" aria-modal="true" aria-label={kind === 'pr' ? 'Abrir pull request' : 'Nova issue'}
        onSubmit={e => { e.preventDefault(); setBusy(true); setErr(''); onSubmit(t.trim(), b).then(onClose, x => { setErr(errText(x)); setBusy(false) }) }}>
        <header><h2>{kind === 'pr' ? 'Abrir pull request' : 'Nova issue'}</h2><button type="button" className="icon sm" aria-label="Fechar" onClick={onClose}><Icon n="close" size={15} /></button></header>
        <input autoFocus aria-label="Título" placeholder="Título" value={t} maxLength={250} onChange={e => setT(e.target.value)} />
        <textarea aria-label="Descrição" placeholder="Descrição (opcional)" rows={5} value={b} onChange={e => setB(e.target.value)} />
        {err && <p className="err">{err}</p>}
        <footer>
          <span className="publish-note"><Icon n="alert" size={14} />Publica no GitHub com o seu login do gh.</span>
          <button className="primary" disabled={!t.trim() || busy}>{busy ? 'Publicando…' : kind === 'pr' ? 'Publicar PR' : 'Publicar issue'}</button>
        </footer>
      </form>
    </div>, document.body)
}

export function BranchPanel({ dirs, onErr }: { dirs: { path: string; label: string }[]; onErr: (m: string) => void }) {
  const [dir, setDir] = useState(dirs[0].path)
  const [v, setV] = useState<View | null>(null)
  const [pr, setPr] = useState<{ pr: Pr | null; error: string | null } | null>(null)
  const [issues, setIssues] = useState<Issue[] | string | null>(null) // string = erro do gh
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [diff, setDiff] = useState<Record<string, string | null>>({})
  const [open, setOpen] = useState<{ push?: boolean; issues?: boolean }>({})
  const [ask, setAsk] = useState<'push' | 'commitpush' | 'pr' | 'issue' | 'branch' | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set()) // desmarcados: ficam fora do commit
  const [hskip, setHskip] = useState<Record<string, string[]>>({}) // trechos desmarcados por arquivo (so arquivos modificados)

  const load = () => {
    api.branchView(dir).then(setV, (e: any) => { setV(null); onErr(errText(e)) })
    api.prView(dir).then(setPr, () => setPr({ pr: null, error: null }))
  }
  useEffect(() => { setV(null); setPr(null); setIssues(null); setDiff({}); setSkip(new Set()); setHskip({}); load() }, [dir])
  // Recarrega mesmo na falha: "commit e push" pode ter salvo o commit e falhado so no envio.
  const act = (name: string, f: () => Promise<unknown>) => { setBusy(name); f().catch((e: any) => onErr(errText(e))).finally(() => { setBusy(null); load() }) }
  const toggleDiff = (p: string) => {
    if (p in diff) return setDiff(({ [p]: _, ...rest }) => rest)
    setDiff(d => ({ ...d, [p]: null }))
    api.branchDiff(dir, p).then((t: string) => setDiff(d => ({ ...d, [p]: t })), (e: any) => setDiff(d => ({ ...d, [p]: errText(e) })))
  }
  const loadIssues = () => api.issueList(dir).then(setIssues, (e: any) => setIssues(errText(e)))

  if (!v) return <section className="branch" aria-label="Branch"><span className="loader" aria-label="Lendo o Git" /></section>
  const canPush = v.ahead > 0 || (!v.upstream && !!v.branch && v.recent.length > 0)
  // O proximo passo ganha o botao cheio; o resto fica discreto.
  // PR so de uma branch que nao e a principal (main -> main o GitHub recusa).
  const next = v.files.length ? 'commit' : canPush ? 'push' : !pr?.pr && !pr?.error && v.upstream && v.ahead === 0 && v.recent.length && v.branch !== v.base ? 'pr' : null
  const c = pr?.pr?.checks
  const onBase = !!v.branch && v.branch === v.base
  const picked = v.files.filter(f => !skip.has(f.path))
  const allOn = picked.length === v.files.length
  const partial = picked.filter(f => hskip[f.path]?.length)
  const whole = allOn && !partial.length
  const commit = () => api.branchCommit(dir, msg, whole ? undefined : picked.filter(f => !hskip[f.path]?.length).map(f => f.path),
    partial.length ? partial.map(f => ({ path: f.path, skip: hskip[f.path] })) : undefined).then(() => { setMsg(''); setSkip(new Set()); setHskip({}); setDiff({}) })
  const flip = (p: string) => { setHskip(({ [p]: _, ...rest }) => rest); setSkip(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n }) }
  // Desmarcar todos os trechos = desmarcar o arquivo.
  const flipHunk = (p: string, h: string) => {
    const cur = hskip[p] ?? [], next = cur.includes(h) ? cur.filter(x => x !== h) : [...cur, h]
    if (next.length >= heads(diff[p] ?? '').length) return flip(p)
    setHskip(m => ({ ...m, [p]: next }))
  }
  // Antes de publicar: se o remoto andou, nao salva nem envia (o push seria recusado).
  const guard = async () => {
    const n = await api.branchRemoteAhead(dir)
    if (n) throw new Error(`O remoto tem ${n} commit${n > 1 ? 's' : ''} novo${n > 1 ? 's' : ''}. Puxe antes de enviar; nada foi enviado.`)
  }
  const canCommit = !!msg.trim() && picked.length > 0 && !busy

  return (
    <section className="branch" aria-label="Branch">
      <header className="br-head">
        <Icon n="branch" size={16} />
        <b className="br-name" title={v.branch ?? 'HEAD solto'}>{v.branch ?? 'HEAD solto'}</b>
        {v.upstream ? <span className="br-up" title="Remoto acompanhado">→ {v.upstream}</span> : v.branch && <span className="br-up warn">sem remoto</span>}
        <span className="br-sync">{v.ahead > 0 && <span title="Commits para enviar">↑{v.ahead}</span>}{v.behind > 0 && <span className="warn" title="Commits novos no remoto">↓{v.behind}</span>}</span>
        <button className="icon sm" aria-label="Nova branch" title="Nova branch" onClick={() => setAsk('branch')}><Icon n="plus" size={14} /></button>
        <button className="icon sm" aria-label="Atualizar" title="Atualizar" onClick={load}><Icon n="refresh" size={14} /></button>
      </header>
      {dirs.length > 1 && <div className="br-dirs" role="tablist" aria-label="Pasta ou worktree">
        {dirs.map(d => <button key={d.path} role="tab" aria-selected={d.path === dir} title={d.path} onClick={() => setDir(d.path)}>{d.label}</button>)}
      </div>}

      {pr?.pr
        ? <button className={`br-pr s-${pr.pr.state.toLowerCase()}`} onClick={() => api.openGithub(pr.pr!.url)} title="Abrir no GitHub">
            <span className="br-pr-top"><Icon n="pr" size={15} /><b>#{pr.pr.number}</b><span className="br-pr-title">{pr.pr.title}</span><span className="br-pr-state">{STATE[pr.pr.state] ?? pr.pr.state}</span></span>
            <span className="br-pr-meta">
              {c && c.ok + c.fail + c.running > 0 && <span className="br-checks">
                {c.fail > 0 && <span className="bad">✕ {c.fail}</span>}{c.running > 0 && <span className="run">● {c.running}</span>}{c.ok > 0 && <span className="ok">✓ {c.ok}</span>}</span>}
              {pr.pr.review && <span>{REVIEW[pr.pr.review] ?? pr.pr.review}</span>}
              <span className="faint">para {pr.pr.base}</span>
            </span>
          </button>
        : pr?.error && <p className="br-note">{pr.error}</p>}

      {v.behind > 0 && <button className="br-pull" disabled={!!busy} onClick={() => act('pull', () => api.branchPull(dir))}>
        <Icon n="down" size={14} />{busy === 'pull' ? 'Puxando…' : `Puxar ${v.behind} ${v.behind === 1 ? 'commit novo' : 'commits novos'}`}</button>}

      {v.files.length > 0 && <textarea className="br-msg" aria-label="Mensagem do commit" placeholder="O que mudou? (mensagem do commit)" rows={2} value={msg} onChange={e => setMsg(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey && canCommit) act('commit', commit) }} />}
      <div className="br-actions">
        {v.files.length > 0 && <button className={next === 'commit' ? 'primary' : ''} disabled={!canCommit} title="Só os arquivos marcados (Ctrl+Enter)"
          onClick={() => act('commit', commit)}><Icon n="commit" size={15} />{busy === 'commit' ? 'Salvando…' : `Commit de ${picked.length}`}</button>}
        {v.files.length > 0 && v.branch && <button disabled={!canCommit} title="Commit dos marcados e envia para o GitHub (pede confirmação)"
          onClick={() => setAsk('commitpush')}><Icon n="send" size={15} />{busy === 'commitpush' ? 'Enviando…' : 'Commit e push'}</button>}
        {canPush && <button className={next === 'push' ? 'primary' : ''} disabled={!!busy} onClick={() => setAsk('push')}><Icon n="send" size={15} />{busy === 'push' ? 'Enviando…' : v.ahead ? `Push ${v.ahead}` : 'Publicar branch'}</button>}
        {next === 'pr' && <button className="primary" onClick={() => setAsk('pr')}><Icon n="pr" size={15} />Abrir PR</button>}
        {onBase && (v.files.length > 0 || v.ahead > 0) && <button onClick={() => setAsk('branch')} title="PR precisa de outra branch: as alterações vão junto"><Icon n="branch" size={15} />Nova branch para PR</button>}
        {!v.files.length && !canPush && next !== 'pr' && <span className="br-clean"><Icon n="check" size={15} />Tudo salvo e enviado</span>}
      </div>

      {v.files.length > 0 && <div className="br-sec">
        <h3><input type="checkbox" className="bf-check" aria-label="Marcar todos" checked={allOn} ref={el => { if (el) el.indeterminate = !allOn && picked.length > 0 }}
          onChange={() => setSkip(allOn ? new Set(v.files.map(f => f.path)) : new Set())} />Alterações <span>{allOn ? v.files.length : `${picked.length} de ${v.files.length}`}</span></h3>
        <ul className="br-files">
          {v.files.map(f => (
            <li key={f.path} className={skip.has(f.path) ? 'off' : ''}>
              <input type="checkbox" className="bf-check" aria-label={`Incluir ${f.path} no commit`} checked={!skip.has(f.path)} onChange={() => flip(f.path)}
                ref={el => { if (el) el.indeterminate = !!hskip[f.path]?.length }} title={hskip[f.path]?.length ? 'Só parte dos trechos entra no commit' : undefined} />
              <button aria-expanded={f.path in diff} onClick={() => toggleDiff(f.path)} title={f.path}>
                <span className={`fs fs-${f.status === '?' ? 'u' : f.status}`}>{f.status === '?' ? 'U' : f.status}</span>
                <span className="bf-name">{f.path.split('/').pop()}</span>
                <span className="bf-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                <span className="bf-num">{f.added != null && <i className="p">+{f.added}</i>}{f.removed ? <i className="m">−{f.removed}</i> : null}</span>
              </button>
              {f.path in diff && (diff[f.path] == null ? <span className="loader sm" aria-label="Carregando diff" /> : <DiffLines text={diff[f.path]!} skip={hskip[f.path]} onHunk={f.status === 'M' && !skip.has(f.path) && heads(diff[f.path]!).length > 1 ? h => flipHunk(f.path, h) : undefined} />)}
            </li>
          ))}
        </ul>
      </div>}

      {v.toPush.length > 0 && <div className="br-sec">
        <button className="br-toggle" aria-expanded={!!open.push} onClick={() => setOpen(o => ({ ...o, push: !o.push }))}><Icon n="chevron" size={12} />Para enviar <span>{v.toPush.length}</span></button>
        {open.push && <ul className="br-commits">{v.toPush.map(c => <li key={c.sha}><code>{c.sha}</code><span>{c.subject}</span><small>{c.when}</small></li>)}</ul>}
      </div>}

      <div className="br-sec">
        <div className="br-row">
          <button className="br-toggle" aria-expanded={!!open.issues} onClick={() => { setOpen(o => ({ ...o, issues: !o.issues })); if (issues === null) loadIssues() }}>
            <Icon n="chevron" size={12} />Issues {Array.isArray(issues) && <span>{issues.length}</span>}</button>
          <button className="text-btn" onClick={() => setAsk('issue')}><Icon n="plus" size={14} />Nova issue</button>
        </div>
        {open.issues && (issues === null ? <span className="loader sm" aria-label="Carregando issues" />
          : typeof issues === 'string' ? <p className="br-note">{issues}</p>
          : issues.length === 0 ? <p className="br-note">Nenhuma issue aberta.</p>
          : <ul className="br-issues">{issues.map(i => <li key={i.number}><button onClick={() => api.openGithub(i.url)} title="Abrir no GitHub"><b>#{i.number}</b><span>{i.title}</span>{i.labels.map(l => <em key={l}>{l}</em>)}</button></li>)}</ul>)}
      </div>

      {ask === 'push' && <Confirm tone="primary" title={v.ahead ? `Enviar ${v.ahead} commit${v.ahead > 1 ? 's' : ''}?` : `Publicar a branch ${v.branch}?`} action="Enviar"
        body={`Envia ${v.branch} para ${v.upstream ?? 'origin (cria o remoto)'}. Isso publica no GitHub e não dá para desfazer pelo app.`}
        onClose={() => setAsk(null)} onConfirm={() => act('push', () => guard().then(() => api.branchPush(dir)))} />}
      {ask === 'commitpush' && <Confirm tone="primary" title={`Commit de ${picked.length} arquivo${picked.length > 1 ? 's' : ''} e enviar?`} action="Commit e push"
        body={`Salva "${msg.trim().slice(0, 80)}" e envia ${v.branch} para ${v.upstream ?? 'origin (cria o remoto)'}. Isso publica no GitHub e não dá para desfazer pelo app.`}
        onClose={() => setAsk(null)} onConfirm={() => act('commitpush', () => guard().then(commit).then(() => api.branchPush(dir)))} />}
      {ask === 'pr' && <Publish kind="pr" initial={v.recent[0]?.subject ?? v.branch ?? ''} onClose={() => setAsk(null)} onSubmit={(t, b) => api.prCreate(dir, t, b).then(load)} />}
      {ask === 'branch' && <NewBranch initial={slug(msg)} onClose={() => setAsk(null)} onSubmit={n => api.branchCreate(dir, n).then(load)} />}
      {ask === 'issue' && <Publish kind="issue" initial="" onClose={() => setAsk(null)} onSubmit={(t, b) => api.issueCreate(dir, t, b).then(() => { setOpen(o => ({ ...o, issues: true })); loadIssues() })} />}
    </section>
  )
}
