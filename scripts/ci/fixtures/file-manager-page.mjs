// FileManager 导航冒烟的页面交互 helpers：只封装 Playwright 等待/求值，
// 不持有 Host 或目录状态。fixture.target 镜像 React 已提交的 state；
// 同一路径换 identity 时旧行仍在 DOM，必须等 target 真正换代，
// 否则 CI 时序下会读到旧 identity 的展开偏好。
export function createFileManagerPage(page, prefKey) {
  const readPrefs = () =>
    page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    }, prefKey);
  const setDelay = (workspacePath, delay) =>
    page.evaluate(
      ({ path, ms }) => {
        window.fileManagerFixture.delayByWorkspace[path] = ms;
      },
      { path: workspacePath, ms: delay },
    );
  const setTarget = (target) =>
    page
      .evaluate((next) => window.fileManagerFixture.setTarget(next), target)
      .then(() =>
        page.waitForFunction((next) => {
          const current = window.fileManagerFixture.target;
          return (
            current.workspacePath === next.workspacePath &&
            (current.workspaceIdentity ?? null) === (next.workspaceIdentity ?? null) &&
            (current.workspaceRemoteSessionId ?? null) === (next.workspaceRemoteSessionId ?? null)
          );
        }, target),
      );
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await page.evaluate(predicate)) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`fixture state timeout: ${label}`);
  };
  return { readPrefs, setDelay, setTarget, waitFor };
}
