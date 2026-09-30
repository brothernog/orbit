import { fail } from './guard.ts'

// ponytail: pausa global no IPC para backup/restauração e retenção; manutenção em background pediria coordenação por recurso.
export function backupGate(assertIdle: () => void) {
  let pending = 0, locked = false, restarting = false
  let drained: (() => void) | undefined
  return {
    async invoke<T>(fn: () => T | Promise<T>): Promise<T> {
      if (locked || restarting) fail('Manutenção dos dados em andamento. Aguarde a conclusão.')
      pending++
      try { return await fn() } finally { pending--; drained?.() }
    },
    async exclusive<T>(fn: () => T | Promise<T>, waitForPending = false): Promise<T> {
      if (locked || restarting || (pending > 1 && !waitForPending)) fail('Aguarde as operações pendentes antes da manutenção dos dados.')
      assertIdle()
      locked = true
      try {
        if (pending > 1) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { drained = undefined; reject(Error('Aguarde as operações pendentes antes da manutenção dos dados.')) }, 10_000)
          drained = () => { if (pending <= 1) { clearTimeout(timer); drained = undefined; resolve() } }
          drained()
        })
        assertIdle() // uma preparação de envio pode ter iniciado uma CLI durante a espera
        return await fn()
      } finally { locked = false }
    },
    restarting: () => { restarting = true }
  }
}
