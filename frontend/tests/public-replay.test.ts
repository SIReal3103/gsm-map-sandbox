import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it('public replay fetches saved campaign without transmitting generation parameters', async () => {
  vi.stubEnv('VITE_PUBLIC_REPLAY', '1')
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 'saved' }) })
  vi.stubGlobal('fetch', fetcher)
  expect(await api('/api/wp3/campaign', { method: 'POST', body: 'private-input' })).toEqual({ version: 'saved' })
  expect(fetcher).toHaveBeenCalledWith('/map-runtime/campaign.json', { signal: undefined })
})
it('public replay blocks unsupported live operations before any request', async () => {
  vi.stubEnv('VITE_PUBLIC_REPLAY', '1')
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(api('/api/route')).rejects.toThrow('Bản public chỉ phát lại')
  expect(fetcher).not.toHaveBeenCalled()
})
