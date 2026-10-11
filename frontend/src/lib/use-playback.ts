import { useEffect, useRef, useState } from 'react'
import type { Route } from './api'
import { advanceProgress } from './playback'

export function usePlayback(route: Route | null) {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const previousRoute = useRef(route)
  // Reset immediately when geometry changes, before painting a stale vehicle.
  if (previousRoute.current !== route) {
    previousRoute.current = route
    setProgress(0)
    setPlaying(false)
    setSpeed(1)
  }
  useEffect(() => {
    if (!playing || !route) return
    let frame = 0, previous: number | null = null
    const tick = (now: number) => {
      if (previous !== null) {
        const elapsedSeconds = (now - previous) / 1000
        setProgress(value => advanceProgress(value, elapsedSeconds, route.duration, speed))
      }
      previous = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, route, speed])
  useEffect(() => { if (progress >= 1) setPlaying(false) }, [progress])
  return { progress, playing, speed, setSpeed,
    play: () => { if (route) { if (progress >= 1) setProgress(0); setPlaying(true) } },
    pause: () => setPlaying(false), reset: () => { setPlaying(false); setProgress(0) },
    seek: (value: number) => { setProgress(Math.max(0, Math.min(1, value))); setPlaying(false) } }
}
