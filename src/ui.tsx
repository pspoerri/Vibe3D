import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * A modal on the platform's <dialog>: focus trap, Esc and the top layer come
 * free. Its children mount only while open, so a closed dialog holds no state
 * and costs no render. A click on the backdrop closes it — the backdrop is the
 * dialog element itself, the card is the div inside.
 */
export function Dialog({
  open,
  onClose,
  label,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  label: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={className ? `dialog ${className}` : 'dialog'}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && <div className="dialog-card">{children}</div>}
    </dialog>
  )
}

/**
 * A button that opens a list of actions, on the popover API: light dismiss
 * and Esc are native. Placed under its button by hand, because CSS anchor
 * positioning is not in every browser yet.
 */
export function Menu({
  label,
  title,
  className,
  align = 'start',
  disabled,
  children,
}: {
  label: ReactNode
  title?: string
  className?: string
  align?: 'start' | 'end'
  disabled?: boolean
  /** Rendered items; call `close` from each before acting. */
  children: (close: () => void) => ReactNode
}) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const place = () => {
    const at = button.current?.getBoundingClientRect()
    const el = pop.current
    if (!at || !el) return
    el.style.top = `${at.bottom + 6}px`
    if (align === 'end') {
      el.style.left = 'auto'
      el.style.right = `${window.innerWidth - at.right}px`
    } else {
      el.style.right = 'auto'
      el.style.left = `${at.left}px`
    }
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        title={title}
        disabled={disabled}
        popoverTarget={id}
        aria-haspopup="menu"
        onClick={place}
      >
        {label}
      </button>
      <div ref={pop} id={id} popover="auto" role="menu" className="menu">
        {children(() => pop.current?.hidePopover())}
      </div>
    </>
  )
}

/** "5 minutes ago" from a timestamp, via the platform's own formatter. */
const STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60_000, 'minute'],
  [3_600_000, 'hour'],
  [86_400_000, 'day'],
]
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function whenEdited(ts: number): string {
  const ago = Date.now() - ts
  if (ago < 60_000) return 'just now'
  for (const [size, unit] of STEPS) {
    if (ago < size * 60 || unit === 'day') return RELATIVE.format(-Math.floor(ago / size), unit)
  }
  return RELATIVE.format(-Math.floor(ago / 86_400_000), 'day')
}

/** A document name as a file name. */
export const fileName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '_')
