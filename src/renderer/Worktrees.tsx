import { useEffect, useRef, useState } from 'react'
import { api, errText } from './api'
import { Confirm } from './Nav'

type Checkout = { path: string; branch: string | null; head: string }
type Pending = {
  token: string; source: Checkout; target: Checkout; conflicts: string[]; unstaged: boolean
  owned: boolean; blocked: string[]; mergeStarted: boolean; staged: string[]
}
type View = { target: Checkout; sources: Checkout[]; pending: Pending | null; removal: { path: string; branch: string; missing: boolean; blocked: string[] } | null }
type Merge = { token: string; source: Checkout; target: Checkout; commits: { sha: string; subject: string }[]; files: string[]; integrated: boolean }
type Removal = { token: string; source: Checkout; target: Checkout; blockers: string[] }
const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const branch = (c: Checkout) => c.branch ?? 'HEAD solto'

export function Worktrees({ game, dir, refresh, onPending, onChange }: {
  game: string; dir: string; refresh: number; onPending: (pending: boolean) => void; onChange: () => void
}) {
  const [v, setV] = useState<View | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Merge | Removal | null>(null)
  const [ask, setAsk] = useState<'merge' | 'finish' | 'abort' | 'remove' | 'cleanup' | 'dismiss' | null>(null)
  const [tick, setTick] = useState(0)
  const previewRequest = useRef(0)
  useEffect(() => {
    let live = true
    previewRequest.current++
    setPreview(null); setAsk(null)
    api.worktreeView(game).then((next: View) => {
      if (live) setV(next)
    }, (e: unknown) => { if (live) { setV(null); setError(errText(e)); onPending(false) } })
    return () => { live = false }
  }, [game, refresh, tick])
  useEffect(() => { if (v) onPending(!!v.pending && same(v.pending.target.path, dir)) }, [v, dir])
  useEffect(() => { previewRequest.current++; setPreview(null); setAsk(null) }, [dir])
  const act = (f: () => Promise<unknown>, changed = false) => {
    setBusy(true); setError('')
    f().catch(e => setError(errText(e))).finally(() => {
      setBusy(false)
      if (changed) { setTick(n => n + 1); onChange() }
    })
  }
  const showPreview = (f: () => Promise<Merge | Removal>) => {
    const request = ++previewRequest.current
    act(() => f().then(next => { if (request === previewRequest.current) setPreview(next) }))
  }
  const reload = () => { setError(''); setTick(n => n + 1) }
  const folder = (path: string) => act(() => api.openWorktreeFolder(game, path))
  const terminal = (path: string) => act(() => api.openWorktreeTerminal(game, path))
  if (!v && !error) return <section className="wt" aria-label="Integração de worktrees"><span className="loader sm" aria-label="Lendo worktrees" /></section>
  if (!v) return <section className="wt" aria-label="Integração de worktrees"><p className="err" role="alert">{error}</p><button onClick={reload}>Atualizar worktrees</button></section>
  const source = v.sources.find(s => same(s.path, dir)), pending = v.pending
  const merge = preview && 'commits' in preview ? preview : null
  const removal = preview && 'blockers' in preview ? preview : null
  if (!source && !pending && !v.removal && !v.sources.length && !error) return null
  return <section className="wt" aria-label="Integração de worktrees" aria-busy={busy}>
    <div className="br-row"><h3>Worktrees</h3><button className="text-btn" disabled={busy} onClick={reload}>Atualizar worktrees</button></div>
    {error && <p className="err" role="alert">{error}</p>}
    {v.removal && <div className="wt-preview wt-removal">
      <b>Limpeza interrompida</b><p><code>{v.removal.branch}</code></p>
      {v.removal.missing ? <p className="muted">A pasta já foi removida. Finalize para devolver as tarefas à pasta principal com sessões novas; as conversas ficam preservadas.</p>
        : <p className="muted">A pasta ainda existe. Selecione sua worktree acima e prepare uma nova prévia da limpeza.</p>}
      {!!v.removal.blocked.length && <ul className="wt-files wt-warning">{v.removal.blocked.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      {v.removal.missing && <button disabled={busy || !!v.removal.blocked.length} onClick={() => setAsk('cleanup')}>Finalizar limpeza</button>}
    </div>}
    {pending ? <div className="wt-pending">
      <b>{pending.mergeStarted ? 'Integração em revisão' : 'Integração interrompida'}</b>
      <p className="wt-route"><code>{branch(pending.source)}</code><span>→</span><code>{branch(pending.target)}</code></p>
      {pending.mergeStarted ? <p className="muted">Destino: pasta principal. Resolva os conflitos nela e marque os arquivos resolvidos com <code>git add</code> no terminal. Depois atualize esta revisão.</p>
        : <p className="muted">A integração não chegou a iniciar. Aborte este registro para preparar uma nova prévia.</p>}
      {!!pending.conflicts.length && <div><b className="wt-label">Conflitos ({pending.conflicts.length})</b><ul className="wt-files">{pending.conflicts.map(p => <li key={p}>{p}</li>)}</ul></div>}
      {!!pending.staged?.length && <details><summary>Arquivos marcados para o commit ({pending.staged.length})</summary><ul className="wt-files">{pending.staged.map(p => <li key={p}>{p}</li>)}</ul></details>}
      {!!pending.blocked.length && <ul className="wt-files wt-warning">{pending.blocked.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      {!pending.owned && <p className="wt-warning">Esta integração foi iniciada fora do Órbita. Conclua ou aborte pelo Git no terminal.</p>}
      <div className="br-actions">
        <button disabled={busy} onClick={() => folder(pending.target.path)}>Abrir destino</button>
        <button disabled={busy} onClick={() => terminal(pending.target.path)}>Terminal do destino</button>
        <button className="primary" disabled={busy || !pending.owned || !pending.mergeStarted || !!pending.conflicts.length || pending.unstaged || !!pending.blocked.length} onClick={() => setAsk('finish')}>Concluir integração</button>
        <button disabled={busy || !pending.owned} onClick={() => setAsk('abort')}>Abortar integração</button>
        {!pending.owned && !pending.mergeStarted && <button disabled={busy} onClick={() => setAsk('dismiss')}>Encerrar revisão desatualizada</button>}
      </div>
    </div> : source ? <>
      <p className="wt-route"><code>{branch(source)}</code><span>→</span><code>{branch(v.target)}</code></p>
      <p className="muted">Destino: branch aberta na pasta principal. A integração é local e passa por revisão antes do commit.</p>
      <div className="br-actions">
        <button disabled={busy} onClick={() => showPreview(() => api.previewWorktreeMerge(game, source.path))}>Prévia da integração</button>
        <button disabled={busy} onClick={() => showPreview(() => api.previewWorktreeRemoval(game, source.path))}>Prévia da limpeza</button>
        <button disabled={busy} onClick={() => folder(source.path)}>Abrir worktree</button>
      </div>
    </> : <p className="muted">Selecione uma worktree acima para revisar sua integração ou limpeza.</p>}
    {merge && <div className="wt-preview">
      <b>Prévia da integração</b>
      <p className="wt-route"><code>{branch(merge.source)} · {merge.source.head.slice(0, 8)}</code><span>→</span><code>{branch(merge.target)} · {merge.target.head.slice(0, 8)}</code></p>
      {merge.integrated ? <p className="wt-saved">Esta versão da branch já está integrada no destino.</p> : <>
        <details open><summary>Commits para integrar ({merge.commits.length})</summary><ul className="br-commits">{merge.commits.map(c => <li key={c.sha}><code>{c.sha.slice(0, 8)}</code><span title={c.subject}>{c.subject}</span></li>)}</ul></details>
        <details><summary>Arquivos envolvidos ({merge.files.length})</summary><ul className="wt-files">{merge.files.map(p => <li key={p}>{p}</li>)}</ul></details>
        <button className="primary" disabled={busy} onClick={() => setAsk('merge')}>Iniciar integração</button>
      </>}
    </div>}
    {removal && <div className="wt-preview">
      <b>Prévia da limpeza</b><p><code>{branch(removal.source)}</code></p>
      {removal.blockers.length ? <ul className="wt-files wt-warning">{removal.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul> : <p className="muted">Worktree limpa e integrada. A branch e o histórico ficam preservados; as tarefas voltam à pasta principal.</p>}
      <button disabled={busy || !!removal.blockers.length} onClick={() => setAsk('remove')}>Remover worktree</button>
    </div>}
    {ask === 'merge' && merge && <Confirm tone="primary" title="Iniciar integração local?" body={`Integra ${branch(merge.source)} em ${branch(merge.target)}, na pasta principal, e pausa para revisão. Nenhum commit de integração será criado ainda.`} action="Iniciar integração" onClose={() => setAsk(null)} onConfirm={() => act(() => api.beginWorktreeMerge(game, merge.source.path, merge.token), true)} />}
    {ask === 'finish' && pending && <Confirm tone="primary" title="Concluir integração local?" body={`Cria o commit de integração de ${branch(pending.source)} em ${branch(pending.target)} com os arquivos já marcados no Git.`} action="Concluir integração" onClose={() => setAsk(null)} onConfirm={() => act(() => api.finishWorktreeMerge(game, pending.token), true)} />}
    {ask === 'abort' && pending && <Confirm title="Abortar integração local?" body="Desfaz as alterações desta integração na pasta principal. A worktree de origem e sua branch ficam preservadas." action="Abortar integração" onClose={() => setAsk(null)} onConfirm={() => act(() => api.abortWorktreeMerge(game, pending.token), true)} />}
    {ask === 'dismiss' && pending && <Confirm title="Encerrar revisão desatualizada?" body="Encerra somente o registro desta revisão no app. Os arquivos, commits e branches atuais ficam preservados. O Git precisa estar sem operações pendentes." action="Encerrar revisão" onClose={() => setAsk(null)} onConfirm={() => act(() => api.dismissWorktreeMerge(game, pending.token), true)} />}
    {ask === 'remove' && removal && <Confirm title="Remover esta worktree?" body={`Remove a pasta isolada de ${branch(removal.source)} e devolve suas tarefas à pasta principal com sessões novas. A branch, as conversas e o histórico ficam preservados.`} action="Remover worktree" onClose={() => setAsk(null)} onConfirm={() => act(() => api.removeWorktree(game, removal.source.path, removal.token).finally(() => setTick(n => n + 1)))} />}
    {ask === 'cleanup' && v.removal && <Confirm tone="primary" title="Finalizar limpeza interrompida?" body={`Atualiza as tarefas de ${v.removal.branch} para a pasta principal com sessões novas. A pasta já está ausente; as conversas, a branch e o histórico ficam preservados.`} action="Finalizar limpeza" onClose={() => setAsk(null)} onConfirm={() => act(() => api.finishWorktreeRemoval(game), true)} />}
  </section>
}
