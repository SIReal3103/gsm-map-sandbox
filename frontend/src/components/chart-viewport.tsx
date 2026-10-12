import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Recharts outside the independently scrolling panel need no layout work. */
export function ChartViewport({ title, children }: { title: string; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: host.current.closest('.analytics-panel'), rootMargin: '100px',
    })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={host} className="chart-viewport" data-chart-viewport={title}>
    {visible ? children : <div className="chart-placeholder"><h3>{title}</h3><p>Biểu đồ hiển thị khi cuộn tới vùng này.</p></div>}
  </div>
}
