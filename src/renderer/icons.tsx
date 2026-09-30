// Icones de traco (24x24, currentColor): substituem emojis, que variam de fonte para fonte.
const P: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h10',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  panel: 'M4 5h16v14H4zM15 5v14',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  more: 'M5.5 12h1M11.5 12h1M17.5 12h1',
  files: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  branch: 'M6 4v10M6 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 6a2 2 0 1 0 0 .01M18 8c0 5-12 3-12 6',
  archive: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4',
  send: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M8 8h8v8H8z',
  plus: 'M12 5v14M5 12h14',
  gauge: 'M4 17a8 8 0 1 1 16 0M12 17l4.5-5.5M8 20h8',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  search: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.5-4.5',
  close: 'M6 6l12 12M18 6 6 18',
  down: 'M12 5v14M6 13l6 6 6-6',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  chevron: 'M9 6l6 6-6 6',
  restore: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
  home: 'M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  game: 'M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14.5 14h-5l-1.1 1.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4zM8 10.5v3M6.5 12h3M15.5 11.5h.01M17.5 13h.01',
  app: 'M4 5h16v14H4zM4 9h16M7 7h.01M9.5 7h.01',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  commit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 12h6M15 12h6',
  pr: 'M6 4v16M6 4a2 2 0 1 0 0 .01M18 20a2 2 0 1 0 0-.01M18 18V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  layers: 'M12 4l9 5-9 5-9-5zM3 14l9 5 9-5',
  target: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  check: 'M5 12l5 5 9-10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  planet: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM7.6 14.4C4.4 16 2.6 17.4 3 18.3c.6 1.4 5.6.1 11.1-2.9S23.6 9 23 7.6c-.4-.9-2.6-.8-5.7.3',
}

export function Icon({ n, size = 18 }: { n: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[n]} />
    </svg>
  )
}

// Cada provedor tem cor e sigla proprias: o mesmo agente e reconhecido na barra lateral, no dock e no chat.
export const PROVIDER: Record<string, { label: string; glyph: string }> = {
  claude: { label: 'Claude', glyph: 'C' },
  codex: { label: 'Codex', glyph: 'X' },
  gemini: { label: 'Gemini', glyph: 'G' },
  opencode: { label: 'OpenCode', glyph: 'O' },
}

export function Avatar({ provider, live, size = 'md' }: { provider: string; live?: boolean; size?: 'sm' | 'md' }) {
  return (
    <span className={`avatar ${size} p-${provider} ${live ? 'live' : ''}`} title={PROVIDER[provider]?.label ?? provider}>
      {PROVIDER[provider]?.glyph ?? provider[0]?.toUpperCase()}
    </span>
  )
}
