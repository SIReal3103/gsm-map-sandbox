import { useEffect, useState } from 'react'
import { Play, Pause, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { normalizeSimulationSpeed } from '@/lib/simulation-speed'
import { useFleetClock } from '@/lib/use-fleet'
import type { FleetClock } from '@/lib/fleet-clock'

interface PlaybackControls {
  time: number; duration: number; speed: number; status: string; enabled: boolean; label: string
  play: () => void; pause: () => void; reset: () => void; seek: (time: number) => void; setSpeed: (speed: number) => void
}
export function ClockDock({ clock, duration, enabled, label }: { clock: FleetClock; duration: number; enabled: boolean; label: string }) {
  const state = useFleetClock(clock)
  return <PlaybackDock time={state.simulationTimeSeconds} duration={duration} speed={state.speedMultiplier} status={state.playbackStatus} enabled={enabled} label={label} play={clock.play} pause={clock.pause} reset={clock.reset} seek={clock.seek} setSpeed={clock.setSpeed}/>
}
export function PlaybackDock(props: PlaybackControls) {
  const { time, duration, speed, status, enabled, label } = props
  const [customSpeed, setCustomSpeed] = useState(String(speed)), [error, setError] = useState(''), [seek, setSeek] = useState('0')
  useEffect(() => { setCustomSpeed(String(speed)) }, [speed])
  const apply = () => {
    const normalized = normalizeSimulationSpeed(customSpeed)
    if (normalized === null || Number(customSpeed) < 0) { setError('Nhập tốc độ hữu hạn từ 0 trở lên.'); setCustomSpeed(String(speed)); return }
    setError(''); setCustomSpeed(String(normalized)); props.setSpeed(normalized)
  }
  const playing = status === 'playing'
  return <section className="playback-dock" aria-label={`${label} playback`} data-dock-time={time} data-dock-duration={duration} data-dock-speed={speed} data-dock-state={status}>
    <div className="dock-buttons"><Button disabled={!enabled || playing} onClick={props.play}><Play size={15}/>{time > 0 && status === 'paused' ? 'Resume' : 'Play'}</Button><Button variant="outline" disabled={!enabled || !playing} onClick={props.pause}><Pause size={15}/>Pause</Button><Button variant="outline" disabled={!enabled} aria-label="Reset" onClick={props.reset}><RotateCcw size={16}/></Button></div>
    <div className="dock-timeline"><div><strong>{label}</strong><span>{time.toFixed(1)} / {duration.toFixed(1)} s · {duration ? Math.round(time/duration*100) : 0}%</span></div><Slider aria-label="Simulation timeline" disabled={!enabled} min={0} max={duration || 1} step={.1} value={[time]} onValueChange={value => props.seek(typeof value === 'number' ? value : value[0])}/></div>
    <form className="dock-seek" onSubmit={e => { e.preventDefault(); if (seek.trim() && Number.isFinite(+seek)) props.seek(+seek) }}><input aria-label="Seek seconds" type="number" min="0" max={duration} step="any" disabled={!enabled} value={seek} onChange={e => setSeek(e.target.value)}/><Button type="submit" variant="ghost" disabled={!enabled || !seek.trim() || !Number.isFinite(+seek)}>Seek</Button></form>
    <div className="dock-speed"><div>{[1,2,4].map(value => <Button key={value} size="sm" variant={speed === value ? 'secondary' : 'ghost'} aria-pressed={speed === value} disabled={!enabled} onClick={() => props.setSpeed(value)}>{value}x</Button>)}</div><form onSubmit={e => { e.preventDefault(); apply() }}><label>Custom Speed<input aria-label="Custom Speed" inputMode="decimal" value={customSpeed} disabled={!enabled} onChange={e => setCustomSpeed(e.target.value)} onBlur={e => { if (e.relatedTarget?.getAttribute('type') !== 'submit') apply() }}/></label><Button type="submit" variant="outline" size="sm" disabled={!enabled}>Set</Button></form><span aria-label="Applied speed">{speed}x</span></div>
    {error && <p role="alert" className="dock-error">{error}</p>}
  </section>
}
