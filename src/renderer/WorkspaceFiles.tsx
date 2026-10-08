import { useEffect, useState } from 'react'
import { api, errText, onChat, type Task } from './api'
import { useCachedRead } from './useCachedRead'
import { FilesPanel } from './FilesPanel'
import { OrbitPanel } from './OrbitPanel'

export function WorkspaceFiles(props: { task: Task; provider?: string; onClose: () => void }) {
  const read = useCachedRead<boolean>('workspaceOrbit', () => api.workspaceOrbit())
  const [error, setError] = useState('')
  useEffect(() => onChat(ev => { if (typeof ev.workspaceOrbit === 'boolean') read.set(ev.workspaceOrbit) }), [read.set])
  const toggle = (enabled: boolean) => api.setWorkspaceOrbit(enabled).then(read.set, e => setError(errText(e)))
  return <>
    {read.data === false
      ? <FilesPanel {...props} onEnableOrbit={() => { void toggle(true) }} />
      : <OrbitPanel {...props} onDisable={() => { void toggle(false) }} />}
    {error && <div className="banner err" role="alert">{error}</div>}
  </>
}
