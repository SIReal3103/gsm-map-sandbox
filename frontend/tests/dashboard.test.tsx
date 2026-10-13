import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import App from '../src/App'

// Explorer regressions explicitly leave the default learned campaign workspace.
function renderExplorer() {
  window.history.replaceState(null, '', '/?mode=single')
  render(<App />)
  window.history.replaceState(null, '', '/')
}

// WebGL is intentionally mocked in component unit tests; browser QA is separate.
vi.mock('../src/components/sandbox-map', () => ({ SandboxMap: ({ enabled, onSelect }: { enabled: boolean; onSelect: (point: [number, number]) => void }) => <div data-testid="map-host">
  <button disabled={!enabled} onClick={() => onSelect([106.69, 10.77])}>Fixture A</button>
  <button disabled={!enabled} onClick={() => onSelect([106.70, 10.78])}>Fixture B</button>
  <button disabled={!enabled} onClick={() => onSelect([106.71, 10.78])}>Fixture new A</button>
</div> }))
const missing = { state: 'missing_pbf', ready: false, pbf: { state: 'missing_pbf', path: 'TEST/data/raw/vietnam-latest.osm.pbf', size_bytes: null, format_verified: false, osmium_available: false }, artifacts: { map_ready: false, graph_ready: false, extracted_ready: false }, osrm: { state: 'unavailable', url: 'http://127.0.0.1:5000' }, region: { name: 'Trung tâm TP.HCM · Quận 1 cũ', display_bbox: [106.675, 10.75, 106.725, 10.795], routing_bbox: [106.66, 10.735, 106.74, 10.81] } }
describe('A0 data waiting UI', () => {
  it('navigation and inspector changes preserve inputs and map DOM without preparing new routes', async () => {
    const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({...missing,ready:true,artifacts:{map_ready:true,graph_ready:true}})})
    vi.stubGlobal('fetch',fetcher); renderExplorer(); await waitFor(()=>expect(screen.getByRole('button',{name:'Fixture A'})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:'Đội xe'})); fireEvent.change(screen.getByLabelText('Scenario seed'),{target:{value:'retained-seed'}})
    const map=screen.getByTestId('map-host'); fireEvent.click(screen.getByRole('button',{name:'Collapse navigation'})); fireEvent.click(screen.getByRole('button',{name:'Hide navigation'})); fireEvent.click(screen.getByRole('button',{name:'Toggle inspector'}))
    expect(screen.getByTestId('map-host')).toBe(map); expect(screen.getByLabelText('Scenario seed')).toHaveValue('retained-seed')
    fireEvent.click(screen.getByRole('button',{name:'Toggle inspector'})); fireEvent.click(screen.getByRole('button',{name:'Fleet Configuration'})); fireEvent.click(screen.getByRole('button',{name:'Fleet Configuration'})); expect(screen.getByLabelText('Scenario seed')).toHaveValue('retained-seed'); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('shows missing PBF instructions and disables route controls', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => missing })
    vi.stubGlobal('fetch', fetch)
    renderExplorer()
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
    renderExplorer()
    expect(await screen.findByText('PBF đã có. Chờ chuẩn bị bản đồ.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })
  it('explains backend connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline fixture')))
    renderExplorer()
    expect(await screen.findByText('Kết nối backend để bắt đầu')).toBeInTheDocument()
  })
  it('resets route and playback on new endpoint selection', async () => {
    const routeFixture = { coordinates: [[106.69, 10.77], [106.695, 10.78], [106.70, 10.78]], duration: 100, distance: 1200, snap_points: [{ distance: 1 }, { distance: 2 }] }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/route' ? routeFixture : { ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true }, pbf: { ...missing.pbf, state: 'present_unverified' } } })))
    renderExplorer()
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
    renderExplorer()
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
    renderExplorer()
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
    renderExplorer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Fixture A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fixture B' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Đang yêu cầu tuyến')
    await act(async () => rejectRoute({ ok: false, json: async () => ({ error: { code: 'NOSEGMENT', message: 'fixture: cannot snap' } }) }))
    expect(await screen.findByRole('alert')).toHaveTextContent('NOSEGMENT: fixture: cannot snap')
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('fleet controls prepare routes, select vehicles, and switching mode clears fleet', async () => {
    const catalog = { candidates: Array.from({ length: 5 }, (_, i) => ({ id: `test-${i}`, osm_id: `test-${i}`, name: 'explicit fixture', coordinate: [106.69 + i*.001, 10.77] })), datasetFingerprint: 'ui-fixture', routingSource: 'fixture', provenance: { display_bbox: [106.675, 10.75, 106.725, 10.795] } }
    const fixtureRoute = { coordinates: [[106.69, 10.77], [106.70, 10.78]], duration: 100, distance: 1200, snap_points: [{ location: [106.69, 10.77], distance: 0 }, { location: [106.70, 10.78], distance: 0 }] }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/route' ? fixtureRoute : url === '/api/fleet/candidates' ? catalog : { ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true } } })))
    renderExplorer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Đội xe' }))
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Generate Scenario' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Đang chuẩn bị routes')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled())
    expect(document.querySelectorAll('[data-vehicle-row]')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Chọn GSM-03' }))
    expect(screen.getByRole('button', { name: 'Chọn GSM-03' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Focus GSM-03' }))
    fireEvent.click(screen.getByRole('button', { name: '4x' }))
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(document.querySelector('.fleet-panel')).toHaveAttribute('data-simulation-time', '0')
    fireEvent.click(screen.getByRole('button', { name: 'Một hành trình' }))
    expect(document.querySelectorAll('[data-vehicle-row]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })
  it('switching mode while fleet is loading aborts the candidate request', async () => {
    let candidateSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, options) => {
      if (url === '/api/fleet/candidates') { candidateSignal = options.signal; return new Promise(() => {}) }
      return Promise.resolve({ ok: true, json: async () => ({ ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true } }) })
    }))
    renderExplorer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Đội xe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate Scenario' }))
    await waitFor(() => expect(candidateSignal).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Một hành trình' }))
    expect(candidateSignal?.aborted).toBe(true)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('booking mode respects dataset readiness and has empty playback controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => missing }))
    renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Đặt và điều xe' }))
    expect(screen.getByRole('button', { name: 'Generate Booking Scenario' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Booking count' })).toHaveValue('20')
  })
  it('switching away from booking preparation aborts response and removes booking UI', async () => {
    let prepareSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, options) => {
      if (url === '/api/booking-simulation/prepare') { prepareSignal = options.signal; return new Promise(() => {}) }
      return Promise.resolve({ ok: true, json: async () => ({ ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true } }) })
    }))
    renderExplorer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Đặt và điều xe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate Booking Scenario' }))
    await waitFor(() => expect(prepareSignal).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Đội xe' }))
    expect(prepareSignal?.aborted).toBe(true)
    expect(document.querySelector('.booking-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })
  it('opens upstream simulation modes and returns to the learned campaign workspace', async () => {
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...missing, ready: true, artifacts: { map_ready: true, graph_ready: true } }) }))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Mở bản đồ' }))
    expect(screen.getAllByRole('button', { name: 'Chạy mô phỏng' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Khám phá tuyến' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture A' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Đặt và điều xe' }))
    expect(screen.getByRole('button', { name: 'Generate Booking Scenario' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Thí nghiệm voucher' }))
    expect(screen.getByRole('button', { name: 'Prepare Experiment' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Đội xe' }))
    expect(screen.getByRole('button', { name: 'Generate Scenario' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'WP3 · Mô phỏng Quận 1' }))
    for (const button of screen.getAllByRole('button', { name: 'Chạy mô phỏng' })) expect(button).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Generate Scenario' })).not.toBeInTheDocument()
  })
})
