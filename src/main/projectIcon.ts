// Icone do projeto lido da propria pasta (Godot, web, Electron, Android...). So leitura local, sem IA; nunca sai da pasta do projeto.
import fs from 'node:fs'
import path from 'node:path'

const CANDIDATES = [
  'icon.svg', 'icon.png', 'favicon.svg', 'favicon.png', 'favicon.ico',
  'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico', 'public/icon.png', 'static/favicon.png', 'static/favicon.ico',
  'assets/icon.png', 'assets/icon.svg', 'build/icon.png', 'resources/icon.png', 'src/assets/icon.png', 'Assets/icon.png',
  'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
]
const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const MAX = 512 * 1024

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

export function findProjectIcon(root: string): string | null {
  const base = path.resolve(root)
  const godot = /^config\/icon="res:\/\/([^"]+)"/m.exec(read(path.join(base, 'project.godot')))?.[1] // Godot declara o icone no projeto
  let builder: string | undefined
  try { builder = JSON.parse(read(path.join(base, 'package.json')) || '{}').build?.icon } catch {} // electron-builder
  for (const rel of [godot, builder, ...CANDIDATES]) {
    if (typeof rel !== 'string' || !rel) continue
    const p = path.resolve(base, rel)
    if (!p.startsWith(base + path.sep) || !MIME[path.extname(p).toLowerCase()]) continue // nada fora da pasta, so imagem
    try { const s = fs.statSync(p); if (s.isFile() && s.size > 0 && s.size <= MAX) return p } catch {}
  }
  return null
}

export function projectIconData(root: string): string | null {
  const p = findProjectIcon(root)
  if (!p) return null
  try { return `data:${MIME[path.extname(p).toLowerCase()]};base64,${fs.readFileSync(p).toString('base64')}` } catch { return null }
}
