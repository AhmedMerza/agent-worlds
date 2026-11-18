import { gsap } from 'gsap'

/** Motion tokens (house motion system): change a feel here, not in the components. */
export const EASE = { surface: 'expo.out', content: 'power3.out', pop: 'back.out(1.6)', exit: 'power2.in' } as const
export const DUR = { surface: 0.6, content: 0.55, pop: 0.42, exit: 0.18 } as const

export const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
/** Gap between siblings: shorter the more there are, so a cascade never runs past ~700 ms. */
export const staggerOf = (n: number): number => Math.min(80, Math.max(35, 500 / Math.max(1, n))) / 1000

/**
 * An overlay opening: the scrim fades, the panel pops from the control that opened it (a sheet on a phone
 * slides up instead), then its regions and their rows come in, in reading order.
 * Returns the context to revert on unmount. Nothing is hidden by CSS: if this never runs, all is visible.
 */
export function openOverlay(root: HTMLElement, panel: HTMLElement, trigger: Element | null, sheet: boolean): gsap.Context | null {
  if (reduced()) return null
  return gsap.context(() => {
    const tl = gsap.timeline({ defaults: { overwrite: 'auto' } })
    tl.from(root, { opacity: 0, duration: 0.2, ease: 'none', clearProps: 'opacity' }, 0)
    if (sheet) tl.from(panel, { y: 40, opacity: 0, duration: DUR.surface, ease: EASE.surface, clearProps: 'transform,opacity' }, 0)
    else {
      const p = panel.getBoundingClientRect(), t = trigger?.getBoundingClientRect()
      const origin = t ? `${t.left + t.width / 2 - p.left}px ${t.top + t.height / 2 - p.top}px` : '50% 0%'
      tl.from(panel, { scale: 0.92, y: 8, opacity: 0, transformOrigin: origin, duration: DUR.pop, ease: EASE.pop, clearProps: 'transform,opacity,transformOrigin' }, 0)
    }
    const regions = panel.querySelectorAll<HTMLElement>('[data-enter]')
    tl.from(regions, { y: 12, opacity: 0, duration: DUR.content, ease: EASE.content, stagger: 0.1, clearProps: 'transform,opacity' }, 0.08)
    const rows = panel.querySelectorAll<HTMLElement>('[data-enter-row]')
    if (rows.length) tl.from(rows, { y: 10, opacity: 0, duration: DUR.content, ease: EASE.content, stagger: staggerOf(rows.length), clearProps: 'transform,opacity' }, 0.22)
  }, root)
}

/** Closing: everything together, fast. */
export function leaveOverlay(el: Element, done: () => void) {
  if (reduced()) return done()
  const panel = el.firstElementChild
  gsap.to(el, { opacity: 0, duration: DUR.exit, ease: EASE.exit, onComplete: done })
  if (panel) gsap.to(panel, { y: 6, scale: 0.98, duration: DUR.exit, ease: EASE.exit })
}

/** A row that arrives while the list is open (TransitionGroup enter). */
export function enterRow(el: Element, done: () => void) {
  if (reduced()) return done()
  const i = Number((el as HTMLElement).dataset.index ?? 0)
  gsap.from(el, { y: 10, opacity: 0, duration: DUR.content, ease: EASE.content, delay: Math.min(i, 8) * 0.05, clearProps: 'transform,opacity', onComplete: done })
}

/** A row that leaves (filed or dropped out of the inbox): taken out of the flow so the rest slide up (the list's move class). */
export function leaveRow(el: Element, done: () => void) {
  const e = el as HTMLElement
  if (reduced()) return done()
  e.style.width = `${e.offsetWidth}px`; e.style.top = `${e.offsetTop}px`; e.style.left = `${e.offsetLeft}px`; e.style.position = 'absolute'
  gsap.to(e, { opacity: 0, x: 12, duration: DUR.exit, ease: EASE.exit, onComplete: done })
}

/** The secondary reaction: something that just changed (a count, a Filed badge) lands with a little overshoot. */
export function pop(el: Element | null | undefined, from = 0.7) {
  if (!el || reduced()) return
  gsap.fromTo(el, { scale: from }, { scale: 1, duration: DUR.pop, ease: 'back.out(2.2)', overwrite: 'auto', clearProps: 'transform' })
}
