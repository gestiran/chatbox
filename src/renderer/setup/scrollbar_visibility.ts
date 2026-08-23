/**
 * Controls when the custom overlay scrollbars are visible.
 *
 * The global stylesheet (static/index.css) keeps scrollbar thumbs transparent
 * by default and reveals them while a scroll container carries one of:
 *
 * - `scrollbar-scrolling`: added while the element receives scroll events and
 *   removed after a short idle delay.
 * - `scrollbar-hover`: added while the pointer rests anywhere inside the
 *   element's scrollbar gutter (track included) and kept until the pointer
 *   leaves the gutter. This works even if the element has not been scrolled
 *   recently, so hovering an idle scrollbar reveals it.
 */

const SCROLLING_CLASS = 'scrollbar-scrolling'
const HOVER_CLASS = 'scrollbar-hover'

/** Idle delay before a scrollbar is hidden again after the last scroll event. */
const SCROLLBAR_HIDE_DELAY = 600
/** Re-check interval used to keep a hovered scrollbar visible. */
const HOVER_RECHECK_DELAY = 200

/**
 * Hit-test width of a scrollbar gutter. The styled bar itself is 9px wide;
 * the small tolerance makes it easier to target with the pointer.
 */
const GUTTER_HIT_SIZE = 12

function getScrollElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target
  }
  if (target === document) {
    return document.scrollingElement
  }
  return null
}

// ---------------------------------------------------------------------------
// Reveal while scrolling
// ---------------------------------------------------------------------------

const hideTimers = new WeakMap<Element, number>()

function scheduleHide(element: Element, delay: number) {
  const previousTimer = hideTimers.get(element)
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer)
  }
  hideTimers.set(
    element,
    window.setTimeout(() => {
      hideTimers.delete(element)
      if (element.classList.contains(HOVER_CLASS)) {
        // The pointer rests inside the scrollbar gutter: keep the scrollbar
        // visible and re-check again shortly instead of hiding it.
        scheduleHide(element, HOVER_RECHECK_DELAY)
        return
      }
      element.classList.remove(SCROLLING_CLASS)
    }, delay)
  )
}

document.addEventListener(
  'scroll',
  (event) => {
    const element = getScrollElement(event.target)
    if (!element) {
      return
    }

    element.classList.add(SCROLLING_CLASS)
    scheduleHide(element, SCROLLBAR_HIDE_DELAY)
  },
  { capture: true, passive: true }
)

// ---------------------------------------------------------------------------
// Reveal on hover over the scrollbar gutter
// ---------------------------------------------------------------------------

function isUserScrollable(element: Element): boolean {
  const style = window.getComputedStyle(element)
  return (
    style.overflowY === 'auto' ||
    style.overflowY === 'scroll' ||
    style.overflowX === 'auto' ||
    style.overflowX === 'scroll'
  )
}

function coversScrollbarGutter(element: Element, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return false
  }
  const verticalOnLeft = window.getComputedStyle(element).direction === 'rtl'
  const withinX = x >= rect.left && x <= rect.right
  const withinY = y >= rect.top && y <= rect.bottom
  const nearRightEdge = x >= rect.right - GUTTER_HIT_SIZE && x <= rect.right
  const nearLeftEdge = x >= rect.left && x <= rect.left + GUTTER_HIT_SIZE
  const nearBottomEdge = y >= rect.bottom - GUTTER_HIT_SIZE && y <= rect.bottom
  const inVerticalGutter = withinY && (verticalOnLeft ? nearLeftEdge : nearRightEdge)
  const inHorizontalGutter = withinX && nearBottomEdge
  return inVerticalGutter || inHorizontalGutter
}

let hoveredElements = new Set<Element>()
let latestPointerMove: { x: number; y: number; target: EventTarget | null } | null = null
let updateFrameHandle = 0

function updateHoverStates() {
  updateFrameHandle = 0
  const move = latestPointerMove
  if (!move) {
    return
  }

  const matched = new Set<Element>()
  let node = move.target instanceof Element ? move.target : getScrollElement(move.target)
  while (node) {
    if (!matched.has(node) && isUserScrollable(node) && coversScrollbarGutter(node, move.x, move.y)) {
      matched.add(node)
    }
    node = node.parentElement
  }

  for (const element of hoveredElements) {
    if (!matched.has(element)) {
      element.classList.remove(HOVER_CLASS)
    }
  }
  for (const element of matched) {
    element.classList.add(HOVER_CLASS)
  }
  hoveredElements = matched
}

window.addEventListener(
  'pointermove',
  (event) => {
    latestPointerMove = { x: event.clientX, y: event.clientY, target: event.target }
    if (updateFrameHandle === 0) {
      updateFrameHandle = window.requestAnimationFrame(updateHoverStates)
    }
  },
  { capture: true, passive: true }
)

function clearHover() {
  for (const element of hoveredElements) {
    element.classList.remove(HOVER_CLASS)
  }
  hoveredElements = new Set()
}

window.addEventListener('blur', clearHover)
document.documentElement.addEventListener('mouseleave', clearHover)

export {}
