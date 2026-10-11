import type { ClockSnapshot } from './fleet'

/** One RAF for the fleet; positions are projections of absolute simulation time. */
export class FleetClock {
  private snapshot: ClockSnapshot = { simulationTimeSeconds: 0, speedMultiplier: 1, playbackStatus: 'idle' }
  private listeners = new Set<() => void>()
  private frame: number | null = null
  private duration = 0
  private anchorTime = 0
  private anchorWall = 0
  private publishedWall = 0
  private lastFrameWall = 0
  private metrics = { frameSamples: 0, totalFrameMilliseconds: 0, maxFrameMilliseconds: 0 }
  getMetrics = () => ({ frameSamples: this.metrics.frameSamples, meanFrameMilliseconds: this.metrics.frameSamples ? this.metrics.totalFrameMilliseconds/this.metrics.frameSamples : 0, maxFrameMilliseconds: this.metrics.maxFrameMilliseconds })
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<ClockSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(fn => fn()) }
  private stop() { if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null }
  private time(now: number) { return Math.min(this.duration, this.anchorTime + Math.max(0, now-this.anchorWall)/1000*this.snapshot.speedMultiplier) }
  private tick = (now: number) => {
    if (this.snapshot.playbackStatus !== 'playing') return
    const delta = Math.max(0, now-this.lastFrameWall); this.lastFrameWall = now
    this.metrics.frameSamples++; this.metrics.totalFrameMilliseconds += delta; this.metrics.maxFrameMilliseconds = Math.max(this.metrics.maxFrameMilliseconds, delta)
    const time = this.time(now)
    if (time >= this.duration || now-this.publishedWall >= 1000/30) {
      this.publish({ simulationTimeSeconds: time, playbackStatus: time >= this.duration ? 'completed' : 'playing' }); this.publishedWall = now
    }
    if (time >= this.duration) { this.frame = null; return }
    this.frame = requestAnimationFrame(this.tick)
  }
  configure = (duration: number) => { this.stop(); this.duration = Math.max(0, duration); this.publish({ simulationTimeSeconds: 0, speedMultiplier: 1, playbackStatus: duration > 0 ? 'paused' : 'idle' }) }
  play = () => {
    if (!this.duration || this.snapshot.playbackStatus === 'playing') return
    this.anchorTime = this.snapshot.simulationTimeSeconds >= this.duration ? 0 : this.snapshot.simulationTimeSeconds
    this.anchorWall = performance.now(); this.publishedWall = this.anchorWall
    this.lastFrameWall = this.anchorWall; this.metrics = { frameSamples: 0, totalFrameMilliseconds: 0, maxFrameMilliseconds: 0 }
    this.publish({ simulationTimeSeconds: this.anchorTime, playbackStatus: 'playing' })
    this.frame = requestAnimationFrame(this.tick)
  }
  pause = () => { const playing = this.snapshot.playbackStatus === 'playing'; this.stop(); if (playing) { const time = this.time(performance.now()); this.publish({ simulationTimeSeconds: time, playbackStatus: time >= this.duration ? 'completed' : 'paused' }) } }
  seek = (seconds: number) => { this.stop(); const time = Math.max(0, Math.min(this.duration, Number.isFinite(seconds) ? seconds : 0)); this.publish({ simulationTimeSeconds: time, playbackStatus: !this.duration ? 'idle' : time >= this.duration ? 'completed' : 'paused' }) }
  reset = () => this.seek(0)
  setSpeed = (speed: number) => {
    if (![1, 2, 4].includes(speed)) return
    const now = performance.now(), time = this.snapshot.playbackStatus === 'playing' ? this.time(now) : this.snapshot.simulationTimeSeconds
    this.anchorTime = time; this.anchorWall = now
    this.publish({ simulationTimeSeconds: time, speedMultiplier: speed })
  }
  dispose = () => { this.stop(); this.listeners.clear() }
}
