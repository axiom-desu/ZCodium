/** 只持有手势期间的 viewport/指针/RAF；不读取项目事实或提交命令。 */
export function createProjectGroupedEdgeScroll(
  root: HTMLElement,
  onScroll: (x: number, y: number) => void,
) {
  let viewport = root.parentElement;
  while (viewport) {
    if (
      /(auto|scroll)/.test(window.getComputedStyle(viewport).overflowY) &&
      viewport.scrollHeight > viewport.clientHeight
    )
      break;
    viewport = viewport.parentElement;
  }
  let frame: number | null = null;
  let previousTime: number | null = null;
  let point: { x: number; y: number } | null = null;

  const velocity = () => {
    if (!viewport?.isConnected || !point) return 0;
    const rect = viewport.getBoundingClientRect();
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (point.x < rect.left || point.x > rect.right || point.y < top || point.y > bottom) return 0;
    const edge = Math.min(48, (bottom - top) / 3);
    if (edge <= 0) return 0;
    if (point.y < top + edge) return -720 * (1 - (point.y - top) / edge);
    if (point.y > bottom - edge) return 720 * (1 - (bottom - point.y) / edge);
    return 0;
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previousTime = null;
    point = null;
  };
  const tick = (time: number) => {
    frame = null;
    const speed = velocity();
    if (!viewport || !point || speed === 0) {
      stop();
      return;
    }
    const elapsed = previousTime === null ? 16 : Math.min(32, Math.max(0, time - previousTime));
    previousTime = time;
    const before = viewport.scrollTop;
    // 必须滚动真实 overflow viewport；仅重排 preview 无法到达屏外行。
    viewport.scrollTop = Math.max(
      0,
      Math.min(viewport.scrollHeight - viewport.clientHeight, before + (speed * elapsed) / 1000),
    );
    if (viewport.scrollTop === before) {
      stop();
      return;
    }
    // 指针静止时也要在滚动后的 DOM 上重命中，不能沿用旧 rect/anchor。
    onScroll(point.x, point.y);
    if (point) frame = requestAnimationFrame(tick);
  };
  return {
    update(x: number, y: number) {
      point = { x, y };
      if (velocity() === 0) {
        stop();
        return;
      }
      if (frame === null) frame = requestAnimationFrame(tick);
    },
    stop,
  };
}
