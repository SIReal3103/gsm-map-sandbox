import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import App from '../src/App'

// WebGL is intentionally mocked in component unit tests; browser QA is separate.
vi.mock('../src/components/sandbox-map', () => ({ SandboxMap: ({ enabled, onSelect }: { enabled: boolean; onSelect: (point: [number, number]) => void }) => <div data-testid="map-host">
  <button disabled={!enabled} onClick={() => onSelect([106.69, 10.77])}>Fixture A</button>
  <button disabled={!enabled} onClick={() => onSelect([106.70, 10.78])}>Fixture B</button>
  <button disabled={!enabled} onClick={() => onSelect([106.71, 10.78])}>Fixture new A</button>
</div> }))
const missing = { state: 'missing_pbf', ready: false, pbf: { state: 'missing_pbf', path: 'TEST/data/raw/vietnam-latest.osm.pbf', size_bytes: null, format_verified: false, osmium_available: false }, artifacts: { map_ready: false, graph_ready: false, extracted_ready: false }, osrm: { state: 'unavailable', url: 'http://127.0.0.1:5000' }, region: { name: 'Trung tâm TP.HCM · Quận 1 cũ', display_bbox: [106.675, 10.75, 106.725, 10.795], routing_bbox: [106.66, 10.735, 106.74, 10.81] } }
describe('A0 data waiting UI', () => {
  it('shows missing PBF instructions and disables route controls', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => missing })
    vi.stubGlobal('fetch', fetch)
    render(<App />)
    expect(await screen.findByText('Thêm dữ liệu để mở bản đồ')).toBeInTheDocument()
    expect(screen.getByText(missing.pbf.path)).toBeInTheDocument()
    for (const label of ['Play', 'Pause', 'Reset', '1x', '2x', '4x', 'Xóa điểm A/B và chọn lại']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra dữ liệu' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls.every(([url]) => url === '/api/dataset/status')).toBe(true)
  })
  it('distinguishes a present unverified PBF from a prepared map', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...missing, state: 'artifacts_pending', pbf: { ...missing.pbf, state: 'present_unverified', size_bytes: 12345 } }) }))
    render(<App />)
    expect(await screen.findByText('PBF đã có. Chờ chuẩn bị bản đồ.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })
  it('explains backend connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline fixture')))
    render(<App />)
    expect(await screen.findByText('Kết nối backend để bắt đầu')).toBeInTheDocument()
  })
  it('resets route and playback on new endpoint selection', async () => {
    const routeFixture = { coordinates: [[106.69, 10.77], [106.695, 10.78], [106.70, 10.78]], duration: 100, distance: 1200, snap_points: [{ distance: 1 }, { distance: 2 }] }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/route' ? routeFixture : { ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true }, pbf: { ...missing.pbf, state: 'present_unverified' } } })))
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Fixture A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture B' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '4x' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture new A' }))
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '1x' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('1.20 km')).not.toBeInTheDocument()
  })
  it('aborts an in-flight route when points are cleared', async () => {
    let pendingSignal: AbortSignal | undefined
    const fetch = vi.fn().mockImplementation((url, options) => {
      if (url === '/api/route') { pendingSignal = options.signal; return new Promise(() => {}) }
      return Promise.resolve({ ok: true, json: async () => ({ ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true }, pbf: { ...missing.pbf, state: 'present_unverified' } }) })
    })
    vi.stubGlobal('fetch', fetch)
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Fixture A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture B' }))
    await waitFor(() => expect(pendingSignal).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Xóa điểm A/B và chọn lại' }))
    expect(pendingSignal?.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.queryByText('Đang yêu cầu tuyến từ OSRM local…')).not.toBeInTheDocument()
  })
  it('ignores an old successful response after a new A/B request', async () => {
    const resolves: ((value: unknown) => void)[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(url => url === '/api/route' ? new Promise(resolve => resolves.push(resolve)) : Promise.resolve({ ok: true, json: async () => ({ ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true } }) })))
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Fixture A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture B' }))
    await waitFor(() => expect(resolves).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture new A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture B' }))
    await waitFor(() => expect(resolves).toHaveLength(2))
    const fixtureRoute = { coordinates: [[106.71, 10.78], [106.70, 10.78]], duration: 100, distance: 2400, snap_points: [{ distance: 1 }, { distance: 2 }] }
    await act(async () => resolves[1]({ ok: true, json: async () => fixtureRoute }))
    expect(await screen.findByText('2.40 km')).toBeInTheDocument()
    await act(async () => resolves[0]({ ok: true, json: async () => ({ ...fixtureRoute, distance: 9900 }) }))
    expect(screen.queryByText('9.90 km')).not.toBeInTheDocument()
    expect(screen.getByText('2.40 km')).toBeInTheDocument()
  })
  it('shows loading and a structured route error without enabling playback', async () => {
    let rejectRoute: (value: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn().mockImplementation(url => url === '/api/route' ? new Promise(resolve => { rejectRoute = resolve }) : Promise.resolve({ ok: true, json: async () => ({ ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true } }) })))
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Fixture A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture B' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Đang yêu cầu tuyến')
    await act(async () => rejectRoute({ ok: false, json: async () => ({ error: { code: 'NOSEGMENT', message: 'fixture: cannot snap' } }) }))
    expect(await screen.findByRole('alert')).toHaveTextContent('NOSEGMENT: fixture: cannot snap')
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
