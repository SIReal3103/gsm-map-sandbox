import { Car, FlaskConical, Route, Users, PanelLeftClose, EyeOff, X } from 'lucide-react'
import { Dialog } from '@base-ui/react/dialog'
import { Button } from './ui/button'

type Mode = 'single' | 'fleet' | 'booking' | 'voucher'
type NavigationSize = 'expanded' | 'collapsed' | 'hidden'
const modes = [
  { id: 'single', label: 'Single Trip', icon: Route },
  { id: 'fleet', label: 'Fleet Simulation', icon: Car },
  { id: 'booking', label: 'Booking & Dispatch', icon: Users },
  { id: 'voucher', label: 'Voucher Experiment Studio', icon: FlaskConical },
] as const

export function PrimaryNavigation({ mode, size, onMode, onSize, mobileOpen, onMobileOpen }: {
  mode: Mode; size: NavigationSize; onMode: (mode: Mode) => void; onSize: (size: NavigationSize) => void
  mobileOpen: boolean; onMobileOpen: (open: boolean) => void
}) {
  const menu = (mobile: boolean) => <nav aria-label={mobile ? 'Mobile main menu' : 'Main menu'}>{modes.map(item => <button key={item.id} title={item.label} aria-label={item.label} aria-current={mode === item.id ? 'page' : undefined} onClick={() => { onMode(item.id); onMobileOpen(false) }}><item.icon size={19} /><span>{item.label}</span></button>)}</nav>
  return <>
    <aside className={`primary-navigation ${size}`} aria-label="Primary navigation" hidden={size === 'hidden'}>
      <p className="nav-caption">SIMULATION MODES</p>{menu(false)}
      <div className="nav-actions"><Button variant="ghost" aria-label={size === 'expanded' ? 'Collapse navigation' : 'Expand navigation'} onClick={() => onSize(size === 'expanded' ? 'collapsed' : 'expanded')}><PanelLeftClose size={18} /></Button><Button variant="ghost" aria-label="Hide navigation" onClick={() => onSize('hidden')}><EyeOff size={18}/></Button></div>
      <small>Local simulation<br/>OSM · OSRM</small>
    </aside>
    <Dialog.Root open={mobileOpen} onOpenChange={onMobileOpen}>
      <Dialog.Portal><Dialog.Backdrop className="sheet-backdrop"/><Dialog.Popup className="navigation-sheet"><Dialog.Title>Main menu</Dialog.Title><Dialog.Description>Chọn chế độ mô phỏng</Dialog.Description><Dialog.Close aria-label="Close menu" className="sheet-close"><X size={20}/></Dialog.Close>{menu(true)}</Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
  </>
}
