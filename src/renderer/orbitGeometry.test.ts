import test from 'node:test'
import assert from 'node:assert/strict'
import { facePoint, filePoint, globeFiles, projectPoint, rotatePoint, sphereMesh, travelPoint } from './orbitGeometry.ts'

test('orbit globe: file pins keep their position across order, slash style and additions', () => {
  const first = filePoint('src/main/app.ts')
  assert.deepEqual(first, filePoint('./src\\main\\app.ts'))
  assert.notDeepEqual(first, filePoint('src/main/other.ts'))
  assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-12)
  assert.ok(Math.abs(first[1]) <= .65)
  const displayed = globeFiles([{ path: 'src/main/other.ts' }, { path: 'src/main/app.ts' }], [])
  assert.deepEqual(filePoint(displayed.find(file => file.path.endsWith('app.ts'))!.path), first)
})

test('orbit globe: focus turns the file toward the viewer and projection hides rear pins', () => {
  const point = filePoint('src/main/app.ts'), yaw = facePoint(point)
  const turned = rotatePoint(point, yaw)
  assert.ok(Math.abs(turned[0]) < 1e-12)
  assert.ok(turned[2] > 0)
  const front = projectPoint([0, 0, 1], 0, 400, 240, 80)
  assert.equal(front.x, 200)
  assert.equal(front.front, true)
  assert.equal(projectPoint([0, 0, -1], 0, 400, 240, 80).front, false)
})

test('orbit globe: travel follows an elevated finite arc, including opposite pins', () => {
  const from = [1.1, 0, 0] as const, to = [-1.1, 0, 0] as const
  assert.deepEqual(travelPoint(from, to, 0), from)
  assert.deepEqual(travelPoint(from, to, 1), to)
  for (const progress of [.1, .5, .9]) {
    const point = travelPoint(from, to, progress)
    assert.ok(point.every(Number.isFinite))
    assert.ok(Math.hypot(...point) > 1.1)
  }
  assert.ok(travelPoint(from, from, .5).every(Number.isFinite))
})

test('orbit globe: bounded mesh covers a unit sphere with valid triangle indices', () => {
  const mesh = sphereMesh()
  assert.equal(mesh.positions.length, 25 * 41 * 3)
  assert.equal(mesh.indices.length, 24 * 40 * 6)
  assert.ok(Math.max(...mesh.indices) < mesh.positions.length / 3)
  for (let i = 0; i < mesh.positions.length; i += 3) assert.ok(Math.abs(Math.hypot(...mesh.positions.slice(i, i + 3)) - 1) < 1e-6)
})

test('orbit globe: pin cap retains selected agent files and edited files without duplicates', () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}.ts`, hot: i === 80 }))
  const selected = globeFiles([...files, files[99]], ['file-99.ts'], 3)
  assert.equal(selected.length, 3)
  assert.equal(selected[0].path, 'file-99.ts')
  assert.equal(selected[1].path, 'file-80.ts')
  assert.equal(new Set(selected.map(file => file.path)).size, 3)
})

import { shortName } from './orbitGeometry.ts'
test('shortName mantém extensão e limita o tamanho', () => {
  assert.equal(shortName('src/a.ts'), 'a.ts')
  assert.equal(shortName('src/componenteMuitoLongoDoPainel.tsx', 16), 'componenteM….tsx')
  assert.ok(shortName('x'.repeat(40), 10).length <= 10)
})

import { continentKey, continents, PIN_SPREAD } from './orbitGeometry.ts'
test('continentes: arquivos da mesma pasta ficam dentro do continente', () => {
  assert.equal(continentKey('src/main/a.ts'), 'src/main')
  assert.equal(continentKey('src/main/deep/a.ts'), 'src/main')
  assert.equal(continentKey('README.md'), '')
  const paths = ['src/main/a.ts', 'src/main/b.ts', 'src/renderer/c.tsx', 'docs/d.md']
  const lands = continents(paths)
  assert.equal(lands.length, 3)
  for (const path of paths) {
    const land = lands.find(l => l.key === continentKey(path))!, p = filePoint(path)
    const angle = Math.acos(land.center[0] * p[0] + land.center[1] * p[1] + land.center[2] * p[2])
    assert.ok(angle <= PIN_SPREAD + 1e-9 && angle < land.radius)
  }
})
