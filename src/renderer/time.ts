// Datas do SQLite ("2026-01-02 10:00:00", UTC sem fuso) e textos relativos usados pela gaveta, Inicio e chat.
export const sqlDate = (iso: string) => new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'))
export const minutesSince = (iso: string | null) => (iso ? (Date.now() - sqlDate(iso).getTime()) / 60000 : Infinity)

const span = (s: number) => (s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`)
const secondsSince = (iso: string) => (Date.now() - sqlDate(iso).getTime()) / 1000
// Curto, para listas ("5 min"); data futura ou invalida fica vazia.
export const ago = (iso: string) => { const s = secondsSince(iso); return !(s >= 0) ? '' : s < 90 ? 'agora' : span(s) }
// Frase ("há 5 min").
export const agoText = (iso: string) => { const s = secondsSince(iso); return s < 90 ? 'agora' : `há ${span(s)}` }

// Tempo desde um instante em ms: relogio ("4:07", "1h 05m") e em minutos ("12 min", "1h 5min").
export const clock = (from: number) => {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(r).padStart(2, '0')}`
}
export const elapsedMin = (from: number) => { const m = Math.max(0, Math.round((Date.now() - from) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min` }

// Caminhos de pasta no Windows: mesma pasta com outra caixa.
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
