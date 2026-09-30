// Comandos locais explícitos, sem shell, com histórico e cancelamento de árvore.
import type { DatabaseSync } from 'node:sqlite'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { cliSpawn, killTree, resolveCli } from './providers.ts'
import type { WorkspaceGuard } from './delegation.ts'
import { pathKey, sameKey as same } from './guard.ts'

export type ProjectCommand = { name: string; purpose: 'test' | 'build' | 'run'; program: string; args: string[] }
export type CommandRun = { id: number; task_id: number; workspace: string; name: string; program: string; args: string; status: string; output: string; truncated: number; exit_code: number | null; duration_ms: number | null; error: string | null; started_at: string }
export type CommandRunSummary = Omit<CommandRun, 'output'>
const summaryColumns = 'id,task_id,workspace,name,program,args,status,truncated,exit_code,duration_ms,error,started_at'
// Chave gravada: no Windows/macOS segue minuscula como nos bancos existentes.
const key = (game: string) => 'commands:' + pathKey(game)
export function normalizeCommand(raw: any): ProjectCommand {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100 || !['test','build','run'].includes(raw.purpose) || typeof raw.program !== 'string' || !raw.program.trim() || raw.program.length > 2000 || /[\0\r\n]/.test(raw.program) || !Array.isArray(raw.args) || raw.args.length > 100 || raw.args.some((a: unknown) => typeof a !== 'string' || a.length > 10000 || a.includes('\0'))) throw Error('Comando inválido: nome, programa e argumentos (array JSON) são obrigatórios.')
  const program = raw.program.trim()
  if (/\.(cmd|bat)$/i.test(program) || /^(cmd|powershell|pwsh|sh|bash)(\.exe)?$/i.test(path.basename(program).replace(/[. ]+$/, ''))) throw Error('Use um executável direto, sem shell. Para npm: node.exe e o caminho de npm-cli.js como primeiro argumento.')
  return { name: raw.name.trim(), purpose: raw.purpose, program, args: raw.args }
}
export function projectCommands(db: DatabaseSync, game: string): ProjectCommand[] {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key(game)) as any
  return row ? JSON.parse(row.value) : []
}
export function saveCommands(db: DatabaseSync, game: string, raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 12) throw Error('No máximo 12 comandos por projeto.')
  const commands = raw.map(normalizeCommand)
  if (new Set(commands.map(c => c.name.toLowerCase())).size !== commands.length) throw Error('Nomes de comandos repetidos.')
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key(game), JSON.stringify(commands))
  return commands
}
export const listCommandRuns = (db: DatabaseSync, taskId: number) => db.prepare(`SELECT ${summaryColumns} FROM command_runs WHERE task_id=? ORDER BY id DESC LIMIT 20`).all(taskId) as CommandRunSummary[]
export const commandRun = (db: DatabaseSync, taskId: number, id: number) => db.prepare('SELECT * FROM command_runs WHERE task_id=? AND id=?').get(taskId, id) as CommandRun | undefined
// Offsets em unidades UTF-16, como String.length/slice no renderer. Não aceitamos avançar além da saída persistida.
// `live`: saída em memória de uma execução ativa desta tarefa; o SQLite só é lido quando ela já terminou.
export function commandOutput(db: DatabaseSync, taskId: number, id: number, offset = 0, live?: { output: string; truncated: number }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw Error('Offset de saída inválido.')
  const run = live ?? commandRun(db, taskId, id)
  if (!run) throw Error('Comando de outra tarefa ou inexistente.')
  if (offset > run.output.length) throw Error('Offset além da saída disponível.')
  return { offset, output: run.output.slice(offset), total: run.output.length, truncated: run.truncated }
}
// Enquanto o comando roda, a saída acumulada (até 1.000.000 caracteres) fica em memória e é servida dali;
// o SQLite recebe uma cópia a cada PERSIST_MS (recuperação após queda) e sempre no fim, antes do evento de conclusão.
export const PERSIST_MS = 5000
export function reconcileCommands(db: DatabaseSync) {
  db.prepare("UPDATE command_runs SET status='failed',error='Execução interrompida pelo fechamento do app.',ended_at=CURRENT_TIMESTAMP WHERE status='running'").run()
}
export function createCommandService(db: DatabaseSync, guard: WorkspaceGuard, agentsBusy: (cwd: string) => boolean, emit: (ev: object) => void, checks: {
  beforeSpawn?: (taskId: number, game: string, cwd: string, command: ProjectCommand) => void | Promise<void>
  resultError?: (command: ProjectCommand, output: string, truncated: boolean, cwd: string) => string | undefined
} = {}) {
  const active = new Map<number, { cwd: string; taskId: number; cancel: (sync?: boolean) => void; live: () => { output: string; truncated: number } }>()
  const busy = (cwd: string) => [...active.values()].some(r => same(r.cwd,cwd))
  async function start(taskId: number, game: string, cwd: string, name: string) {
    const task = db.prepare('SELECT game FROM tasks WHERE id=?').get(taskId) as any
    if (!task || !same(task.game,game)) throw Error('Comando de outro projeto ou tarefa inexistente.')
    const cmd = projectCommands(db,game).find(c => c.name === name)
    if (!cmd) throw Error('Salve o comando antes de executar.')
    await checks.beforeSpawn?.(taskId, game, cwd, cmd)
    if (busy(cwd) || agentsBusy(cwd)) throw Error('Pare a execução atual nesta pasta antes de executar um comando local.')
    const lockId = -taskId
    const blocked = guard.acquireEdit(cwd,taskId,lockId,false)
    if (blocked) throw Error(blocked)
    let id: number
    try { id = Number(db.prepare('INSERT INTO command_runs(task_id,workspace,name,program,args) VALUES (?,?,?,?,?)').run(taskId,cwd,cmd.name,cmd.program,JSON.stringify(cmd.args)).lastInsertRowid) }
    catch(e) { guard.release(cwd,lockId); throw e }
    const started=Date.now(); let child: ChildProcess | undefined, output='', truncated=false, stopped=false, finished=false, timer: NodeJS.Timeout | undefined, timeoutError: string | undefined, flushTimer: NodeJS.Timeout | undefined, flushedLength=0, flushedTruncated=false, persistedLength=0, persistedTruncated=false, persistedAt=started
    const notify=()=>emit({ taskId, game, commandChanged: true, commandRun: db.prepare(`SELECT ${summaryColumns} FROM command_runs WHERE id=?`).get(id) as CommandRunSummary })
    const flush=(final=false)=>{
      if(flushTimer)clearTimeout(flushTimer);flushTimer=undefined
      if((final||Date.now()-persistedAt>=PERSIST_MS)&&(output.length!==persistedLength||truncated!==persistedTruncated)){
        db.prepare('UPDATE command_runs SET output=?,truncated=? WHERE id=?').run(output,truncated?1:0,id)
        persistedLength=output.length;persistedTruncated=truncated;persistedAt=Date.now()
      }
      if(output.length===flushedLength&&truncated===flushedTruncated)return
      flushedLength=output.length;flushedTruncated=truncated
      emit({taskId,game,commandOutput:{id,outputLength:output.length,truncated}})
    }
    const finish=(code: number|null,error?: string)=>{
      if(finished)return;finished=true;if(timer)clearTimeout(timer);flush(true)
      if (!stopped && !error) try { error = checks.resultError?.(cmd, output, truncated, cwd) } catch { error = 'Não foi possível verificar a saída do comando.' }
      db.prepare('UPDATE command_runs SET status=?,exit_code=?,duration_ms=?,error=?,ended_at=CURRENT_TIMESTAMP WHERE id=?').run(stopped?'cancelled':error||code!==0?'failed':'completed',code,Date.now()-started,error??null,id)
      active.delete(id);guard.release(cwd,lockId);notify()
      // Para o aviso de atencao (notify.ts): so o fim de verdade, com exit code e o final da saida.
      emit({ taskId, game, commandDone: { id, name: cmd.name, purpose: cmd.purpose, status: stopped ? 'cancelled' : error || code !== 0 ? 'failed' : 'completed', exitCode: code, durationMs: Date.now() - started, error: error ?? null, output: output.slice(-20_000) } })
    }
    const cancel=(sync=false)=>{stopped=true;if(child){killTree(child,sync);if(sync)finish(null)}else finish(null)}
    active.set(id,{cwd,taskId,cancel,live:()=>({output,truncated:truncated?1:0})});notify()
    // A resolução não bloqueia o IPC; o cancelamento antes do spawn continua efetivo.
    void (async()=>{
      try {
        const exe=path.isAbsolute(cmd.program)?cmd.program:await resolveCli(cmd.program)
        if(finished)return
        if(!exe)throw Error('Executável não encontrado no PATH.')
        normalizeCommand({...cmd,program:exe})
        await checks.beforeSpawn?.(taskId, game, cwd, cmd) // resolução assíncrona: revalidar destino e arquivos imediatamente antes de executar
        if(finished)return // cancelado durante a revalidação
        // Dentro do Electron, node.exe pode resolver para o próprio runtime: permitir scripts locais sem abrir outra janela do app.
        child=cliSpawn(exe,cmd.args,{cwd,env:{...process.env,PWD:cwd,ELECTRON_RUN_AS_NODE:'1'}}) // PWD: o Blender resolve caminhos relativos por $PWD, não pelo cwd
        child.stdin?.on('error',()=>{});child.stdin?.end()
        const append=(text:string)=>{
          const length=output.length,wasTruncated=truncated,remaining=1_000_000-length
          output+=text.slice(0,Math.max(0,remaining));if(text.length>remaining)truncated=true
          if((output.length!==length||truncated!==wasTruncated)&&!flushTimer)flushTimer=setTimeout(flush,150)
        }
        child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8')
        child.stdout?.on('data',append);child.stderr?.on('data',append)
        child.once('error',e=>finish(null,e.message));child.once('close',code=>finish(code,timeoutError))
        timer=setTimeout(()=>{timeoutError='Tempo limite do comando excedido.';if(child)killTree(child)},cmd.purpose==='run'?2*60*60*1000:15*60*1000)
      } catch(e){finish(null,String((e as Error).message))}
    })()
    return id
  }
  const output=(taskId:number,id:number,offset=0)=>{const run=active.get(id);return commandOutput(db,taskId,id,offset,run?.taskId===taskId?run.live():undefined)}
  return {start,busy,output,hasTask:(id:number)=>[...active.values()].some(r=>r.taskId===id),cancel:(id:number)=>active.get(id)?.cancel(),stopAll:()=>{for(const r of active.values())r.cancel(true)}}
}
