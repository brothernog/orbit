import { useEffect, useState } from 'react'
import { AGENTS, api, depth, errText, name, onChat, type Account, type Pin } from './api'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { Confirm } from './Nav'

const ROADMAP_TEMPLATE = `# Roadmap\n\n## Agora\n- [ ] \n\n## Proximo\n- [ ] \n\n## Depois\n- [ ] \n`
type Tab = 'roadmap' | 'problemas' | 'docs'

function PinItem({ pin, accounts, reload, onOpenTask, fail }: { pin: Pin; accounts: Account[]; reload: () => void; onOpenTask: (id: number) => void; fail: (m: string) => void }) {
  const [ask, setAsk] = useState(false)
  const [agent, setAgent] = useState('claude')
  const [acc, setAcc] = useState(accounts[0]?.id)
  const setStatus = (s: string) => api.setPinStatus(pin.id, s).then(reload, e => fail(errText(e)))
  return (
    <li className={`pin ${pin.status}`}>
      <b>{pin.title}</b>
      {pin.body && <p>{pin.body}</p>}
      {pin.branch && <small>{pin.agent} · {pin.branch} <button className="link" onClick={() => api.openFolder(pin.worktree).catch((e: any) => fail(errText(e)))}>abrir pasta</button></small>}
      <div className="row">
        {pin.status !== 'feito' && <button className="primary" onClick={() => api.taskForPin(pin.id).then(onOpenTask, e => fail(errText(e)))}>Abrir tarefa</button>}
        {pin.status !== 'feito' && <span className="picker">
          <select aria-label="Provedor do terminal" value={agent} onChange={e => setAgent(e.target.value)}>{AGENTS.map(a => <option key={a}>{a}</option>)}</select>
          {agent === 'claude' && <select aria-label="Conta do terminal" value={acc} onChange={e => setAcc(+e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
          <button title="Abre um terminal numa worktree isolada deste problema"
            onClick={() => api.taskForPin(pin.id).then(id => api.launchTask(id, { provider: agent, accountId: agent === 'claude' ? acc : undefined }, { isolate: true })).then(reload, e => fail(errText(e)))}>Terminal isolado</button>
        </span>}
        {pin.status !== 'feito' ? <button onClick={() => setStatus('feito')}>Concluir</button> : <button onClick={() => setStatus('aberto')}>Reabrir</button>}
        <button className="icon" aria-label="Remover problema" title="Remover problema" onClick={() => setAsk(true)}><Icon n="close" size={15} /></button>
      </div>
      {ask && <Confirm title={`Remover "${pin.title}"?`} body="O problema sai da lista do projeto. Tarefas e arquivos não são tocados." action="Remover" onClose={() => setAsk(false)} onConfirm={() => api.deletePin(pin.id).then(reload, (e: any) => fail(errText(e)))} />}
    </li>
  )
}

export function ProjectPanel({ game, accounts, onOpenTask, onClose }: { game: string; accounts: Account[]; onOpenTask: (id: number) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('roadmap')
  const [docs, setDocs] = useState<string[]>([])
  const [pins, setPins] = useState<Pin[]>([])
  const [roadmap, setRoadmap] = useState<{ path: string; text: string } | null>(null)
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const d: string[] = await api.listDocs(game)
      setDocs(d)
      setPins(await api.listPins(game))
      const r = d.filter(p => name(p).toLowerCase() === 'roadmap.md').sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0]
      setRoadmap(r ? { path: r, text: await api.readDoc(game, r) } : null)
    } catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { setOpen(null); setErr(''); load() }, [game])
  useEffect(() => onChat(e => { if (e.productionChanged && e.game === game) load() }), [game])

  const done = roadmap?.text.match(/^\s*[-*] \[x\]/gim)?.length ?? 0
  const total = done + (roadmap?.text.match(/^\s*[-*] \[ \]/gm)?.length ?? 0)
  const list = (s: string) => pins.filter(p => p.status === s)
  const pinList = (l: Pin[]) => <ul>{l.map(p => <PinItem key={p.id} pin={p} accounts={accounts} reload={load} onOpenTask={onOpenTask} fail={setErr} />)}</ul>
  // Contagem vira um selo discreto e so aparece quando ha algo (sem "(0)")
  const tabs: [Tab, string, number][] = [['roadmap', 'Roadmap', 0], ['problemas', 'Problemas', list('aberto').length + list('andamento').length], ['docs', 'Documentos', docs.length]]

  return (
    <aside className="panel" aria-label="Painel do projeto">
      <header>
        <h2 className="panel-title" title={game}>{name(game)}</h2>
        <button className="icon" aria-label="Recolher painel" title="Recolher painel" onClick={onClose}><Icon n="close" size={16} /></button>
      </header>
      {/* Abas numa linha propria: o topo da coluna divide espaco com os botoes da janela */}
      <div role="tablist" className="panel-tabs" aria-label="Visões do projeto">
        {tabs.map(([id, text, n]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); setOpen(null) }}>{text}{n > 0 && <span className="tab-n">{n}</span>}</button>)}
      </div>
      <div className="body">
        {err && <small className="err" role="alert">{err}</small>}
        {tab === 'roadmap' && (roadmap
          ? <>
              {total > 0 && <><small>{done} de {total} concluídos em {roadmap.path}</small><div className="bar"><div style={{ width: `${(done / total) * 100}%` }} /></div></>}
              <Markdown text={roadmap.text} />
            </>
          : <button onClick={() => api.writeDoc(game, 'ROADMAP.md', ROADMAP_TEMPLATE).then(load, e => setErr(errText(e)))}>Criar ROADMAP.md</button>)}
        {tab === 'problemas' && <>
          <form onSubmit={e => { e.preventDefault(); if (title.trim()) api.addPin(game, title.trim(), body).then(() => { setTitle(''); setBody(''); load() }, e => setErr(errText(e))) }}>
            <input aria-label="Novo problema" placeholder="Novo problema" value={title} onChange={e => setTitle(e.target.value)} />
            <textarea aria-label="Detalhes do problema" placeholder="Detalhes (vão no prompt do agente)" value={body} onChange={e => setBody(e.target.value)} />
            <button className="primary">Fixar problema</button>
          </form>
          <h3>Em andamento</h3>{pinList(list('andamento'))}
          <h3>Abertos</h3>{pinList(list('aberto'))}
          <details><summary>Concluídos ({list('feito').length})</summary>{pinList(list('feito'))}</details>
        </>}
        {tab === 'docs' && (open
          ? <>
              <div className="row"><button className="text-btn" onClick={() => setOpen(null)}>Voltar aos documentos</button><small>{open.path}</small></div>
              <Markdown text={open.text} />
            </>
          : <ul className="docs">{docs.map(d => <li key={d}><button className="link" onClick={async () => setOpen({ path: d, text: await api.readDoc(game, d) })}>{d}</button></li>)}</ul>)}
      </div>
    </aside>
  )
}
