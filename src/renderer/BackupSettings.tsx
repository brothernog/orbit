import { useState } from 'react'
import { api, errText } from './api'
import { useCachedRead } from './useCachedRead'
import './backup.css'

type Backup = { path: string; createdAt: string; files: number; bytes: number; schema: number }
type Info = { dataDir: string; lastRestore?: { restoredAt: string; safetyPath: string } | null }

function BackupSummary({ value }: { value: Backup }) {
  return <dl className="backup-summary">
    <div><dt>Pasta</dt><dd className="backup-path">{value.path}</dd></div>
    <div><dt>Criado em</dt><dd>{new Date(value.createdAt).toLocaleString('pt-BR')}</dd></div>
    <div><dt>Conteúdo</dt><dd>{value.files.toLocaleString('pt-BR')} arquivos · {(value.bytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MiB · banco v{value.schema}</dd></div>
  </dl>
}

export function BackupSettings() {
  const read = useCachedRead<Info>('backupInfo', () => api.backupInfo())
  const info = read.data
  const [created, setCreated] = useState<Backup | null>(null)
  const [selected, setSelected] = useState<(Backup & { token: string }) | null>(null)
  const [operation, setBusy] = useState('')
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  const busy = operation || (!info && !read.error ? 'Carregando dados…' : '')

  const create = async () => {
    setErr(''); setBusy('Criando backup…')
    try {
      const result = await api.createBackup()
      if (result) setCreated(result)
    } catch (e) { setErr(errText(e)) }
    finally { setBusy('') }
  }
  const select = async () => {
    setErr(''); setBusy('Verificando backup…')
    try {
      const result = await api.selectBackup()
      if (result) setSelected(result)
    } catch (e) { setSelected(null); setErr(errText(e)) }
    finally { setBusy('') }
  }
  const restore = async () => {
    if (!selected) return
    setErr(''); setBusy('Preparando restauração…')
    try {
      if (await api.restoreBackup(selected.token)) { setBusy('Reiniciando para restaurar…'); return }
    } catch (e) { setErr(errText(e)) }
    setBusy('')
  }

  return <div className="backup-settings" aria-busy={!!busy}>
    <section>
      <h2>Backup dos dados</h2>
      <p className="backup-lede">Guarde o banco, os anexos das conversas, os snapshots de assets e builds, as screenshots dos playtests e o perfil, rascunhos e vídeos do LinkedIn em uma pasta local.</p>
      <p className="backup-exclusions">Credenciais das CLIs e do LinkedIn ficam fora do backup. Arquivos dos jogos e worktrees precisam de uma cópia própria.</p>
      {info && <p className="backup-current"><span>Dados nesta instalação</span><span className="backup-path">{info.dataDir}</span></p>}
      <div className="backup-actions"><button type="button" className="primary" disabled={!!busy} onClick={create}>Criar backup…</button></div>
      {created && <div className="backup-result"><p className="backup-success" role="status">Backup criado.</p><BackupSummary value={created} /></div>}
    </section>
    <section>
      <h2>Restaurar um backup</h2>
      <p className="backup-lede">Selecione a pasta do backup para verificar o conteúdo antes de restaurar.</p>
      <div className="backup-actions"><button type="button" disabled={!!busy} onClick={select}>Selecionar backup…</button></div>
      {selected && <div className="backup-result">
        <h3>Backup selecionado</h3>
        <BackupSummary value={selected} />
        <p className="backup-warning">A restauração substitui os dados atuais do aplicativo e reinicia a Órbita. Uma cópia de segurança dos dados atuais será guardada antes da troca. As conversas começarão sessões de IA novas. Depois, reconecte o LinkedIn.</p>
        <div className="backup-actions"><button type="button" className="backup-restore-btn" disabled={!!busy} onClick={restore}>Restaurar e reiniciar</button></div>
      </div>}
      {info?.lastRestore && <div className="backup-result">
        <p>Última restauração: {new Date(info.lastRestore.restoredAt).toLocaleString('pt-BR')}</p>
        <small>Cópia de segurança anterior</small>
        <p className="backup-path">{info.lastRestore.safetyPath}</p>
      </div>}
    </section>
    {busy && <p className="backup-status" role="status">{busy}</p>}
    {err && <p className="err backup-status" role="alert">{err}</p>}
  </div>
}
