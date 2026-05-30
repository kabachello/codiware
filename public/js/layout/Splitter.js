/** Drag-to-resize splitter shared by sidebar/bottom panels. */
export function attachSplitter(el, { orientation = 'vertical', onResize }) {
  let dragging = false;
  let start = 0;
  let startSize = 0;
  const isV = orientation === 'vertical';

  el.addEventListener('mousedown', (e) => {
    dragging = true;
    start = isV ? e.clientX : e.clientY;
    startSize = onResize.getSize();
    document.body.style.cursor = isV ? 'col-resize' : 'row-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = (isV ? e.clientX : e.clientY) - start;
    onResize.apply(startSize + delta * (onResize.invert ? -1 : 1));
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  });
}
