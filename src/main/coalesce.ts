// Junta atualizacoes de "valor completo" (ex.: texto acumulado do streaming) numa cadencia curta: so o mais recente sai.
// A primeira sai na hora; as seguintes esperam no maximo `ms`. close() entrega o pendente na hora e ignora o que chegar depois,
// entao nada antigo aparece depois do fim (nem fora de ordem: cada envio e sempre o valor mais novo).
export function coalesce<T>(emit: (v: T) => void, ms: number) {
  let pending: { v: T } | undefined, timer: ReturnType<typeof setTimeout> | undefined, last = -Infinity, closed = false
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (!pending) return
    const { v } = pending
    pending = undefined; last = Date.now()
    emit(v)
  }
  return {
    push(v: T) {
      if (closed) return
      pending = { v }
      if (timer) return
      const wait = last + ms - Date.now()
      if (wait <= 0) flush(); else timer = setTimeout(flush, wait)
    },
    flush,
    close() { flush(); closed = true },
  }
}
