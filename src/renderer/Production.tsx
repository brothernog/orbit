import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errText, onChat } from './api'
import { shrink, Thumbs } from './Todo'
import type { Asset, AssetVersion, Build, BuildCommand, ReviewState } from '../main/production'
import type { Playtest } from '../main/playtests'
import './production.css'

type Records = { assets: Asset[]; builds: Build[]; playtests: Playtest[]; commands: BuildCommand[] }
type Action = (f: () => Promise<unknown>) => Promise<boolean>
type Tools = { game: string; busy: boolean; action: Action; preview: (images: string[]) => void }

const reviewText: Record<ReviewState, string> = { pending: 'Aguardando revisão', approved: 'Aprovado', rejected: 'Rejeitado' }
const outcomeText = { pass: 'Passou', fail: 'Falhou', mixed: 'Parcial' }
const severityText = { low: 'Baixa', medium: 'Média', high: 'Alta' }
const sizeText = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const dateText = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR')
const assetDraft = { title: '', path: '', kind: '', license: '', source: '', tags: '', note: '' }
const buildDraft = { title: '', version: '', platform: '', path: '', notes: '', commandId: '' }
const playtestDraft = { title: '', scenario: '', expected: '', observed: '', outcome: 'fail' as Playtest['outcome'], notes: '', severity: 'medium' as Playtest['severity'], buildId: '' }

function ImagePreview({ images, onClose }: { images: string[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog className="production-preview" ref={dialog} aria-label="Imagens de produção" onClose={onClose}>
    <header><h3>Imagens de produção</h3><button autoFocus onClick={() => dialog.current?.close()}>Fechar imagens</button></header>
    <div>{images.map((src, i) => <img key={i} src={src} alt={`Imagem ${i + 1}`} />)}</div>
  </dialog>
}

function ReviewActions({ version, kind, ...tools }: Tools & { version: AssetVersion | Build; kind: 'asset' | 'build' }) {
  const review = (decision: 'approved' | 'rejected') => tools.action(() => kind === 'asset'
    ? api.reviewAssetVersion(tools.game, version.id, version.hash, decision)
    : api.reviewBuild(tools.game, version.id, version.hash, decision))
  return <div className="production-actions">
    {version.state !== 'approved' && <button className="primary" disabled={tools.busy} onClick={() => review('approved')}>Aprovar {kind === 'asset' ? 'versão' : 'build'}</button>}
    {version.state !== 'rejected' && <button disabled={tools.busy} onClick={() => review('rejected')}>Rejeitar {kind === 'asset' ? 'versão' : 'build'}</button>}
    {version.state === 'approved' && <button disabled={tools.busy} onClick={() => tools.action(() => api.exportProductionFile(tools.game, kind, version.id))}>Exportar cópia</button>}
    {kind === 'asset' && /\.(png|jpe?g|webp|gif)$/i.test(version.file_name) && <button disabled={tools.busy} onClick={() => tools.action(async () => {
      const image = await api.assetImage(tools.game, version.id)
      if (!image) throw Error('Esta imagem não pode ser exibida.')
      tools.preview([image])
    })}>Ver imagem</button>}
  </div>
}

function AssetRow({ asset, ...tools }: Tools & { asset: Asset }) {
  const [note, setNote] = useState('')
  return <details className="production-record">
    <summary><b>{asset.title}</b><span className="production-path">{asset.path}</span><span className="production-meta">{asset.versions.length} {asset.versions.length === 1 ? 'versão' : 'versões'}</span></summary>
    <div className="production-record-body">
      <dl className="production-facts"><div><dt>Tipo</dt><dd>{asset.kind || 'Não informado'}</dd></div><div><dt>Licença</dt><dd>{asset.license || 'Não informada'}</dd></div><div><dt>Origem</dt><dd>{asset.source || 'Não informada'}</dd></div><div><dt>Tags</dt><dd>{asset.tags || 'Nenhuma'}</dd></div></dl>
      <form className="production-capture" onSubmit={async e => { e.preventDefault(); if (await tools.action(() => api.captureAssetVersion(tools.game, asset.id, note))) setNote('') }}>
        <label>Nota da próxima versão<input aria-label={`Nota da versão de ${asset.title}`} value={note} maxLength={4000} onChange={e => setNote(e.target.value)} disabled={tools.busy} placeholder="O que mudou neste arquivo?" /></label>
        <button disabled={tools.busy}>Capturar nova versão</button>
      </form>
      <ol className="production-versions">{asset.versions.map((version, i) => <li key={version.id}>
        <header><b>Versão {asset.versions.length - i}</b><span className={`production-state ${version.state}`}>{reviewText[version.state]}</span></header>
        <span className="production-meta">{sizeText(version.size)} · {dateText(version.created_at)}</span>
        <code className="production-hash" title={version.hash}>SHA-256 {version.hash}</code>
        {version.note && <p className="production-copy">{version.note}</p>}
        <ReviewActions {...tools} version={version} kind="asset" />
      </li>)}</ol>
    </div>
  </details>
}

function Assets({ assets, ...tools }: Tools & { assets: Asset[] }) {
  const [draft, setDraft] = useState(assetDraft), [filter, setFilter] = useState('')
  const patch = (key: keyof typeof draft, value: string) => setDraft(d => ({ ...d, [key]: value }))
  const filtered = assets.filter(a => `${a.title} ${a.path} ${a.kind} ${a.tags}`.toLowerCase().includes(filter.trim().toLowerCase()))
  return <>
    <div className="production-toolbar"><p className="muted">Guarde versões de arquivos do projeto e aprove a cópia que deseja usar.</p><input type="search" aria-label="Filtrar assets" placeholder="Buscar nome, tipo ou tag" value={filter} onChange={e => setFilter(e.target.value)} /></div>
    <details className="production-form-box"><summary>Registrar asset</summary>
      <form className="production-form" onSubmit={async e => { e.preventDefault(); if (await tools.action(() => api.captureAsset(tools.game, draft))) setDraft(assetDraft) }}>
        <fieldset disabled={tools.busy}><label>Nome do asset<input aria-label="Nome do asset" required maxLength={200} value={draft.title} onChange={e => patch('title', e.target.value)} /></label>
          <label className="production-wide">Arquivo relativo ao projeto<div className="production-file"><input aria-label="Arquivo do asset" required maxLength={2000} value={draft.path} onChange={e => patch('path', e.target.value)} placeholder="assets/personagem.png" /><button type="button" onClick={() => tools.action(async () => { const path = await api.selectProductionFile(tools.game); if (path) patch('path', path) })}>Escolher arquivo</button></div></label>
          <label>Tipo<input aria-label="Tipo do asset" maxLength={50} value={draft.kind} onChange={e => patch('kind', e.target.value)} placeholder="Sprite, áudio, modelo…" /></label>
          <label>Licença<input aria-label="Licença do asset" maxLength={300} value={draft.license} onChange={e => patch('license', e.target.value)} placeholder="Própria, CC0, licença comercial…" /></label>
          <label>Origem<input aria-label="Origem do asset" maxLength={1000} value={draft.source} onChange={e => patch('source', e.target.value)} placeholder="Autor ou endereço da fonte" /></label>
          <label>Tags<input aria-label="Tags do asset" maxLength={1000} value={draft.tags} onChange={e => patch('tags', e.target.value)} placeholder="personagem, floresta" /></label>
          <label className="production-wide">Nota desta versão<textarea aria-label="Nota do asset" rows={2} maxLength={4000} value={draft.note} onChange={e => patch('note', e.target.value)} /></label>
          <button className="primary production-submit">Capturar asset</button>
        </fieldset>
      </form>
    </details>
    <div className="production-list">{filtered.map(asset => <AssetRow key={asset.id} {...tools} asset={asset} />)}{!filtered.length && <p className="production-empty">{assets.length ? 'Nenhum asset corresponde à busca.' : 'Nenhum asset registrado. Escolha um arquivo para guardar a primeira versão.'}</p>}</div>
  </>
}

function PlaytestRow({ playtest, builds, onOpenTask, ...tools }: Tools & { playtest: Playtest; builds: Build[]; onOpenTask: (id: number) => void }) {
  const [title, setTitle] = useState(''), [instruction, setInstruction] = useState('')
  const openIssue = () => tools.action(async () => { const task = await api.taskForPin(playtest.pin_id); onOpenTask(typeof task === 'number' ? task : task.id) })
  const linkedBuild = builds.find(b => b.id === playtest.build_id)
  return <details className="production-record">
    <summary><b>{playtest.title}</b><span className={`production-state ${playtest.outcome === 'pass' ? 'approved' : playtest.outcome === 'fail' ? 'rejected' : 'pending'}`}>{outcomeText[playtest.outcome]}</span><span className="production-meta">{playtest.state === 'resolved' ? 'Resolvido' : 'Aberto'} · {severityText[playtest.severity]}</span></summary>
    <div className="production-record-body">
      <span className="production-meta">{dateText(playtest.created_at)}{playtest.build_id && ` · Build: ${linkedBuild ? `${linkedBuild.title} ${linkedBuild.version}` : `#${playtest.build_id}`}`}</span>
      <dl className="production-observations">{[['Cenário', playtest.scenario], ['Esperado', playtest.expected], ['Observado', playtest.observed], ['Notas', playtest.notes]].filter(([, text]) => text).map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
      <div className="production-actions">{playtest.imageCount > 0 && <button disabled={tools.busy} onClick={() => tools.action(async () => tools.preview(await api.playtestImages(tools.game, playtest.id)))}>Ver evidências ({playtest.imageCount})</button>}
        <button disabled={tools.busy} onClick={() => tools.action(() => api.setPlaytestState(tools.game, playtest.id, playtest.state === 'open' ? 'resolved' : 'open'))}>{playtest.state === 'open' ? 'Marcar resolvido' : 'Reabrir playtest'}</button>
        {playtest.pin_id && <button disabled={tools.busy} onClick={openIssue}>Abrir tarefa do problema</button>}
      </div>
      {!playtest.pin_id && <details className="production-issue"><summary>Criar problema a partir deste playtest</summary><form className="production-form" onSubmit={async (e: FormEvent) => {
        e.preventDefault()
        if (await tools.action(() => api.createPlaytestIssue(tools.game, playtest.id, title, instruction))) { setTitle(''); setInstruction('') }
      }}><fieldset disabled={tools.busy}>
        <p className="muted production-wide">Escreva a ordem de correção. Observações e imagens do playtest ficam neste painel; nada é enviado à IA automaticamente.</p>
        <label className="production-wide">Título do problema<input aria-label={`Título do problema do playtest ${playtest.id}`} required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label className="production-wide">Ordem de correção<textarea aria-label={`Ordem de correção do playtest ${playtest.id}`} required maxLength={20000} rows={3} value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
        <button className="primary production-submit">Criar problema</button>
      </fieldset></form></details>}
    </div>
  </details>
}

function Playtests({ playtests, builds, onOpenTask, ...tools }: Tools & { playtests: Playtest[]; builds: Build[]; onOpenTask: (id: number) => void }) {
  const [draft, setDraft] = useState(playtestDraft), [images, setImages] = useState<string[]>([]), [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all')
  const patch = (key: keyof typeof draft, value: string) => setDraft(d => ({ ...d, [key]: value }))
  return <>
    <div className="production-toolbar"><p className="muted">Registre o que aconteceu durante uma sessão de jogo e acompanhe as correções.</p><label>Mostrar<select aria-label="Filtrar playtests" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">Todos os playtests</option><option value="open">Abertos</option><option value="resolved">Resolvidos</option></select></label></div>
    <details className="production-form-box"><summary>Registrar playtest</summary><form className="production-form" onSubmit={async e => {
      e.preventDefault()
      if (await tools.action(() => api.addPlaytest(tools.game, { ...draft, images, buildId: draft.buildId ? Number(draft.buildId) : null }))) { setDraft(playtestDraft); setImages([]) }
    }}><fieldset disabled={tools.busy}>
      <label>Nome do playtest<input aria-label="Nome do playtest" required maxLength={200} value={draft.title} onChange={e => patch('title', e.target.value)} /></label>
      <label>Build testada<select aria-label="Build do playtest" value={draft.buildId} onChange={e => patch('buildId', e.target.value)}><option value="">Sem build vinculada</option>{builds.map(b => <option key={b.id} value={b.id}>{b.title} {b.version} · {b.platform}</option>)}</select></label>
      <label className="production-wide">Cenário<textarea aria-label="Cenário do playtest" maxLength={4000} rows={2} value={draft.scenario} onChange={e => patch('scenario', e.target.value)} placeholder="Como reproduzir o teste" /></label>
      <label>Resultado esperado<textarea aria-label="Resultado esperado do playtest" maxLength={8000} rows={3} value={draft.expected} onChange={e => patch('expected', e.target.value)} /></label>
      <label>Resultado observado<textarea aria-label="Resultado observado do playtest" required maxLength={8000} rows={3} value={draft.observed} onChange={e => patch('observed', e.target.value)} /></label>
      <label>Resultado<select aria-label="Resultado do playtest" value={draft.outcome} onChange={e => patch('outcome', e.target.value)}><option value="pass">Passou</option><option value="fail">Falhou</option><option value="mixed">Parcial</option></select></label>
      <label>Severidade<select aria-label="Severidade do playtest" value={draft.severity} onChange={e => patch('severity', e.target.value)}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option></select></label>
      <label className="production-wide">Notas<textarea aria-label="Notas do playtest" maxLength={8000} rows={2} value={draft.notes} onChange={e => patch('notes', e.target.value)} /></label>
      <label className="production-wide">Evidências ({images.length}/6)<input type="file" aria-label="Imagens do playtest" accept="image/png,image/jpeg,image/webp" multiple disabled={images.length >= 6} onChange={e => {
        const files = Array.from(e.target.files ?? []); e.target.value = ''
        void tools.action(async () => { if (files.length + images.length > 6) throw Error('Anexe no máximo 6 imagens.'); const added = await Promise.all(files.map(file => shrink(file, 1440))); setImages(old => [...old, ...added]) })
      }} /></label>
      {!!images.length && <div className="production-wide"><Thumbs images={images} onOpen={image => tools.preview([image])} onRemove={i => setImages(old => old.filter((_, j) => j !== i))} /></div>}
      <button className="primary production-submit">Salvar playtest</button>
    </fieldset></form></details>
    <div className="production-list">{playtests.filter(p => filter === 'all' || p.state === filter).map(playtest => <PlaytestRow key={playtest.id} {...tools} playtest={playtest} builds={builds} onOpenTask={onOpenTask} />)}{!playtests.some(p => filter === 'all' || p.state === filter) && <p className="production-empty">{playtests.length ? 'Nenhum playtest neste estado.' : 'Nenhum playtest registrado. Guarde o cenário, o resultado e suas evidências após jogar.'}</p>}</div>
  </>
}

function CommandSource({ snapshot }: { snapshot: string }) {
  let command: { name: string; program: string; args: string; workspace: string; exit_code: number; duration_ms: number | null }
  let args: string[]
  try { command = JSON.parse(snapshot); args = JSON.parse(command.args); if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw Error('Argumentos inválidos') } catch { return <p className="muted">Não foi possível exibir o comando de origem.</p> }
  return <details className="production-source"><summary>Comando de origem: {command.name}</summary><dl className="production-observations">
    <div><dt>Programa e argumentos</dt><dd><code>{command.program} {args.map(arg => JSON.stringify(arg)).join(' ')}</code></dd></div>
    <div><dt>Pasta de execução</dt><dd className="production-path">{command.workspace}</dd></div>
    <div><dt>Resultado do processo</dt><dd>exit {command.exit_code}{command.duration_ms != null && ` · ${(command.duration_ms / 1000).toFixed(1)}s`}</dd></div>
  </dl></details>
}

function Builds({ builds, commands, onOpenTask, ...tools }: Tools & { builds: Build[]; commands: BuildCommand[]; onOpenTask: (id: number) => void }) {
  const [draft, setDraft] = useState(buildDraft)
  const patch = (key: keyof typeof draft, value: string) => setDraft(d => ({ ...d, [key]: value }))
  const command = commands.find(c => c.id === Number(draft.commandId))
  return <>
    <p className="muted production-intro">Guarde um arquivo distribuível após um comando local concluído. Revise o jogo antes de aprovar a build.</p>
    <details className="production-form-box"><summary>Registrar build</summary><form className="production-form" onSubmit={async e => { e.preventDefault(); if (await tools.action(() => api.registerBuild(tools.game, { ...draft, commandId: Number(draft.commandId) }))) setDraft(buildDraft) }}><fieldset disabled={tools.busy}>
      <label className="production-wide">Comando concluído<select aria-label="Comando da build" required value={draft.commandId} onChange={e => patch('commandId', e.target.value)}><option value="">Escolher comando</option>{commands.map(c => <option key={c.id} value={c.id}>#{c.id} {c.name} · {c.task_title}</option>)}</select></label>
      {!commands.length && <p className="muted production-wide">Execute um comando local na conversa de uma tarefa. Comandos concluídos com exit 0 aparecem aqui.</p>}
      {command && <p className="production-meta production-wide">Pasta do comando: <span className="production-path">{command.workspace}</span></p>}
      <label>Nome da build<input aria-label="Nome da build" required maxLength={200} value={draft.title} onChange={e => patch('title', e.target.value)} /></label>
      <label>Versão<input aria-label="Versão da build" required maxLength={100} value={draft.version} onChange={e => patch('version', e.target.value)} placeholder="0.1.0" /></label>
      <label>Plataforma<input aria-label="Plataforma da build" required maxLength={100} value={draft.platform} onChange={e => patch('platform', e.target.value)} placeholder="Windows, Linux, Android…" /></label>
      <label>Arquivo relativo à pasta do comando<input aria-label="Arquivo da build" required maxLength={2000} value={draft.path} onChange={e => patch('path', e.target.value)} placeholder="dist/jogo.zip" /></label>
      <label className="production-wide">Notas<textarea aria-label="Notas da build" rows={2} maxLength={5000} value={draft.notes} onChange={e => patch('notes', e.target.value)} /></label>
      <button className="primary production-submit" disabled={!draft.commandId}>Capturar build</button>
    </fieldset></form></details>
    <div className="production-list">{builds.map(build => <details key={build.id} className="production-record"><summary><b>{build.title} <span className="production-meta">{build.version}</span></b><span className="production-meta">{build.platform}</span><span className={`production-state ${build.state}`}>{reviewText[build.state]}</span></summary><div className="production-record-body">
      <span className="production-path">{build.file_name}</span><span className="production-meta">{sizeText(build.size)} · {dateText(build.created_at)}</span><code className="production-hash" title={build.hash}>SHA-256 {build.hash}</code>
      {build.notes && <p className="production-copy">{build.notes}</p>}
      <CommandSource snapshot={build.command} />
      <div className="production-actions"><ReviewActions {...tools} version={build} kind="build" />{build.source_task_id && <button disabled={tools.busy} onClick={() => onOpenTask(build.source_task_id!)}>Abrir tarefa de origem</button>}</div>
    </div></details>)}{!builds.length && <p className="production-empty">Nenhuma build registrada. Capture um arquivo após executar seu comando de build.</p>}</div>
  </>
}

export function Production({ game, onOpenTask, onErr }: { game: string; onOpenTask: (id: number) => void; onErr: (m: string) => void }) {
  const [tab, setTab] = useState<'assets' | 'playtests' | 'builds'>('assets'), [records, setRecords] = useState<Records | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [images, setImages] = useState<string[]>([])
  const live = useRef(true), sequence = useRef(0), locked = useRef(false)
  const load = async () => {
    const current = ++sequence.current
    const [assets, playtests, builds, commands] = await Promise.all([api.listAssets(game), api.listPlaytests(game), api.listBuilds(game), api.listBuildCommands(game)])
    if (live.current && current === sequence.current) setRecords({ assets, playtests, builds, commands })
  }
  useEffect(() => {
    live.current = true
    void load().catch(e => { if (live.current) setError(errText(e)) })
    const off = onChat(e => { if ((e.productionChanged && e.game?.toLowerCase() === game.toLowerCase()) || e.commandChanged) void load().catch(error => { if (live.current) setError(errText(error)) }) })
    return () => { live.current = false; off() }
  }, [game])
  const action: Action = async f => {
    if (locked.current) return false
    locked.current = true; setBusy(true); setError('')
    try {
      await f()
      if (live.current) try { await load() } catch (e) { setError(`Operação concluída, mas a lista não foi atualizada: ${errText(e)}`) }
      return live.current
    }
    catch (e) { if (live.current) setError(errText(e)); return false }
    finally { locked.current = false; if (live.current) setBusy(false) }
  }
  const openTask = (id: number) => { try { onOpenTask(id) } catch (e) { onErr(errText(e)) } }
  const tools = { game, busy, action, preview: setImages }
  return <section className="production" aria-label="Produção do jogo" aria-busy={busy}>
    <header className="production-head"><div><span className="production-eyebrow">Do arquivo ao playtest</span><h2>Produção</h2></div><span className="production-meta">{busy ? 'Salvando…' : 'Revisão e registro locais'}</span></header>
    <nav className="production-nav" aria-label="Área de produção">{(['assets', 'playtests', 'builds'] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === 'assets' ? 'Assets' : value === 'playtests' ? 'Playtests' : 'Builds'}{records && <span>{records[value].length}</span>}</button>)}</nav>
    {error && <p className="err production-error" role="alert">{error}<button disabled={busy} onClick={() => action(load)}>Tentar novamente</button></p>}
    {!records ? <p className="production-empty" role="status">Carregando produção…</p> : <><div hidden={tab !== 'assets'}><Assets {...tools} assets={records.assets} /></div><div hidden={tab !== 'playtests'}><Playtests {...tools} playtests={records.playtests} builds={records.builds} onOpenTask={openTask} /></div><div hidden={tab !== 'builds'}><Builds {...tools} builds={records.builds} commands={records.commands} onOpenTask={openTask} /></div></>}
    {!!images.length && <ImagePreview images={images} onClose={() => setImages([])} />}
  </section>
}
