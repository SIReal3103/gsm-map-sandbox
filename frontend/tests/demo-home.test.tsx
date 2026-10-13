import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DemoHome } from '../src/components/demo-home'
import { offerLabel, type DemoOffer } from '../src/lib/demo-content'
import content from '../public/demo/demo-content.json'

describe('guided demo uses the current verified research readings', () => {
  it('explains customer choice separately from guaranteed nearest eligible driver acceptance', async () => {
    const onMode = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => content }))
    render(<DemoHome ready onMode={onMode} />)
    expect(await screen.findByText('Quy tắc nhận chuyến')).toBeInTheDocument()
    expect(screen.getByText(/Xe rảnh phù hợp gần nhất luôn nhận booking/)).toHaveTextContent('Khách vẫn có thể không đặt')
    fireEvent.click(screen.getByRole('button', { name: /WP3 · Xe có phục vụ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Mở mô phỏng Quận 1' }))
    expect(onMode).toHaveBeenCalledWith('wp3')
  })
  it('keeps an ineligible offer unestimated and formats fractional percent offers correctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => content }))
    render(<DemoHome ready onMode={vi.fn()} />)
    await screen.findByText('Quy tắc nhận chuyến')
    fireEvent.click(screen.getByRole('button', { name: /WP2 · Chọn ưu đãi/ }))
    const row = screen.getByRole('row', { name: /Giảm 10.000 ₫/ })
    expect(row).toHaveTextContent('Không ước tính')
    expect(row).toHaveTextContent('Không đủ điều kiện')
    const offer = content.examples[0].offers.find(item => item.kind === 'percent') as DemoOffer
    expect(offerLabel(offer)).toContain('10%')
    expect(screen.getByText(/hồ sơ thuộc tập huấn luyện/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Chọn chuyến mẫu'), { target: { value: '2' } })
    expect(screen.getByText(`${content.examples[2].origin} → ${content.examples[2].destination}`)).toBeInTheDocument()
  })
  it('reports both failed targets without mixing the later inactive model into the map result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => content }))
    render(<DemoHome ready onMode={vi.fn()} />)
    await screen.findByText('Quy tắc nhận chuyến')
    fireEvent.click(screen.getByRole('button', { name: /Kết quả/ }))
    expect(screen.getByText('1,56%')).toBeInTheDocument()
    expect(screen.getByText('+0,065%')).toBeInTheDocument()
    expect(screen.getByText('Chưa đạt mục tiêu 2%')).toBeInTheDocument()
    expect(screen.getByText('Chưa đạt mục tiêu +5%')).toBeInTheDocument()
    expect(screen.getByText(/chưa kích hoạt trên map/)).toBeInTheDocument()
  })
  it('supports retry after a missing content asset rather than showing invented examples', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, json: async () => content })
    vi.stubGlobal('fetch', fetcher)
    render(<DemoHome ready={false} onMode={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tải được nội dung demo')
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    expect(await screen.findByText('Quy tắc nhận chuyến')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
