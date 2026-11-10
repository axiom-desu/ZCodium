// 手机 Web profile 浏览器断言的 DOM 观察工具；只读页面事实，不写业务状态。
export const SIDEBAR_WIDTH_KEY = "zcode:workspace-shell:sidebar-width-px";
const SHELL_SELECTOR = '[data-workspace-shell="true"]';
export const MOBILE_SHELL_SELECTOR = `${SHELL_SELECTOR}[data-mobile-web="true"]`;
const SIDEBAR_PANEL_SELECTOR = '[data-workspace-sidebar-panel="true"]';
export const SIDEBAR_SELECTOR = '[data-testid="workspace-sidebar"]';
export const WORKSPACE_HEADER_SELECTOR = '[data-testid="workspace-header"]';
// 真实 AnimatedSidePanePanel：外层 ResizablePanel 携带 data-panel/data-testid=browser，
// 内层 frame 才有 data-workspace-side-frame，并且没有 data-visible 状态属性。
export const SIDE_PANE_PANEL_SELECTOR = '[data-panel][data-testid="browser"]';
export const SIDE_FRAME_SELECTOR = '[data-workspace-side-frame="true"]';
export const SIDE_PANE_CLOSE_SELECTOR = `${SIDE_PANE_PANEL_SELECTOR} [data-testid="side-pane-toggle"]`;
export const SIDE_PANE_RESIZE_HANDLE_SELECTOR = '[data-workspace-side-pane-resize-handle="true"]';
// 只认 WorkspaceSidebarDrawer 新增的 testid，不再用任意 [data-slot=dialog-content] 兜底。
export const DRAWER_SELECTOR = '[data-testid="workspace-sidebar-drawer"]';
const BODY_LAYOUT_STORAGE_PREFIX = "react-resizable-panels:workspace-body-layout";
const MENU_SELECTORS = [
  '[data-testid="workspace-mobile-menu"]',
  '[data-testid="workspace-mobile-menu-toggle"]',
  '[data-testid="mobile-sidebar-toggle"]',
  '[data-testid="sidebar-mobile-toggle"]',
  '[data-testid="mobile-menu-button"]',
  '[data-testid="desktop-top-sidebar-toggle"]',
  'button[aria-label="Toggle sidebar"]',
  '[aria-label="Toggle sidebar"]',
];

// 元素自身和祖先的 opacity/display/visibility 共同决定是否真的可见。
// 真实面板收起时外层 ResizablePanel 是 opacity-0，内层 frame 自身仍可能 opacity=1；
// 只看 frame 自己的 computed style 会把收起态误判成可见。
// 注意：isSidebarVisibleInPage 会被 page.evaluate 序列化执行，不能在函数体里引用模块级 helper，
// 因此这里把祖先链判断写在函数内部。
export function isSidebarVisibleInPage() {
  const visible = (element) => {
    if (!element) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number(style.opacity) <= 0.05) return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };
  const panel = document.querySelector('[data-workspace-sidebar-panel="true"]');
  const sidebar = document.querySelector('[data-testid="workspace-sidebar"]');
  if (!panel || !sidebar) return false;
  return (
    visible(panel) &&
    sidebar.getBoundingClientRect().width > 10 &&
    sidebar.closest('[aria-hidden="true"]') === null
  );
}

export async function sidebarPanelWidth(page) {
  // 这里只读布局事实，不执行动作；避免额外的 ElementHandle/CDP box-model 往返。
  return page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    return panel ? Math.round(panel.getBoundingClientRect().width) : 0;
  }, SIDEBAR_PANEL_SELECTOR);
}

export async function frameVisible(page) {
  return (await visibleCount(page, SIDE_FRAME_SELECTOR)) > 0;
}

export async function visibleCount(page, selector) {
  return page.evaluate((css) => {
    const visible = (element) => {
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (Number(style.opacity) <= 0.05) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
    };
    return [...document.querySelectorAll(css)].filter(visible).length;
  }, selector);
}

export async function waitVisibleCount(page, selector, expected) {
  await page.waitForFunction(
    ({ css, count }) => {
      const visible = (element) => {
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (Number(style.opacity) <= 0.05) return false;
        }
        const box = element.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      };
      const actual = [...document.querySelectorAll(css)].filter(visible).length;
      return count === 0 ? actual === 0 : actual >= count;
    },
    { css: selector, count: expected },
    { timeout: 8000 },
  );
}

export async function focusInside(page, selector) {
  return page.evaluate(
    (css) =>
      [...document.querySelectorAll(css)].some((element) =>
        element.contains(document.activeElement),
      ),
    selector,
  );
}

export async function accessibleName(page, selector) {
  return page.evaluate((css) => {
    const dialog = [...document.querySelectorAll(css)].find(
      (element) => element.getBoundingClientRect().width > 1,
    );
    if (!dialog) return "";
    const label = dialog.getAttribute("aria-label")?.trim();
    if (label) return label;
    const labelledBy = dialog.getAttribute("aria-labelledby");
    return labelledBy
      ? labelledBy
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim()
      : "";
  }, selector);
}

async function requireLocator(page, selectors, label) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
  }
  throw new Error(`${label} missing; expected one of ${selectors.join(" | ")}`);
}

export async function openMobileDrawer(page) {
  await (await requireLocator(page, MENU_SELECTORS, "web profile mobile menu toggle")).click();
  await waitVisibleCount(page, DRAWER_SELECTOR, 1);
}

export async function readElementBox(page, selector) {
  return page.evaluate((css) => {
    const element = document.querySelector(css);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }, selector);
}

async function readComposerState(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="v4-composer-input"]');
    const dock = document.querySelector('[data-v4-composer-dock="true"]');
    return {
      fontSize: input ? Number.parseFloat(getComputedStyle(input).fontSize) : null,
      text: (input?.textContent ?? "").trim(),
      mountMarker: input?.dataset.e2eEditorMount ?? "",
      draftLength: Number(dock?.getAttribute("data-composer-draft-length") ?? Number.NaN),
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    };
  });
}

export async function assertNoOverflow(page, label) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    root: document.getElementById("root")?.scrollWidth ?? 0,
    shell: document.querySelector('[data-workspace-shell="true"]')?.scrollWidth ?? 0,
  }));
  if (
    widths.html > widths.viewport + 1 ||
    widths.body > widths.viewport + 1 ||
    widths.root > widths.viewport + 1 ||
    widths.shell > widths.viewport + 1
  ) {
    throw new Error(`${label}: horizontal overflow ${JSON.stringify(widths)}`);
  }
}

async function readContentFrameBox(page) {
  return page.locator('[data-workspace-conversation-frame="true"]').boundingBox();
}

export async function assertContentFullWidth(page, label) {
  const viewport = page.viewportSize();
  // 面板关闭有 200ms 宽度/透明度过渡；等 conversation 列真正回到全宽再断言，
  // 不用动画中间帧判断，也不给永久半宽留兜底。
  await waitElementFullWidth(
    page,
    '[data-workspace-conversation-frame="true"]',
    viewport.width,
  ).catch(() => {});
  const box = await readContentFrameBox(page);
  if (!box) throw new Error(`${label}: conversation frame has no box`);
  if (!(box.x <= 1 && box.width >= viewport.width - 2)) {
    throw new Error(`${label}: content is not full width ${JSON.stringify({ box, viewport })}`);
  }
}

export async function assertComposerDraft(page, expectedText, label) {
  const state = await readComposerState(page);
  if (state.text !== expectedText) {
    throw new Error(`${label}: typed composer draft was lost (got ${JSON.stringify(state.text)})`);
  }
  if (state.mountMarker !== "1") {
    throw new Error(`${label}: composer editor was remounted, so the draft owner changed`);
  }
  // onChange 由真实 Lexical 更新监听驱动；长度对不上说明夹具没有真正收到编辑器事件。
  if (state.draftLength !== expectedText.length) {
    throw new Error(
      `${label}: fixture draft state was not fed by the real Lexical onChange (${state.draftLength} vs ${expectedText.length})`,
    );
  }
}

export async function assertComposerFontSize(page, expected, label) {
  const state = await readComposerState(page);
  if (state.fontSize !== expected) {
    throw new Error(`${label}: real Lexical composer font size was ${state.fontSize}`);
  }
}

export async function waitElementFullWidth(page, selector, width) {
  await page.waitForFunction(
    ({ css, targetWidth }) => {
      const box = document.querySelector(css)?.getBoundingClientRect();
      return Boolean(box && box.x <= 1 && box.width >= targetWidth - 2);
    },
    { css: selector, targetWidth: width },
    { timeout: 8000 },
  );
}

export async function readStableWorkspaceBodyLayoutStorage(page) {
  let previous = await readWorkspaceBodyLayoutStorage(page);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(200);
    const next = await readWorkspaceBodyLayoutStorage(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  return previous;
}

async function readWorkspaceBodyLayoutStorage(page) {
  return page.evaluate((prefix) => {
    const entries = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) entries[key] = localStorage.getItem(key);
    }
    return Object.fromEntries(
      Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
    );
  }, BODY_LAYOUT_STORAGE_PREFIX);
}

export function desktopBodyLayoutEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => !key.includes("workspace-body-layout-mobile")),
  );
}

export async function readWorkspaceBodyLayoutRatios(page) {
  return page.evaluate(() => {
    const conversation = document.getElementById("conversation-column");
    const sidePane = document.querySelector('[data-panel][data-testid="browser"]');
    const group = conversation?.parentElement;
    if (!conversation || !sidePane || !group) return null;
    const groupWidth = group.getBoundingClientRect().width;
    if (groupWidth <= 0) return null;
    return {
      groupWidth: Math.round(groupWidth),
      conversation: Number((conversation.getBoundingClientRect().width / groupWidth).toFixed(4)),
      sidePane: Number((sidePane.getBoundingClientRect().width / groupWidth).toFixed(4)),
    };
  });
}
