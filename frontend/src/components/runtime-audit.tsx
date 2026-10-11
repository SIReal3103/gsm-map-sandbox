import { useEffect, useState } from 'react'

// Development-only evidence surface; no additional network calls or timers.
export function RuntimeAudit() {
  const [resources, setResources] = useState<unknown[]>([])
  useEffect(() => {
    const entries = new Map<string, unknown>()
    const collect = (list: PerformanceEntry[]) => {
      for (const entry of list) {
        const resource = entry as PerformanceResourceTiming
        entries.set(`${resource.name}:${resource.startTime}`, { name: resource.name, initiatorType: resource.initiatorType, startTime: resource.startTime, duration: resource.duration, transferSize: resource.transferSize })
      }
      setResources([...entries.values()])
    }
    collect(performance.getEntriesByType('resource'))
    const observer = new PerformanceObserver(list => collect(list.getEntries()))
    observer.observe({ type: 'resource', buffered: true })
    return () => observer.disconnect()
  }, [])
  return <output hidden id="runtime-audit">{JSON.stringify(resources)}</output>
}
