import { fail } from './guard.ts'

// ponytail: pausa global e curta no IPC; backups em background pediriam um coordenador de snapshots.
export function backupGate(assertIdle: () => void) {
  let pending = 0, locked = false, restarting = false
  return {
    async invoke<T>(fn: () => T | Promise<T>): Promise<T> {
      if (locked || restarting) fail('Backup/restauração em andamento. Aguarde a conclusão.')
      pending++
      try { return await fn() } finally { pending-- }
    },
    async exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
      if (locked || restarting || pending > 1) fail('Aguarde as operações pendentes antes de fazer backup/restaurar.')
      assertIdle()
      locked = true
      try { return await fn() } finally { locked = false }
    },
    restarting: () => { restarting = true }
  }
}
