import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/** Hidden content stays mounted so configuration and filters survive collapse. */
export function InspectorSection({ title, children, defaultOpen = false, prepared = false, selection = '' }: {
  title: string; children: ReactNode; defaultOpen?: boolean; prepared?: boolean; selection?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  useEffect(() => { if (prepared) setOpen(false) }, [prepared])
  useEffect(() => { if (selection) setOpen(true) }, [selection])
  return <section className="inspector-section">
    <button className="inspector-heading" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{title}<ChevronDown size={15} /></button>
    <div id={id} hidden={!open} className="inspector-content">{children}</div>
  </section>
}
