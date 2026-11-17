/** Drag-to-resize splitter shared by sidebar/bottom panels. */
export function attachSplitter(el, { orientation = 'vertical', onResize }) {
  let dragging = false;
  let start = 0;
  let startSize = 0;
  const isV = orientation === 'vertical';

  const down = (e) => {
    dragging = true;
    start = isV ? e.clientX : e.clientY;
    startSize = onResize.getSize();
    document.body.style.cursor = isV ? 'col-resize' : 'row-resize';
    e.preventDefault();
  };

  const move = (e) => {
    if (!dragging) return;
    const delta = (isV ? e.clientX : e.clientY) - start;
    onResize.apply(startSize + delta * (onResize.invert ? -1 : 1));
  };

  const up = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  };
  el.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  return () => {
    up();
    el.removeEventListener('mousedown', down);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
}
