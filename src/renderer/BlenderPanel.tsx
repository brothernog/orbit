import { useState } from 'react'
import type { CommandRun, ProjectCommand } from '../main/commands'
import type { BlenderAction, BlenderDetails } from '../main/blenderFlow'
import { EnginePanel } from './EnginePanel'

const actionLabels: Record<BlenderAction, string> = { render: 'Renderizar um quadro (PNG)', export: 'Exportar glTF (.glb)', script: 'Executar script Python', open: 'Abrir no Blender' }
const size = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`
const newer = (file: string | null, blender?: string) => { if (!file || !blender) return false; const [a, b] = file.split('.').map(Number), [c, d] = blender.split('.').map(Number); return a > c || a === c && b > d }

export function BlenderPanel(props: { taskId: number; game: string; disabled: boolean; commands: ProjectCommand[]; runs: CommandRun[]; onPrepared: () => Promise<void> }) {
  const [action, setAction] = useState<BlenderAction>('render'), [file, setFile] = useState(''), [output, setOutput] = useState(''), [frame, setFrame] = useState('1'), [script, setScript] = useState('')
  return <EnginePanel<BlenderDetails> {...props} engine="blender" label="Blender"
    facts={(details, probe) => <>
      <ul className="engine-files" aria-label="Arquivos .blend">{details.files.map(f => <li key={f.rel}><code>{f.rel}</code><small>{f.version ? `Blender ${f.version}` : 'Versão não reconhecida'} · {size(f.size)}{!!f.backups && ` · ${f.backups} backup(s)`}</small>{newer(f.version, probe?.version) && <small className="err">Salvo em versão mais nova que o Blender {probe!.version}; abrir pode perder dados.</small>}</li>)}</ul>
      {details.truncated && <p className="muted">Lista limitada; há mais arquivos .blend no projeto.</p>}
      {!details.files.length && <p className="muted">Nenhum arquivo .blend fora de pastas internas.</p>}
    </>}
    form={({ busy, blocked, details, prepare, changed }) => {
      const on = <T,>(set: (v: T) => void) => (v: T) => { set(v); changed() }
      const blend = details.files.some(f => f.rel === file) ? file : ''
      const ready = !!blend && (action === 'render' ? !!output.trim() && /^\d+$/.test(frame) : action === 'export' ? /\.glb$/i.test(output.trim()) : action === 'script' ? /\.py$/i.test(script.trim()) : true)
      return <form onSubmit={e => { e.preventDefault(); if (ready) prepare(action, { file: blend, ...(action === 'render' ? { output: output.trim(), frame: Number(frame) } : {}), ...(action === 'export' ? { output: output.trim() } : {}), ...(action === 'script' ? { script: script.trim() } : {}) }) }}>
        <label>Ação local<select aria-label="Ação Blender" value={action} disabled={busy} onChange={e => { on(setAction)(e.target.value as BlenderAction); setOutput('') }}>{Object.entries(actionLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
        <label>Arquivo .blend<select aria-label="Arquivo .blend" required value={blend} disabled={busy} onChange={e => on(setFile)(e.target.value)}><option value="">Escolha um arquivo</option>{details.files.map(f => <option key={f.rel} value={f.rel}>{f.rel}</option>)}</select><small>Scripts embutidos no .blend ficam desativados (-Y).</small></label>
        {action === 'render' && <>
          <label>Prefixo de saída relativo ao projeto<input aria-label="Prefixo de saída do render Blender" required value={output} disabled={busy} maxLength={2000} placeholder="renders/quadro_" onChange={e => on(setOutput)(e.target.value)} /><small>A pasta precisa existir. O Blender acrescenta o quadro e .png (ex.: renders/quadro_0001.png); o arquivo precisa ser novo.</small></label>
          <label>Quadro<input aria-label="Quadro a renderizar" type="number" min={0} step={1} required value={frame} disabled={busy} onChange={e => on(setFrame)(e.target.value)} /></label>
        </>}
        {action === 'export' && <label>Novo arquivo relativo ao projeto<input aria-label="Saída glTF do Blender" required value={output} disabled={busy} maxLength={2000} placeholder="exports/modelo.glb" onChange={e => on(setOutput)(e.target.value)} /><small>Usa o exportador glTF padrão, sem add-ons do usuário. Use um destino novo em uma pasta existente.</small></label>}
        {action === 'script' && <label>Script Python relativo ao projeto<input aria-label="Script Python do Blender" required value={script} disabled={busy} maxLength={2000} placeholder="tools/ajustar.py" onChange={e => on(setScript)(e.target.value)} /><small>O script roda com as suas permissões e pode alterar ou salvar arquivos. O conteúdo aparece para revisão antes de executar.</small></label>}
        {action === 'open' && <p className="muted">Abre a interface do Blender; salve pelo próprio Blender.</p>}
        <button disabled={blocked || !ready}>Preparar comando para revisão</button>
      </form>
    }}
    footer={<p className="muted">Resultados ficam na pasta desta tarefa. Revise o arquivo gerado antes de registrá-lo em Produção → Assets; após a revisão humana, integre a worktree no painel de branches.</p>}
  />
}
