import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeProjects } from './claudeProjects.ts'

test('projetos do Claude: relido so quando tamanho ou mtime mudam; JSON invalido nao fica em cache', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-claudejson-')), file = path.join(dir, '.claude.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (projects: string[], mtime: number) => { fs.writeFileSync(file, JSON.stringify({ projects: Object.fromEntries(projects.map(p => [p, {}])) })); fs.utimesSync(file, mtime, mtime) }
  write(['/u/a', '/u/b'], 1000)
  const reads = t.mock.method(fs, 'readFileSync')
  for (let i = 0; i < 64; i++) assert.deepEqual(claudeProjects(file), ['/u/a', '/u/b'])
  assert.equal(reads.mock.calls.length, 1)
  write(['/u/a', '/u/c'], 1000) // mesmo tamanho e mtime restaurado: ainda o cache (limite conhecido do criterio)
  assert.deepEqual(claudeProjects(file), ['/u/a', '/u/b'])
  write(['/u/a', '/u/c'], 2000)
  assert.deepEqual(claudeProjects(file), ['/u/a', '/u/c']); assert.equal(reads.mock.calls.length, 2)
  fs.writeFileSync(file, '{"projects":'); fs.utimesSync(file, 3000, 3000) // gravacao pela metade
  assert.deepEqual(claudeProjects(file), []); assert.deepEqual(claudeProjects(file), []); assert.equal(reads.mock.calls.length, 4)
  fs.rmSync(file); assert.deepEqual(claudeProjects(file), [])
})
