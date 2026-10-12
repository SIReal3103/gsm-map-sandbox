import { normalizeSimulationSpeed } from './simulation-speed'
import { useEffect, useRef, useState } from 'react'
import type { Route } from './api'
import { advanceProgress } from './playback'

export function usePlayback(route: Route | null) {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const previousRoute = useRef(route)
  const speedRef = useRef(1), previousFrame = useRef<number | null>(null)
  // Reset immediately when geometry changes, before painting a stale vehicle.
  if (previousRoute.current !== route) {
    previousRoute.current = route
    setProgress(0)
    setPlaying(false)
    setSpeed(1)
    speedRef.current = 1
  }
  useEffect(() => {
    if (!playing || !route) return
    let frame = 0
    previousFrame.current = null
    const tick = (now: number) => {
      if (previousFrame.current !== null) {
        const elapsedSeconds = (now - previousFrame.current) / 1000
        const frameSpeed = speedRef.current
        setProgress(value => advanceProgress(value, elapsedSeconds, route.duration, frameSpeed))
      }
      previousFrame.current = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, route])
  useEffect(() => { if (progress >= 1) setPlaying(false) }, [progress])
  const applySpeed = (value: number) => {
    const normalized = normalizeSimulationSpeed(value)
    if (normalized === null) return
    if (playing && route && previousFrame.current !== null) {
      const now = performance.now()
      const elapsed = (now-previousFrame.current)/1000, oldSpeed = speedRef.current
      setProgress(value => advanceProgress(value, elapsed, route.duration, oldSpeed))
      previousFrame.current = now
    }
    speedRef.current = normalized; setSpeed(normalized)
  }
  return { progress, playing, speed, setSpeed: applySpeed,
    play: () => { if (route) { if (progress >= 1) setProgress(0); setPlaying(true) } },
    pause: () => setPlaying(false), reset: () => { setPlaying(false); setProgress(0) },
    seek: (value: number) => { setProgress(Math.max(0, Math.min(1, value))); setPlaying(false) } }
}
