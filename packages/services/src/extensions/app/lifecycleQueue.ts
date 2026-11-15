/**
 * 唯一生命周期队列：start/stop/grant/revoke 串行执行，避免 start 与 stop 交叠时
 * 把 ready 进程发布到已经停止的状态，或撤销与授权互相覆盖。
 */
export function createLifecycleQueue(): <T>(run: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
