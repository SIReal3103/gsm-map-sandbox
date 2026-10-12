export const simulationSpeeds = [1, 2, 4, 8, 16, 32, 64] as const

/** Round upwards; invalid input has no value and must not change a clock. */
export function normalizeSimulationSpeed(input: number | string): number | null {
  if (typeof input === 'string' && !input.trim()) return null
  const value = Number(input)
  if (!Number.isFinite(value)) return null
  return simulationSpeeds.find(speed => speed >= value) ?? 64
}
