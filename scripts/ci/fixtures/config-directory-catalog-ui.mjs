// S11 catalog 冒烟的页面交互 helpers：只封装 Playwright 等待/点击，
// 不持有 Host 或配置状态。setEnabled 是乐观更新：UI 状态变化不证明
// Host 已记录变更，断言 Host 侧 config 前必须等对应 scope 的 RPC settled。
export function createCatalogUi(page, samePath) {
  const trigger = page.getByTestId("plugin-settings-scope-trigger");
  const identity = (id) => `remote:server:${id}:${samePath}`;
  async function options() {
    await trigger.click();
    return page.getByRole("menuitemradio");
  }
  async function choose(key) {
    await options();
    const option = page.locator('[role="menuitemradio"]').filter({ hasText: key });
    await option.click();
  }
  async function chooseIdentity(selected) {
    await options();
    await page.locator('[role="menuitemradio"]').evaluateAll((items, key) => {
      const item = items.find((node) => node.getAttribute("data-testid")?.endsWith(key));
      if (!item) throw new Error("missing directory " + key);
      item.click();
    }, selected);
  }
  async function loaded(scope) {
    await page.waitForFunction((expected) => {
      const state = window.__pluginState();
      return !state.loading && state.plugins.some((plugin) => plugin.name === "Plugin " + expected);
    }, scope);
    await page.getByTestId("plugin-settings-enabled-switch").waitFor();
  }
  async function mutationSettled(scope, before) {
    await page.waitForFunction(
      ({ scope, before }) =>
        window.__rpc.filter(
          (call) => call.scope === scope && call.method === "setPluginEnabled" && call.settled,
        ).length > before,
      { scope, before },
    );
  }
  const settledMutations = (scope) =>
    page.evaluate(
      (id) =>
        window.__rpc.filter(
          (call) => call.scope === id && call.method === "setPluginEnabled" && call.settled,
        ).length,
      scope,
    );
  return {
    identity,
    trigger,
    options,
    choose,
    chooseIdentity,
    loaded,
    mutationSettled,
    settledMutations,
  };
}
