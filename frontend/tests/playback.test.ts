import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { advanceProgress, positionAt } from '../src/lib/playback'
import { usePlayback } from '../src/lib/use-playback'
import type { Route } from '../src/lib/api'

// Pure geometry fixture at the equator. Not an HCM street or a real route.
const fixture: Route = { coordinates: [[0, 0], [1, 0], [1, 1]], duration: 100, distance: 222390, snap_points: [], duration_source: 'test fixture' }
describe('geometry playback fixtures', () => {
  it('follows a bend along accumulated length rather than the A/B chord', () => {
    expect(positionAt(fixture.coordinates, 0.5)).toEqual([1, 0])
    expect(positionAt(fixture.coordinates, 0.75)![0]).toBe(1)
    expect(positionAt(fixture.coordinates, 0.75)![1]).toBeCloseTo(0.5, 10)
    expect(positionAt(fixture.coordinates, -1)).toEqual([0, 0])
    expect(positionAt(fixture.coordinates, 2)).toEqual([1, 1])
  })
  it('handles empty and repeated vertices', () => {
    expect(positionAt([], 0.5)).toBeNull()
    expect(positionAt([[1, 1], [1, 1]], 0.8)).toEqual([1, 1])
  })
  it('scales elapsed time and clamps completion', () => {
    expect(advanceProgress(0.2, 10, 100, 4)).toBeCloseTo(0.6)
    expect(advanceProgress(0.9, 10, 100, 2)).toBe(1)
    expect(advanceProgress(0, 10, 0, 1)).toBe(0)
  })
  it('play, pause, seek, speed, reset and route replacement', () => {
    let callback: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn(fn => { callback = fn; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { result, rerender } = renderHook(({ route }) => usePlayback(route), { initialProps: { route: fixture as Route | null } })
    act(() => result.current.play())
    act(() => callback!(0)); act(() => callback!(1000))
    expect(result.current.progress).toBeCloseTo(0.01)
    act(() => result.current.pause()); expect(result.current.playing).toBe(false)
    act(() => result.current.seek(0.5)); expect(result.current.progress).toBe(0.5)
    act(() => result.current.setSpeed(4)); expect(result.current.speed).toBe(4)
    act(() => result.current.play()); act(() => callback!(2000)); act(() => callback!(3000))
    expect(result.current.progress).toBeCloseTo(0.54)
    act(() => result.current.reset()); expect(result.current.progress).toBe(0)
    act(() => result.current.seek(1)); act(() => result.current.play()); expect(result.current.progress).toBe(0)
    rerender({ route: null }); expect(result.current.playing).toBe(false); expect(result.current.speed).toBe(1)
  })
  it('completes at B and cancels animation on completion and unmount', () => {
    let callback: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn(fn => { callback = fn; return 17 }))
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const { result, unmount } = renderHook(() => usePlayback(fixture))
    act(() => result.current.seek(.99))
    act(() => result.current.play())
    act(() => callback(0)); act(() => callback(2000))
    expect(result.current.progress).toBe(1)
    expect(result.current.playing).toBe(false)
    expect(cancel).toHaveBeenCalledWith(17)
    act(() => result.current.play())
    expect(result.current.progress).toBe(0)
    cancel.mockClear()
    unmount()
    expect(cancel).toHaveBeenCalledWith(17)
  })
})
