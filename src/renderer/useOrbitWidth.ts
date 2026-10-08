import { useEffect, type KeyboardEvent, type PointerEvent } from 'react'

const KEY = 'orbitPanelWidth', MIN = 340, MAX = 900
const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(w, MAX, window.innerWidth * .7)))
const root = () => document.documentElement
const current = () => parseInt(root().style.getPropertyValue('--panelw')) || parseInt(getComputedStyle(root()).getPropertyValue('--panelw')) || 420
const apply = (w: number) => root().style.setProperty('--panelw', `${clamp(w)}px`)
const save = () => { try { localStorage.setItem(KEY, String(current())) } catch { /* sem armazenamento */ } }

// Largura do painel: arrastar a borda esquerda ou usar as setas; lembrada entre sessões.
export function useOrbitWidth() {
  useEffect(() => {
    try { const saved = Number(localStorage.getItem(KEY)); if (saved) apply(saved) } catch { /* sem armazenamento */ }
    return () => { root().style.removeProperty('--panelw') }
  }, [])
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) { event.currentTarget.setPointerCapture(event.pointerId) },
    onPointerMove(event: PointerEvent<HTMLElement>) { if (event.currentTarget.hasPointerCapture(event.pointerId)) apply(window.innerWidth - event.clientX) },
    onPointerUp(event: PointerEvent<HTMLElement>) { event.currentTarget.releasePointerCapture(event.pointerId); save() },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0
      if (!step) return
      event.preventDefault(); apply(current() + step); save()
    }
  }
}
