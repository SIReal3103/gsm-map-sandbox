import type { Coordinate } from './api'

const radians = (value: number) => value * Math.PI / 180
export function segmentMeters(a: Coordinate, b: Coordinate) {
  const dl = radians(b[0] - a[0]), dp = radians(b[1] - a[1])
  const h = Math.sin(dp / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dl / 2) ** 2
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}
export function positionAt(coordinates: Coordinate[], progress: number): Coordinate | null {
  if (!coordinates.length) return null
  const lengths = coordinates.slice(1).map((point, i) => segmentMeters(coordinates[i], point))
  let remaining = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, progress))
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0 && remaining <= lengths[i]) {
      const t = remaining / lengths[i], a = coordinates[i], b = coordinates[i + 1]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    remaining -= lengths[i]
  }
  return coordinates[coordinates.length - 1]
}
export function positionAtTime(coordinates: Coordinate[], progress: number, durations?: number[] | null): Coordinate | null {
  if (!durations) return positionAt(coordinates, progress)
  if (!coordinates.length || durations.length !== coordinates.length - 1 || durations.some(v => !Number.isFinite(v) || v < 0)) return null
  const total = durations.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  if (progress <= 0) return coordinates[0]
  if (progress >= 1) return coordinates[coordinates.length - 1]
  let remaining = total * progress
  for (let i = 0; i < durations.length; i++) {
    if (durations[i] > 0 && remaining < durations[i]) {
      const t = remaining / durations[i], a = coordinates[i], b = coordinates[i + 1]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    remaining -= durations[i]
  }
  return coordinates[coordinates.length - 1]
}
export function advanceProgress(progress: number, elapsedSeconds: number, duration: number, speed: number) {
  if (duration <= 0 || !Number.isFinite(duration)) return 0
  return Math.max(0, Math.min(1, progress + Math.max(0, elapsedSeconds) * speed / duration))
}
