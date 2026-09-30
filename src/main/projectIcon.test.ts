import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findProjectIcon, projectIconData } from './projectIcon.ts'

test('icone do projeto: Godot primeiro, depois candidatos comuns; nunca fora da pasta nem arquivo que nao e imagem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-icon-'))
  const put = (rel: string, data = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data) }
  assert.equal(findProjectIcon(root), null)
  put('public/favicon.ico')
  assert.equal(findProjectIcon(root), path.join(root, 'public', 'favicon.ico'))
  put('art/logo.png')
  put('project.godot', 'config/name="Jogo"\nconfig/icon="res://art/logo.png"\n')
  assert.equal(findProjectIcon(root), path.join(root, 'art', 'logo.png'))
  put('project.godot', 'config/icon="res://../fora.png"\n') // tentativa de sair da pasta: ignorada
  fs.writeFileSync(path.join(path.dirname(root), 'fora.png'), 'x')
  assert.equal(findProjectIcon(root), path.join(root, 'public', 'favicon.ico'))
  put('package.json', JSON.stringify({ build: { icon: 'segredo.txt' } })) // nao e imagem: ignorado
  put('segredo.txt')
  assert.equal(findProjectIcon(root), path.join(root, 'public', 'favicon.ico'))
  assert.match(projectIconData(root)!, /^data:image\/x-icon;base64,/)
  try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.join(path.dirname(root), 'fora.png')) } catch {}
})
