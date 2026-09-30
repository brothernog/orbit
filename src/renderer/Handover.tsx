import { useState } from 'react'
import { api, errText } from './api'
import { useCachedRead } from './useCachedRead'

// Passagem entre contas quando a cota acaba no meio da resposta (src/main/handover.ts). O usuario escolhe um modo.
type Mode = 'off' | 'prepare' | 'auto'
const MODES: [Mode, string, string][] = [
  ['off', 'Desligada', 'A resposta para quando a conta atinge o limite.'],
  ['prepare', 'Preparar a outra conta', 'Seleciona a conta com mais uso livre e deixa um resumo pronto. Você decide quando continuar.'],
  ['auto', 'Continuar sozinho', 'Faz o mesmo e já envia para a outra conta. O histórico só segue se você aprovar.']
]

export function Handover() {
  const read = useCachedRead<{ mode: Mode }>('getHandover', () => api.getHandover())
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  if (!read.data) return <small>{err || 'Carregando…'}</small>
  const mode = read.data.mode
  return (
    <div className="deleg">
      {MODES.map(([id, title, hint]) => (
        <label key={id} className="check">
          <input type="radio" name="handover" checked={mode === id} onChange={() => api.setHandover({ mode: id }).then(read.set, e => setErr(errText(e)))} />
          <span><b>{title}</b><br /><small>{hint}</small></span>
        </label>
      ))}
      <small title="Arquivos editados, comandos, testes e o fim da resposta.">O resumo é montado pelo app, sem IA e sem gastar tokens. Por enquanto só para Claude.</small>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}
