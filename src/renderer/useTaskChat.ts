import { useEffect, useRef, useState, type RefObject } from 'react'
import { api, errText, onChat, type Sel, type TaskChat } from './api'

type Live = { occupied: number; capacity: number | null; estimated: boolean; source?: string }

// Conversa de uma tarefa (chat e pagina LinkedIn): historico, streaming, eventos e rolagem.
// As opcoes ficam num ref: o listener de eventos e inscrito por tarefa e sempre ve a escolha e os callbacks atuais.
export function useTaskChat(taskId: number, o: {
  sel: () => Sel // funcao: a pagina LinkedIn deriva a escolha do proprio historico
  msgs: RefObject<HTMLDivElement | null>
  stick?: RefObject<boolean> // sem ele, sempre acompanha o fim
  onError: (e: string) => void
  onLoaded?: (h: TaskChat) => void
  onStart?: () => void // execucao iniciada por fora desta tela
  onDone?: (loaded: Promise<void>) => void
  onMetric?: (m: Live) => void
}) {
  const [hist, setHist] = useState<TaskChat | null>(null)
  const [live, setLive] = useState('')
  const opts = useRef(o)
  opts.current = o
  const req = useRef(0) // descarta respostas antigas (troca rapida de tarefa/provedor)

  const load = (): Promise<void> => {
    if (!taskId) return Promise.resolve()
    const n = ++req.current
    return api.taskChat(taskId, opts.current.sel()).then(h => {
      if (n !== req.current) return
      setHist(h)
      setLive(h.live || (h.running ? '…' : '')) // volta a mostrar o streaming de uma execucao ativa
      opts.current.onLoaded?.(h)
    }, (e: unknown) => opts.current.onError(errText(e)))
  }
  const send = (text: string, images: string[] = [], stepId?: number) =>
    api.sendTask(taskId, opts.current.sel(), text, images, stepId).then(() => { load() })

  useEffect(() => onChat(ev => {
    if (ev.taskId !== taskId) return
    const o = opts.current
    if (ev.refresh) return void load() // delegacao iniciou/terminou: mensagem de sistema nova
    if (ev.metric) return void o.onMetric?.(ev.metric)
    if (ev.done) return void (o.onDone ? o.onDone(load()) : load()) // load() limpa o streaming junto com a mensagem final
    if (typeof ev.text !== 'string') return // pedidos de permissao/contexto tambem trazem taskId, mas nao sao texto: nao apagam o streaming
    setLive(ev.text)
    setHist(h => { if (h && !h.running) { o.onStart?.(); return { ...h, running: true } } return h })
  }), [taskId])
  useEffect(() => {
    const m = opts.current.msgs.current
    if (m && (opts.current.stick?.current ?? true)) m.scrollTop = m.scrollHeight
  }, [hist, live])

  return { hist, setHist, live, load, send }
}
