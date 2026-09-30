// Receitas Blender para o fluxo preparado (engineFlow): argumentos explícitos, caminhos relativos dentro do projeto e saídas novas.
import fs from 'node:fs'
import path from 'node:path'
import { normalizeCommand, type ProjectCommand } from './commands.ts'
import { blenderDiagnostics, blenderProbe, listBlendFiles, readBlendHeader } from './blender.ts'
import { safeJoin } from './guard.ts'
import type { EngineRecipe } from './engineFlow.ts'

export type BlenderAction = 'render' | 'script' | 'export' | 'open'
export type BlenderArgs = { file?: string; script?: string; output?: string; frame?: number }
export type BlenderDetails = { files: { rel: string; size: number; version: string | null; backups: number }[]; truncated: boolean }
const INTERNAL = ['.git', '.worktrees', 'node_modules']
const NAMES: Record<BlenderAction, string> = { render: 'Blender · Renderizar quadro', script: 'Blender · Executar script Python', export: 'Blender · Exportar glTF', open: 'Blender · Abrir no Blender' }
const posix = (p: string) => p.split(path.sep).join('/')
const exists = (p: string) => !!fs.lstatSync(p, { throwIfNoEntry: false })

// Relativo, dentro do projeto (links resolvidos), sem "..", pastas internas, controle ou "-" inicial (seria lido como opção).
function relPath(cwd: string, value: unknown, what: string): { abs: string; rel: string } {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw Error(`Informe ${what}.`)
  const bad = (r: string) => r.startsWith('-') || r.split('/').some(p => p === '..' || INTERNAL.includes(p)), input = value.replace(/\\/g, '/')
  const refuse = () => { throw Error(`${what[0].toUpperCase() + what.slice(1)} deve ser relativo ao projeto, sem ".." nem pastas internas.`) }
  if (path.isAbsolute(input) || /^[a-z]:/i.test(input) || bad(input)) refuse()
  const abs = safeJoin(cwd, input), rel = posix(path.relative(fs.realpathSync(cwd), abs))
  if (bad(rel)) refuse() // o caminho real (links resolvidos) também não pode apontar para pasta interna nem parecer opção
  return { abs, rel }
}
function existing(cwd: string, value: unknown, ext: RegExp, what: string) {
  const p = relPath(cwd, value, what)
  if (!ext.test(p.rel) || !fs.statSync(p.abs, { throwIfNoEntry: false })?.isFile()) throw Error(`${what[0].toUpperCase() + what.slice(1)} inexistente ou com extensão errada.`)
  return p.rel
}
// Saída nova: pasta existente, arquivo ainda inexistente (preserva resultados anteriores).
function fresh(dir: string, file: string) {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw Error('Crie a pasta de saída antes de preparar.')
  if (exists(file)) throw Error('Destino já existe; escolha um arquivo novo para preservar o resultado anterior.')
}
const frameFile = (prefix: string, frame: string) => `${prefix}${frame.padStart(4, '0')}.png`
const EXPORT = /^import bpy; bpy\.ops\.export_scene\.gltf\(filepath=("(?:[^"\\]|\\.)*"), export_format='GLB'\)$/

export function blenderCommand(cwd: string, executable: string, action: string, a: BlenderArgs): ProjectCommand {
  const blend = existing(cwd, a.file, /\.blend$/i, 'o arquivo .blend')
  let args: string[], purpose: ProjectCommand['purpose'] = 'build'
  switch (action) {
    case 'render': {
      const frame = a.frame ?? 1
      if (!Number.isSafeInteger(frame) || frame < 0 || frame > 1_048_574) throw Error('Quadro inválido.')
      if (typeof a.output === 'string' && /[#{}]/.test(a.output)) throw Error('O prefixo de saída não pode conter #, { ou }; o número do quadro é acrescentado automaticamente.')
      const dirOnly = typeof a.output === 'string' && /[\\/]$/.test(a.output), out = relPath(cwd, a.output, 'o prefixo de saída')
      const prefix = dirOnly ? out.rel + '/' : out.rel
      fresh(dirOnly ? out.abs : path.dirname(out.abs), safeJoin(cwd, frameFile(prefix, String(frame))))
      args = ['-b', '-Y', blend, '-o', prefix + '####', '-F', 'PNG', '-x', '1', '-f', String(frame)]; break
    }
    case 'script': args = ['-b', '-Y', blend, '--python-exit-code', '1', '--python', existing(cwd, a.script, /\.py$/i, 'o script .py')]; purpose = 'test'; break
    case 'export': {
      const out = relPath(cwd, a.output, 'o arquivo .glb de saída')
      if (!/\.glb$/i.test(out.rel)) throw Error('A exportação glTF gera um arquivo .glb.')
      fresh(path.dirname(out.abs), out.abs)
      // Expressão fixa: a única parte variável é o caminho, como literal JSON (também um literal Python válido).
      args = ['-b', '--factory-startup', '-Y', blend, '--python-exit-code', '1', '--python-expr', `import bpy; bpy.ops.export_scene.gltf(filepath=${JSON.stringify(out.rel)}, export_format='GLB')`]; break
    }
    case 'open': args = ['-Y', blend]; purpose = 'run'; break
    default: throw Error('Ação Blender inválida.')
  }
  return normalizeCommand({ name: NAMES[action as BlenderAction], purpose, program: executable, args })
}

// Arquivos que a execução deve produzir (derivados dos próprios argumentos gerados acima).
export function blenderOutputs(command: ProjectCommand): string[] {
  const a = command.args, at = (flag: string) => a[a.indexOf(flag) + 1]
  if (command.name === NAMES.render) return [frameFile(at('-o').replace(/#+$/, ''), at('-f'))]
  const m = command.name === NAMES.export ? EXPORT.exec(at('--python-expr')) : null
  return m ? [JSON.parse(m[1])] : []
}

export const BLENDER_RECIPE: EngineRecipe = {
  actions: ['render', 'script', 'export', 'open'],
  fields: { file: 'string', script: 'string', output: 'string', frame: 'integer' },
  probe: blenderProbe,
  build: (cwd, exe, action, args) => {
    const command = blenderCommand(cwd, exe, action, args as BlenderArgs)
    return { command, pins: action === 'script' ? [command.args[command.args.length - 1]] : [] }
  },
  outputs: blenderOutputs,
  diagnostics: blenderDiagnostics,
  details: async (cwd): Promise<BlenderDetails> => {
    const list = listBlendFiles(cwd, () => true, INTERNAL, 20_000, 200)
    const files = await Promise.all(list.files.map(async f => ({ rel: f.rel, size: f.size, backups: f.backups, version: (await readBlendHeader(f.abs).catch(() => null))?.version ?? null })))
    return { files, truncated: list.truncated }
  }
}
