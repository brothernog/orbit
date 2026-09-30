import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { loadRead, readSnapshot, setRead, subscribeRead, type ReadSnapshot } from './readCache'

const empty: ReadSnapshot<never> = { data: undefined, error: undefined }

export function useCachedRead<T>(key: string | null, loader: () => Promise<T>, ttl = 0) {
  const currentLoader = useRef(loader)
  currentLoader.current = loader
  const subscribe = useCallback((f: () => void) => key ? subscribeRead(key, f) : () => {}, [key])
  const snapshot = useCallback(() => key ? readSnapshot<T>(key) : empty, [key])
  const result = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    if (key) loadRead(key, currentLoader.current, ttl).catch(() => {})
  }, [key, ttl])
  const reload = useCallback(() => key ? loadRead(key, currentLoader.current) : Promise.resolve(undefined), [key])
  const set = useCallback((value: T) => { if (key) setRead(key, value) }, [key])
  return { ...result, reload, set }
}
