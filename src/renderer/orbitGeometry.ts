export type Point3 = readonly [number, number, number]

export function orbitHash(value: string): number {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '')

// Cada pasta (até dois níveis) é um continente; arquivos da raiz formam o continente ''.
export function continentKey(path: string): string {
  const dirs = normalize(path).split('/').slice(0, -1)
  return dirs.slice(0, Math.min(2, dirs.length)).join('/')
}

export function continentCenter(key: string): Point3 {
  const angle = orbitHash(`land:${key}`) / 4294967296 * Math.PI * 2
  const y = (orbitHash(`land-latitude:${key}`) / 4294967296 - .5) * .8
  const radius = Math.sqrt(1 - y * y)
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
}

export const PIN_SPREAD = .26

// Coordinates depend on the path only: the file sits inside the continent of its folder.
export function filePoint(path: string): Point3 {
  const key = normalize(path), c = continentCenter(continentKey(key))
  const t1Raw: Point3 = [c[2], 0, -c[0]], t1Length = Math.hypot(...t1Raw)
  const t1: Point3 = [t1Raw[0] / t1Length, 0, t1Raw[2] / t1Length]
  const t2: Point3 = [c[1] * t1[2] - c[2] * t1[1], c[2] * t1[0] - c[0] * t1[2], c[0] * t1[1] - c[1] * t1[0]]
  const theta = orbitHash(key) / 4294967296 * Math.PI * 2
  const distance = Math.sqrt(orbitHash(`distance:${key}`) / 4294967296) * PIN_SPREAD
  const along = Math.sin(distance), around = Math.cos(theta) * along, across = Math.sin(theta) * along
  return [0, 1, 2].map(i => c[i] * Math.cos(distance) + t1[i] * around + t2[i] * across) as unknown as Point3
}

// Continentes visíveis: os mais povoados primeiro; o raio cresce devagar com o número de arquivos.
export function continents(paths: string[], maximum = 32): { key: string; center: Point3; radius: number; count: number }[] {
  const counts = new Map<string, number>()
  for (const path of paths) { const key = continentKey(path); counts.set(key, (counts.get(key) ?? 0) + 1) }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maximum)
    .map(([key, count]) => ({ key, center: continentCenter(key), radius: .4 + Math.min(.1, count * .015), count }))
}

export function rotatePoint([x, y, z]: Point3, yaw: number, pitch = -.18): Point3 {
  const horizontal = x * Math.cos(yaw) + z * Math.sin(yaw)
  const depth = -x * Math.sin(yaw) + z * Math.cos(yaw)
  return [horizontal, y * Math.cos(pitch) - depth * Math.sin(pitch), y * Math.sin(pitch) + depth * Math.cos(pitch)]
}

export function projectPoint(point: Point3, yaw: number, width: number, height: number, radius: number) {
  const [x, y, z] = rotatePoint(point, yaw)
  return { x: width / 2 + x * radius, y: height / 2 - y * radius, z, front: z >= .015 }
}

export function facePoint(point: Point3): number {
  return Math.atan2(-point[0], point[2])
}

// A short spherical arc remains finite even for opposite points on the globe.
export function travelPoint(from: Point3, to: Point3, progress: number): Point3 {
  const t = Math.max(0, Math.min(1, progress))
  if (t === 0) return from
  if (t === 1) return to
  const aLength = Math.hypot(...from), bLength = Math.hypot(...to)
  const a = from.map(v => v / aLength), b = to.map(v => v / bLength)
  const dot = Math.max(-1, Math.min(1, a.reduce((sum, v, i) => sum + v * b[i], 0)))
  let direction: number[]
  if (dot < -.999) {
    const perpendicular = Math.abs(a[1]) < .8 ? [-a[2], 0, a[0]] : [0, a[2], -a[1]]
    const length = Math.hypot(...perpendicular)
    direction = a.map((v, i) => v * Math.cos(Math.PI * t) + perpendicular[i] / length * Math.sin(Math.PI * t))
  } else if (dot > .999) {
    direction = a.map((v, i) => v + (b[i] - v) * t)
  } else {
    const angle = Math.acos(dot), denominator = Math.sin(angle)
    direction = a.map((v, i) => (v * Math.sin((1 - t) * angle) + b[i] * Math.sin(t * angle)) / denominator)
  }
  const length = Math.hypot(...direction)
  const radius = aLength + (bLength - aLength) * t + Math.sin(Math.PI * t) * .12
  return direction.map(v => v / length * radius) as unknown as Point3
}

export function sphereMesh(rows = 24, columns = 40) {
  const positions: number[] = [], indices: number[] = []
  for (let row = 0; row <= rows; row++) {
    const latitude = row / rows * Math.PI
    for (let column = 0; column <= columns; column++) {
      const longitude = column / columns * Math.PI * 2
      positions.push(Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude))
      if (row < rows && column < columns) {
        const start = row * (columns + 1) + column
        indices.push(start, start + columns + 1, start + 1, start + 1, start + columns + 1, start + columns + 2)
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) }
}

export function globeFiles<T extends { path: string; hot?: boolean }>(files: T[], priority: string[], maximum = 64): T[] {
  const focused = new Set(priority)
  return [...new Map(files.map(file => [file.path, file])).values()]
    .sort((a, b) => Number(focused.has(b.path)) - Number(focused.has(a.path)) || Number(!!b.hot) - Number(!!a.hot) || a.path.localeCompare(b.path))
    .slice(0, maximum)
}

// Título curto para o alfinete: mantém o começo e a extensão.
export function shortName(path: string, max = 16): string {
  const name = path.replace(/\\/g, '/').split('/').pop() || path
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.'), ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  return `${name.slice(0, Math.max(1, max - ext.length - 1))}…${ext}`
}
