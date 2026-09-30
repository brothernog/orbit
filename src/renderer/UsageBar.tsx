import { resetText, type UsageWindow } from './usageText'

// Uma linha por limite, como no Claude Desktop: nome, renovacao e % na mesma linha; barra embaixo. Usada em Configuracoes, no medidor do chat e no popup de limites.
export function Bar({ label, w }: { label: string; w: UsageWindow }) {
  if (!w) return null
  const pct = Math.round(w.utilization)
  return (
    <div className="usage">
      <div className="usage-row"><b>{label}</b><small>{resetText(w.resets_at)}</small><span>{pct}%</span></div>
      <div className="bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={pct > 80 ? 'hot' : ''} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}
