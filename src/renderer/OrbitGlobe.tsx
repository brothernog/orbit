import { useEffect, useMemo, useRef, useState } from 'react'
import { continents as continentsOf, facePoint, filePoint, globeFiles, orbitHash, projectPoint, shortName, sphereMesh, travelPoint, type Point3 } from './orbitGeometry'
import './OrbitGlobe.css'

export type OrbitGlobeFile = { path: string; added: number | null; removed: number | null; editAdded?: number | null; editRemoved?: number | null; hot?: boolean; updatedAt?: number }
export type OrbitGlobeAgent = { id: string; provider: string; path?: string; active: boolean; label?: string }
type Props = {
  files: OrbitGlobeFile[]
  agents: OrbitGlobeAgent[]
  selectedAgent?: string
  selectedFile?: string
  onSelectAgent?: (id: string) => void
  onSelectFile?: (path: string) => void
}

const VERTEX = `
attribute vec3 a_position;
uniform vec2 u_rotation;
uniform vec2 u_scale;
varying vec3 v_local;
varying vec3 v_normal;
void main() {
  float cy = cos(u_rotation.x), sy = sin(u_rotation.x);
  float cp = cos(u_rotation.y), sp = sin(u_rotation.y);
  vec3 p = vec3(a_position.x * cy + a_position.z * sy, a_position.y, -a_position.x * sy + a_position.z * cy);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  v_local = a_position;
  v_normal = p;
  gl_Position = vec4(p.xy * u_scale, -p.z * .5, 1.0);
}`
const FRAGMENT = `
precision mediump float;
uniform vec4 u_land[32];
uniform float u_count;
varying vec3 v_local;
varying vec3 v_normal;
float field(vec3 p) {
  float wobble = sin(p.x * 7.0 + p.z * 5.0) * .06 + sin(p.y * 9.0 - p.x * 6.0 + 2.0) * .05 + sin(p.z * 19.0 + p.y * 14.0) * .018;
  float f = -1.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= u_count) break;
    vec4 c = u_land[i];
    f = max(f, 1.0 - (acos(clamp(dot(p, c.xyz), -1.0, 1.0)) + wobble) / c.w);
  }
  return f;
}
void main() {
  vec3 p = normalize(v_local);
  float f = field(p);
  float land = smoothstep(0.0, .06, f);
  float shallow = smoothstep(-.22, 0.0, f) * (1.0 - land);
  vec3 sea = mix(vec3(.025, .055, .1), vec3(.05, .15, .21), shallow);
  vec3 ground = mix(vec3(.15, .27, .24), vec3(.3, .36, .32), smoothstep(.2, .75, f));
  vec3 surface = mix(sea, ground, land);
  vec3 n = normalize(v_normal);
  float day = smoothstep(-.3, 1.0, dot(n, normalize(vec3(-.5, .6, 1.0))));
  float rim = pow(1.0 - max(0.0, n.z), 3.0);
  vec3 color = surface * (.3 + day * .8) + vec3(.3, .55, .85) * rim * .16;
  gl_FragColor = vec4(color, 1.0);
}`

function createPlanet(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, depth: true, powerPreference: 'low-power', preserveDrawingBuffer: false })
  if (!gl) return null
  const shaders: WebGLShader[] = [], buffers: WebGLBuffer[] = []
  const program = gl.createProgram()
  if (!program) return null
  const destroy = () => { buffers.forEach(buffer => gl.deleteBuffer(buffer)); shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program) }
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('shader')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader')
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('program')
    gl.useProgram(program)
    const mesh = sphereMesh(), vertex = gl.createBuffer(), index = gl.createBuffer()
    if (!vertex || !index) { if (vertex) gl.deleteBuffer(vertex); if (index) gl.deleteBuffer(index); throw new Error('buffer') }
    buffers.push(vertex, index)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
    const rotation = gl.getUniformLocation(program, 'u_rotation'), scale = gl.getUniformLocation(program, 'u_scale'), land = gl.getUniformLocation(program, 'u_land'), landCount = gl.getUniformLocation(program, 'u_count')
    gl.enable(gl.DEPTH_TEST); gl.clearColor(0, 0, 0, 0)
    return {
      draw(yaw: number, width: number, height: number, radius: number, lands: Float32Array, count: number) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.uniform2f(rotation, yaw, -.18); gl.uniform2f(scale, radius * 2 / width, radius * 2 / height)
        gl.uniform4fv(land, lands); gl.uniform1f(landCount, count)
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0)
      }, destroy
    }
  } catch { destroy(); return null }
}

const scaled = (point: Point3, radius: number) => point.map(value => value * radius) as unknown as Point3
const basename = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path
const counts = (file: OrbitGlobeFile) => [file.added != null ? `+${file.added}` : '', file.removed != null ? `−${file.removed}` : ''].filter(Boolean).join(' ')
const editCounts = (file: OrbitGlobeFile) => [file.editAdded != null ? `+${file.editAdded}` : '', file.editRemoved != null ? `−${file.editRemoved}` : ''].filter(Boolean).join(' ')

export function OrbitGlobe(props: Props) {
  const { files, agents, selectedAgent, selectedFile, onSelectAgent, onSelectFile } = props
  const focusedPath = selectedFile ?? agents.find(agent => agent.id === selectedAgent)?.path
  const focused = files.find(file => file.path === focusedPath)
  const pins = useMemo(() => globeFiles(files, [focusedPath ?? '', ...agents.map(agent => agent.path ?? '')]), [files, agents, focusedPath])
  const lands = useMemo(() => continentsOf(files.map(file => file.path)), [files])
  const latest = useRef({ ...props, focusedPath, pins, lands })
  latest.current = { ...props, focusedPath, pins, lands }
  const stage = useRef<HTMLDivElement>(null), planetCanvas = useRef<HTMLCanvasElement>(null), markersCanvas = useRef<HTMLCanvasElement>(null)
  const redraw = useRef<() => void>(() => {}), zoomRef = useRef(1)
  const zoomTo = (value: number) => { zoomRef.current = Math.max(.7, Math.min(2.4, value)); setZoom(zoomRef.current); redraw.current() }
  const hitTargets = useRef<{ x: number; y: number; file?: string; agent?: string; label: string; box?: readonly [number, number, number, number] }[]>([])
  const [fallback, setFallback] = useState(false), [zoom, setZoom] = useState(1), [contextVersion, setContextVersion] = useState(0), [hovered, setHovered] = useState(''), [listOpen, setListOpen] = useState(false)

  useEffect(() => {
    const element = stage.current, canvas = planetCanvas.current, markers = markersCanvas.current
    if (!element || !canvas || !markers) return
    const ctx = markers.getContext('2d')
    if (!ctx) { setFallback(true); return }
    let planet = createPlanet(canvas)
    setFallback(!planet)
    let width = 1, height = 1, base = 1, zoomNow = 1, dpr = 1, frame = 0, lastFrame = 0, elapsed = 0
    let visible = true, disposed = false, targetYaw = .45, yaw = .45, focus = '', transitionUntil = 0
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = media.matches
    const visits = new Map<string, { stamp: string; at: number }>()
    const landUniform = new Float32Array(128)
    let primed = false
    const TRAIL = 9000
    const satellites = new Map<string, { path?: string; from: Point3; point: Point3; at: number; trail: { from: Point3; to: Point3; at: number }[] }>()
    const follow = (path: string, now: number) => { targetYaw = facePoint(filePoint(path)); transitionUntil = Math.max(transitionUntil, now + 1600) }
    const styles = getComputedStyle(element)
    const accent = styles.getPropertyValue('--accent').trim() || '#7cc4ff'
    const muted = styles.getPropertyValue('--muted').trim() || '#8c96a8'
    const text = styles.getPropertyValue('--text').trim() || '#e6ebf2'
    const providerColors = Object.fromEntries(['claude', 'codex', 'gemini', 'opencode'].map(provider => [provider, styles.getPropertyValue(`--p-${provider}`).trim() || accent]))

    const orbit = (agent: OrbitGlobeAgent, time: number): Point3 => {
      const offset = orbitHash(agent.id) / 4294967296 * Math.PI * 2
      const angle = offset + (reduced || !agent.active ? 0 : time * .2)
      return [Math.cos(angle) * 1.26, Math.sin(angle) * .32, Math.sin(angle) * 1.26]
    }
    const synchronize = (now: number) => {
      const data = latest.current
      if (focus !== data.focusedPath) {
        focus = data.focusedPath ?? ''
        if (focus) targetYaw = facePoint(filePoint(focus))
        transitionUntil = now + 1100
      }
      for (const file of data.pins) {
        const stamp = `${file.added}:${file.removed}:${file.editAdded ?? ''}:${file.editRemoved ?? ''}:${file.hot}:${file.updatedAt ?? ''}`
        if (visits.get(file.path)?.stamp !== stamp) {
          const emphasized = file.hot || file.path === data.focusedPath || data.agents.some(agent => agent.path === file.path)
          visits.set(file.path, { stamp, at: emphasized ? now : now - 1600 }); transitionUntil = now + 1600
          if (file.hot && primed) follow(file.path, now)
        }
      }
      const filePaths = new Set(data.pins.map(file => file.path)), agentIds = new Set(data.agents.map(agent => agent.id))
      for (const path of visits.keys()) if (!filePaths.has(path)) visits.delete(path)
      for (const id of satellites.keys()) if (!agentIds.has(id)) satellites.delete(id)
      for (const agent of data.agents) {
        const previous = satellites.get(agent.id)
        if (!previous) {
          const point = agent.path ? scaled(filePoint(agent.path), 1.11) : orbit(agent, elapsed)
          satellites.set(agent.id, { path: agent.path, from: point, point, at: now, trail: [] })
          if (agent.path && agent.active) follow(agent.path, now)
        } else if (previous.path !== agent.path) {
          const to = agent.path ? scaled(filePoint(agent.path), 1.11) : orbit(agent, elapsed)
          const trail = [...previous.trail.filter(segment => now - segment.at < TRAIL), { from: previous.point, to, at: now }].slice(-4)
          satellites.set(agent.id, { path: agent.path, from: previous.point, point: previous.point, at: now, trail })
          transitionUntil = now + TRAIL
          if (agent.path && agent.active) follow(agent.path, now)
          if (agent.path) { const visit = visits.get(agent.path); if (visit) visit.at = now }
        }
      }
      primed = true
    }

    const draw = (now: number) => {
      const data = latest.current
      zoomNow = reduced ? zoomRef.current : zoomNow + (zoomRef.current - zoomNow) * .22
      if (Math.abs(zoomRef.current - zoomNow) < .004) zoomNow = zoomRef.current
      const radius = base * zoomNow
      const angle = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw))
      yaw = reduced ? targetYaw : yaw + angle * .12
      const drift = !reduced && data.agents.some(agent => agent.active) ? Math.sin(elapsed * .08) * .035 : 0
      const rotation = yaw + drift
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height)
      const halo = ctx.createRadialGradient(width / 2, height / 2, radius * .98, width / 2, height / 2, radius * 1.3)
      halo.addColorStop(0, `${accent}1c`); halo.addColorStop(.4, `${accent}0a`); halo.addColorStop(1, `${accent}00`)
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(width / 2, height / 2, radius * 1.3, 0, Math.PI * 2); ctx.fill()
      data.lands.slice(0, 32).forEach((land, i) => landUniform.set([...land.center, land.radius], i * 4))
      if (planet) planet.draw(rotation, width, height, radius, landUniform, Math.min(32, data.lands.length))
      else {
        const fill = ctx.createRadialGradient(width / 2 - radius * .4, height / 2 - radius * .4, 0, width / 2, height / 2, radius)
        fill.addColorStop(0, '#253d4f'); fill.addColorStop(1, '#0e1824')
        ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.fill()
      }
      const project = (point: Point3) => projectPoint(point, rotation, width, height, radius)
      const line = (a: Point3, b: Point3) => { const start = project(a), end = project(b); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y) }
      // The faint track is clipped at the sphere, so the far half really passes behind it.
      ctx.strokeStyle = `${accent}22`; ctx.lineWidth = 1; ctx.beginPath()
      for (let i = 0; i < 100; i++) {
        const a = i / 100 * Math.PI * 2, b = (i + 1) / 100 * Math.PI * 2
        const first: Point3 = [Math.cos(a) * 1.26, Math.sin(a) * .32, Math.sin(a) * 1.26]
        const second: Point3 = [Math.cos(b) * 1.26, Math.sin(b) * .32, Math.sin(b) * 1.26]
        const position = project(first)
        if (position.front || Math.hypot(position.x - width / 2, position.y - height / 2) > radius + 2) line(first, second)
      }
      ctx.stroke()
      // Nomes das pastas, só com zoom: discretos, sobre o centro de cada continente.
      if (zoomNow > 1.15) {
        ctx.font = '10px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = muted
        ctx.globalAlpha = Math.min(1, (zoomNow - 1.15) * 3) * .6
        for (const land of data.lands) { const at = project(land.center); if (land.key && at.front && at.z > .25) ctx.fillText(land.key.split('/').pop()!, at.x, at.y) }
        ctx.globalAlpha = 1
      }
      // Rastro do agente: cada salto deixa uma linha que apaga devagar.
      if (!reduced) for (const agent of data.agents) {
        const satellite = satellites.get(agent.id)
        if (!satellite) continue
        ctx.strokeStyle = providerColors[agent.provider] ?? accent; ctx.lineWidth = 1.6; ctx.lineCap = 'round'
        for (const segment of satellite.trail) {
          const fade = 1 - (now - segment.at) / TRAIL
          if (fade <= 0) continue
          const steps = 24
          for (let i = 0; i < steps; i++) {
            const a = project(travelPoint(segment.from, segment.to, i / steps)), b = project(travelPoint(segment.from, segment.to, (i + 1) / steps))
            if (!b.front && Math.hypot(b.x - width / 2, b.y - height / 2) < radius + 2) continue
            ctx.globalAlpha = fade ** 1.5 * .75 * (.2 + .8 * (i + 1) / steps)
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
          }
        }
        ctx.globalAlpha = 1
      }
      const targets: typeof hitTargets.current = []
      const labels: { x: number; y: number; text: string; color: string; file: string; active: boolean }[] = []
      for (const file of data.pins) {
        const point = filePoint(file.path), position = project(point)
        if (!position.front) continue
        const holder = data.agents.find(agent => agent.path === file.path)
        const active = file.path === data.focusedPath, strong = active || !!file.hot || !!holder
        const color = active ? accent : holder ? providerColors[holder.provider] ?? accent : accent
        const tip = project(scaled(point, strong ? 1.17 : 1.035)), age = now - (visits.get(file.path)?.at ?? 0)
        const pulse = !reduced && age < 1500 ? 1 - age / 1500 : 0
        ctx.strokeStyle = strong ? color : `${muted}90`; ctx.lineWidth = strong ? 1.6 : 1
        ctx.beginPath(); ctx.moveTo(position.x, position.y); ctx.lineTo(tip.x, tip.y); ctx.stroke()
        if (strong) {
          const glow = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 16)
          glow.addColorStop(0, `${color}88`); glow.addColorStop(1, `${color}00`)
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(tip.x, tip.y, 16, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(tip.x, tip.y, active ? 5.5 : 4.5, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(tip.x, tip.y, 1.8, 0, Math.PI * 2); ctx.fill()
          if (labels.length < 4) labels.push({ x: tip.x, y: tip.y, text: shortName(file.path), color, file: file.path, active })
        } else { ctx.fillStyle = muted; ctx.beginPath(); ctx.arc(tip.x, tip.y, 2.1, 0, Math.PI * 2); ctx.fill() }
        if (pulse > 0) {
          ctx.globalAlpha = pulse * .5; ctx.strokeStyle = color
          ctx.beginPath(); ctx.arc(tip.x, tip.y, 6 + (1 - pulse) * 14, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1
          if (file.hot && editCounts(file)) {
            ctx.globalAlpha = pulse; ctx.fillStyle = text; ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'
            ctx.fillText(editCounts(file), tip.x, tip.y + 24 + (1 - pulse) * 5); ctx.globalAlpha = 1
          }
        }
        targets.push({ x: tip.x, y: tip.y, file: file.path, label: `${file.path}${editCounts(file) ? ` · última edição ${editCounts(file)}` : ''}${counts(file) ? ` · desde HEAD ${counts(file)}` : ''}` })
      }
      // Rótulos: acima do alfinete; se colidirem com um anterior, descem para abaixo.
      ctx.font = '600 11px "Segoe UI", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const placed: (readonly [number, number, number, number])[] = []
      for (const label of labels) {
        const w = Math.ceil(ctx.measureText(label.text).width) + 16, h = 20
        const x = Math.max(4, Math.min(width - w - 4, label.x - w / 2))
        let y = Math.max(4, label.y - h - 12)
        if (placed.some(o => x < o[0] + o[2] && x + w > o[0] && y < o[1] + o[3] && y + h > o[1])) y = Math.min(height - h - 4, label.y + 12)
        placed.push([x, y, w, h])
        ctx.fillStyle = 'rgba(8,12,20,.9)'; ctx.strokeStyle = label.color; ctx.lineWidth = label.active ? 1.4 : 1
        ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill(); ctx.stroke()
        ctx.fillStyle = text; ctx.fillText(label.text, x + 8, y + h / 2 + .5)
        const hit = targets.find(target => target.file === label.file); if (hit) hit.box = [x, y, w, h]
      }
      ctx.textBaseline = 'alphabetic'
      for (const agent of data.agents) {
        const satellite = satellites.get(agent.id)
        if (!satellite) continue
        let destination = agent.path ? scaled(filePoint(agent.path), 1.11) : orbit(agent, elapsed)
        if (agent.path && agent.active && !reduced) {
          const phase = elapsed * 1.2 + orbitHash(agent.id) % 6
          const base = destination, tangent: Point3 = [base[2], 0, -base[0]]
          destination = [base[0] + tangent[0] * Math.cos(phase) * .045, base[1] + Math.sin(phase) * .045, base[2] + tangent[2] * Math.cos(phase) * .045]
        }
        const progress = reduced ? 1 : Math.min(1, (now - satellite.at) / 850)
        satellite.point = travelPoint(satellite.from, destination, 1 - (1 - progress) ** 3)
        const position = project(satellite.point), inside = Math.hypot(position.x - width / 2, position.y - height / 2) < radius + 5
        if (!position.front && inside) continue
        const color = providerColors[agent.provider] ?? accent, selected = agent.id === data.selectedAgent
        ctx.globalAlpha = position.front ? 1 : .5
        if (selected) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(position.x, position.y, 8, 0, Math.PI * 2); ctx.stroke() }
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(position.x, position.y, selected ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 1
        targets.unshift({ x: position.x, y: position.y, agent: agent.id, label: `${agent.label ?? agent.provider}${agent.path ? ` · ${agent.path}` : ''}` })
      }
      hitTargets.current = targets
    }
    const stop = () => { cancelAnimationFrame(frame); frame = 0; lastFrame = 0 }
    const tick = (now: number) => {
      frame = 0
      if (disposed || !visible || document.hidden) { lastFrame = 0; return }
      if (!lastFrame || now - lastFrame >= 1000 / 30) {
        elapsed += lastFrame ? Math.min(.1, (now - lastFrame) / 1000) : 0
        lastFrame = now; draw(now)
      }
      if (!reduced && (latest.current.agents.some(agent => agent.active) || now < transitionUntil || zoomNow !== zoomRef.current)) frame = requestAnimationFrame(tick)
      else lastFrame = 0
    }
    const wake = () => {
      synchronize(performance.now())
      if (!disposed && visible && !document.hidden && !frame) frame = requestAnimationFrame(tick)
    }
    redraw.current = wake
    const resize = () => {
      const box = element.getBoundingClientRect()
      width = Math.max(1, box.width); height = Math.max(1, box.height); base = Math.min(height * .36, width * .31)
      dpr = Math.min(devicePixelRatio || 1, 1.5)
      for (const surface of [canvas, markers]) { surface.width = Math.round(width * dpr); surface.height = Math.round(height * dpr) }
      wake()
    }
    const resized = new ResizeObserver(resize); resized.observe(element)
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; if (visible) wake(); else stop() })
    intersection.observe(element)
    const visibility = () => { if (document.hidden) stop(); else wake() }
    const motion = () => { reduced = media.matches; stop(); wake() }
    const lost = (event: Event) => { event.preventDefault(); planet?.destroy(); planet = null; setFallback(true); wake() }
    const restored = () => setContextVersion(version => version + 1)
    document.addEventListener('visibilitychange', visibility); media.addEventListener('change', motion)
    canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored)
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoomTo(zoomRef.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)) }
    markers.addEventListener('wheel', wheel, { passive: false })
    resize()
    return () => {
      markers.removeEventListener('wheel', wheel)
      disposed = true; stop(); redraw.current = () => {}; resized.disconnect(); intersection.disconnect(); planet?.destroy()
      document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', motion)
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored)
    }
  }, [contextVersion])

  useEffect(() => { redraw.current() }, [files, agents, focusedPath, selectedAgent])
  const targetAt = (event: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
    return hitTargets.current.find(target => Math.hypot(x - target.x, y - target.y) <= (target.agent ? 13 : 10) || (!!target.box && x >= target.box[0] && x <= target.box[0] + target.box[2] && y >= target.box[1] && y <= target.box[1] + target.box[3]))
  }
  return <section className="orbit-globe" aria-label="Planeta dos arquivos visitados na tarefa">
    <div className="orbit-globe-stage" ref={stage}>
      <canvas ref={planetCanvas} className="orbit-globe-surface" aria-hidden="true" />
      <canvas ref={markersCanvas} className="orbit-globe-markers" aria-hidden="true" title={hovered}
        onPointerMove={event => { const target = targetAt(event); event.currentTarget.style.cursor = target ? 'pointer' : 'default'; setHovered(target?.label ?? '') }}
        onPointerLeave={() => setHovered('')}
        onClick={event => { const target = targetAt(event); if (target?.agent) onSelectAgent?.(target.agent); else if (target?.file) onSelectFile?.(target.file) }} />
      <div className="orbit-globe-zoom" role="group" aria-label="Zoom do planeta">
        <button type="button" aria-label="Aproximar" disabled={zoom >= 2.4} onClick={() => zoomTo(zoomRef.current * 1.3)}>+</button>
        <button type="button" aria-label="Afastar" disabled={zoom <= .7} onClick={() => zoomTo(zoomRef.current / 1.3)}>−</button>
        <button type="button" aria-label="Zoom padrão" disabled={zoom === 1} onClick={() => zoomTo(1)}>1×</button>
      </div>
      <span className="orbit-globe-caption">{files.length ? `${files.length} ${files.length === 1 ? 'arquivo na tarefa' : 'arquivos na tarefa'}` : 'Os arquivos aparecem ao serem visitados'}</span>
      {hovered && <span className="orbit-globe-hover" title={hovered}>{hovered}</span>}
    </div>
    {agents.length > 0 && <div className="orbit-globe-agents" aria-label="Agentes no planeta">
      {agents.map(agent => <button key={agent.id} className={`orbit-globe-agent p-${agent.provider}`} aria-pressed={agent.id === selectedAgent}
        title={`${agent.label ?? agent.provider}${agent.path ? ` · ${agent.path}` : ''}`} onClick={() => onSelectAgent?.(agent.id)}>
        <span className={`orbit-globe-agent-dot ${agent.active ? 'active' : ''}`} aria-hidden="true" />
        <span>{agent.label ?? agent.provider}</span>
      </button>)}
    </div>}
    {focused && <div className="orbit-globe-focus" title={focused.path}>
      <span className="orbit-globe-file-name">{basename(focused.path)}</span>
      <span className="orbit-globe-changes">
        {(focused.editAdded != null || focused.editRemoved != null) && <span className="orbit-globe-delta"><span>Última edição</span>{focused.editAdded != null && <span className="added">+{focused.editAdded}</span>}{focused.editRemoved != null && <span className="removed">−{focused.editRemoved}</span>}</span>}
        {(focused.added != null || focused.removed != null) && <span className="orbit-globe-delta"><span>Desde HEAD</span>{focused.added != null && <span className="added">+{focused.added}</span>}{focused.removed != null && <span className="removed">−{focused.removed}</span>}</span>}
        {focused.added == null && focused.removed == null && focused.editAdded == null && focused.editRemoved == null && <span className="orbit-globe-delta">Sem contagem informada</span>}
      </span>
    </div>}
    {fallback && <p className="orbit-globe-fallback">3D indisponível neste dispositivo; acompanhamento em modo leve.</p>}
    {files.length > 0 && <details className="orbit-globe-files" onToggle={event => setListOpen(event.currentTarget.open)}>
      <summary>Arquivos da tarefa <span>{files.length}</span></summary>
      {listOpen && <div className="orbit-globe-file-list">
        {files.map(file => <button key={file.path} title={file.path} aria-pressed={file.path === focusedPath} onClick={() => onSelectFile?.(file.path)}>
          <span>{file.path}</span><span className="orbit-globe-delta" aria-label="Mudanças desde HEAD">{file.added != null && <span className="added">+{file.added}</span>}{file.removed != null && <span className="removed">−{file.removed}</span>}</span>
        </button>)}
      </div>}
      {pins.length < files.length && <p>A visualização prioriza os {pins.length} arquivos em foco ou editados. A lista contém todos.</p>}
    </details>}
  </section>
}
