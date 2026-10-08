// Setter de configuracao -> leitura correspondente. O renderer guarda o retorno do setter como cache da leitura (renderer/api.ts),
// entao o setter devolve exatamente o que a leitura devolve (returnReads), nunca um formato parcial.
export const SETTINGS_READS: Record<string, string> = {
  setContextLimits: 'getContextLimits', setNotifySettings: 'getNotifySettings', setJarvisSettings: 'getJarvisSettings',
  setDelegationSettings: 'getDelegationSettings', setPermissionSettings: 'getPermissionSettings',
  setWorkspaceOrbit: 'workspaceOrbit',
  setAgentAliases: 'getAgentAliases', setSummaryTitles: 'summaryTitles', setTurnCheckpoints: 'turnCheckpoints', setAutomations: 'getAutomations', setHandover: 'getHandover'
}

type Handlers = Record<string, (...a: any[]) => any>
export function returnReads(h: Handlers) {
  for (const [set, get] of Object.entries(SETTINGS_READS)) {
    const save = h[set], read = h[get]
    if (!save || !read) throw Error(`Configuracao sem par: ${set}/${get}`)
    h[set] = async (...a: any[]) => { await save(...a); return read() }
  }
  return h
}
