import { useState } from 'react'
import type { CommandRunSummary, ProjectCommand } from '../main/commands'
import type { UnityAction, UnityDetails, UnityTarget } from '../main/unityFlow'
import { EnginePanel } from './EnginePanel'

const actionLabels: Record<UnityAction, string> = { compile: 'Importar e compilar (batchmode)', test: 'Executar testes (Test Runner)', build: 'Gerar build do player', method: 'Executar método estático (-executeMethod)', editor: 'Abrir no editor' }
const targets: Record<UnityTarget, string> = { Win64: 'Windows 64 bits (.exe)', OSXUniversal: 'macOS (.app)', Linux64: 'Linux 64 bits (.x86_64)' }
// Versão não identificada (fora do layout do Hub) não gera aviso: compare manualmente.
const mismatch = (project: string | null, probed?: string) => !!project && !!probed && /^\d/.test(probed) && project !== probed
const stamp = () => new Date().toISOString().slice(0, 19).replace(/\D/g, '')

export function UnityPanel(props: { taskId: number; game: string; disabled: boolean; commands: ProjectCommand[]; runs: CommandRunSummary[]; onPrepared: () => Promise<void> }) {
  const [action, setAction] = useState<UnityAction>('compile'), [platform, setPlatform] = useState('EditMode'), [filter, setFilter] = useState(''), [results, setResults] = useState('')
  const [target, setTarget] = useState<UnityTarget>('Win64'), [output, setOutput] = useState(''), [method, setMethod] = useState(''), [log, setLog] = useState('')
  return <EnginePanel<UnityDetails> {...props} engine="unity" label="Unity"
    facts={(details, probe) => <>
      <dl className="godot-facts">
        <div><dt>Editor do projeto</dt><dd>{details.editor ?? 'Não informado'}{probe && ` · instalação ${probe.version}`}</dd></div>
        <div><dt>Render pipeline</dt><dd>{details.pipeline}</dd></div>
        <div><dt>Cenas no build</dt><dd>{details.enabledScenes} ativa(s) de {details.scenes}</dd></div>
        <div><dt>Assemblies de teste</dt><dd>{details.testAssemblies.join(', ') || 'Nenhum'}</dd></div>
      </dl>
      {mismatch(details.editor, probe?.version) && <p className="err">O projeto usa Unity {details.editor}; abrir com {probe!.version} pode reimportar e atualizar arquivos do projeto.</p>}
      {details.warnings.map(w => <p key={w} className="muted">{w}</p>)}
    </>}
    form={({ busy, blocked, details, prepare, changed }) => {
      const on = <T,>(set: (v: T) => void) => (v: T) => { set(v); changed() }
      const batch = action !== 'editor'
      const ready = action === 'build' ? !!output.trim() && details.enabledScenes > 0 : action === 'method' ? /^(?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*$/.test(method.trim()) : true
      const submit = () => {
        const s = stamp(), args = { ...(batch ? { log: log.trim() || `unity-${action}-${s}.log` } : {}), ...(action === 'test' ? { platform, results: results.trim() || `unity-tests-${s}.xml`, ...(filter.trim() ? { filter: filter.trim() } : {}) } : {}), ...(action === 'build' ? { target, output: output.trim() } : {}), ...(action === 'method' ? { method: method.trim() } : {}) }
        prepare(action, args); setLog(''); setResults('')
      }
      return <form onSubmit={e => { e.preventDefault(); if (ready) submit() }}>
        <label>Ação local<select aria-label="Ação Unity" value={action} disabled={busy} onChange={e => { on(setAction)(e.target.value as UnityAction); setOutput('') }}>{Object.entries(actionLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
        {action === 'compile' && <p className="muted">Abre o projeto sem janela, importa os assets e compila os scripts; erros de compilação fazem o comando falhar.</p>}
        {action === 'test' && <>
          <label>Plataforma<select aria-label="Plataforma dos testes Unity" value={platform} disabled={busy} onChange={e => on(setPlatform)(e.target.value)}><option value="EditMode">EditMode</option><option value="PlayMode">PlayMode</option></select></label>
          <label>Filtro (opcional)<input aria-label="Filtro dos testes Unity" value={filter} disabled={busy} maxLength={500} placeholder="MeuJogo.Testes;OutroTeste" onChange={e => on(setFilter)(e.target.value)} /><small>Nomes completos separados por ";" ou expressão regular, como em -testFilter.</small></label>
          <label>Resultados NUnit (opcional)<input aria-label="Resultados XML dos testes Unity" value={results} disabled={busy} maxLength={2000} placeholder="Vazio: unity-tests-<data>.xml na raiz" onChange={e => on(setResults)(e.target.value)} /><small>Arquivo .xml novo; testes que falham reprovam o comando mesmo com exit 0.</small></label>
        </>}
        {action === 'build' && <>
          <label>Alvo<select aria-label="Alvo do build Unity" value={target} disabled={busy} onChange={e => { on(setTarget)(e.target.value as UnityTarget); setOutput('') }}>{Object.entries(targets).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
          <label>Destino relativo ao projeto<input aria-label="Destino do build Unity" required value={output} disabled={busy} maxLength={2000} placeholder={`Builds/${target}/Jogo${target === 'Win64' ? '.exe' : target === 'OSXUniversal' ? '.app' : '.x86_64'}`} onChange={e => on(setOutput)(e.target.value)} /><small>Pasta vazia, ou nova dentro de uma existente, fora de Assets/: o Unity grava vários arquivos ao lado do executável. Usa as cenas ativas em Build Settings e exige o módulo da plataforma instalado.</small></label>
          {!details.enabledScenes && <p className="err">Nenhuma cena ativa em Build Settings; o Unity não gera o player.</p>}
        </>}
        {action === 'method' && <label>Método estático<input aria-label="Método Unity a executar" required value={method} disabled={busy} maxLength={300} placeholder="MeuJogo.Editor.Ferramentas.Executar" onChange={e => on(setMethod)(e.target.value)} /><small>Namespace.Classe.Metodo de um .cs em Assets/. O código roda com as suas permissões; o arquivo aparece para revisão e editá-lo depois recusa a execução.</small></label>}
        {batch && <label>Arquivo de log (opcional)<input aria-label="Arquivo de log Unity" value={log} disabled={busy} maxLength={2000} placeholder="Vazio: unity-<ação>-<data>.log na raiz" onChange={e => on(setLog)(e.target.value)} /><small>Arquivo .log novo fora de Assets/, Library/ e Logs/; os diagnósticos e a ferramenta unity_diagnostics leem este arquivo.</small></label>}
        {action === 'editor' && <p className="muted">Abre a interface do Unity neste projeto; salve pelo próprio editor.</p>}
        <button disabled={blocked || !ready}>Preparar comando para revisão</button>
      </form>
    }}
    footer={<p className="muted">Toda ação abre o projeto: scripts de editor ([InitializeOnLoad], pós-processadores) rodam sem revisão pelo painel. A primeira importação pode levar vários minutos. Revise builds e logs antes de registrá-los em Produção; após a revisão humana, integre a worktree no painel de branches.</p>}
  />
}
