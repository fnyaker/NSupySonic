// Scroll a child element into view within a scroll container, keeping it at a
// fixed fraction down the viewport (default: the first quarter). Used so the
// active queue track / lyric line follows playback instead of scrolling off.
export function followScroll(container, el, { ratio = 0.25, smooth = true } = {}) {
  if (!container || !el) return;
  const cr = container.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const top = container.scrollTop + (er.top - cr.top) - container.clientHeight * ratio;
  container.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
}
