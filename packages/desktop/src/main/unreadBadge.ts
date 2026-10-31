type AppBadgeSetter = (count: number) => void;

export function parseWindowUnreadCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) {
    return null;
  }

  return payload;
}

// 各窗口汇报的未读数已统一为「全局权威树计数」（侧栏蓝点同源），并非窗口私有值：
// 多窗口时所有窗口上报同一个数，取 max 而不是求和，避免未来放开多主窗口时角标翻倍。
export function maxWindowUnreadCounts(windowUnreadCountMap: ReadonlyMap<number, number>): number {
  let maxUnreadCount = 0;

  for (const unreadCount of windowUnreadCountMap.values()) {
    maxUnreadCount = Math.max(maxUnreadCount, unreadCount);
  }

  return maxUnreadCount;
}

// 应用级 badge：macOS Dock / Linux LauncherEntry。
export function supportsAppUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

// Windows 的 app.setBadgeCount 是 no-op，任务栏角标要走窗口级 overlay（setOverlayIcon）。
export function supportsWindowOverlayBadge(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

// 任务栏 overlay 图由主进程自绘，只认字符串文案；0 返回 null 表示移除角标。
export function resolveBadgeOverlayLabel(totalUnreadCount: number): string | null {
  if (!Number.isInteger(totalUnreadCount) || totalUnreadCount <= 0) {
    return null;
  }

  return totalUnreadCount > 9 ? "9+" : String(totalUnreadCount);
}

export function syncUnreadBadgeForPlatform(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
  applyOverlay: (label: string | null) => void;
}): void {
  if (supportsAppUnreadBadge(options.platform)) {
    options.setBadgeCount(options.totalUnreadCount);
    return;
  }

  if (supportsWindowOverlayBadge(options.platform)) {
    options.applyOverlay(resolveBadgeOverlayLabel(options.totalUnreadCount));
  }
}

const BADGE_CIRCLE_COLOR = { red: 229, green: 57, blue: 53 } as const;

interface AntialiasedDotOptions {
  size: number;
  centerX: number;
  centerY: number;
  radius: number;
  supersample?: number;
}

// 输出预乘 alpha 的 BGRA（与 Electron toBitmap / createFromBitmap 契约一致）：
// 圆内完全不透明（预乘不改变通道值），圆外全透明，不遮挡底图。
// 4× 超采样让边缘出现部分覆盖像素，避免把硬边 32px 圆交给 Shell 盲缩后发糊。
export function renderAntialiasedStatusDotPixels(options: AntialiasedDotOptions): Uint8Array {
  const supersample = options.supersample ?? 4;
  const pixels = new Uint8Array(options.size * options.size * 4);
  const samplesPerPixel = supersample * supersample;

  for (let y = 0; y < options.size; y += 1) {
    for (let x = 0; x < options.size; x += 1) {
      let coveredSamples = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const sampleX = x + (sx + 0.5) / supersample;
          const sampleY = y + (sy + 0.5) / supersample;
          const dx = sampleX - options.centerX;
          const dy = sampleY - options.centerY;
          if (dx * dx + dy * dy <= options.radius * options.radius) coveredSamples += 1;
        }
      }

      if (coveredSamples === 0) continue;
      const coverage = coveredSamples / samplesPerPixel;
      const offset = (y * options.size + x) * 4;
      // 预乘 alpha：抗锯齿边缘保持同一红色，不与底图混成白边或脏边。
      pixels[offset] = Math.round(BADGE_CIRCLE_COLOR.blue * coverage);
      pixels[offset + 1] = Math.round(BADGE_CIRCLE_COLOR.green * coverage);
      pixels[offset + 2] = Math.round(BADGE_CIRCLE_COLOR.red * coverage);
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }

  return pixels;
}

type TaskbarOverlayLayout = "windows-10" | "windows-11";

/**
 * Windows taskbar overlay 固定显示 16×16。直接把硬边 32px 圆交给 Shell 缩放会产生
 * 模糊/缺口；这里在目标尺寸上超采样，生成纯红色、抗锯齿的预乘 BGRA 圆点。
 * scale=1 产出原生 16px 表示，scale=2 产出 32px 高 DPI 表示。
 */
export function renderTaskbarStatusDotPixels(
  scale: 1 | 2 = 1,
  layout: TaskbarOverlayLayout = "windows-11",
): Uint8Array {
  // 两代 Windows Shell 对 16×16 overlay 的任务栏落点不同：
  // Win10 需要画布内右下锚定；Win11 已把整张 overlay 放到图标角上，需画布内居中，
  // 否则形成二次偏移。一个固定圆心无法同时匹配两代任务栏。
  const center = layout === "windows-10" ? 11.25 : 8;
  return renderAntialiasedStatusDotPixels({
    size: 16 * scale,
    centerX: center * scale,
    centerY: center * scale,
    radius: 3.5 * scale,
  });
}

// 预乘 alpha 混合：out = src + dst × (1 - srcA)，base 原地修改。越界区域安全裁剪。
export function blendBadgeIntoBitmap(options: {
  base: Uint8Array;
  size: number;
  badge: Uint8Array;
  badgeSize: number;
  originX: number;
  originY: number;
}): void {
  for (let by = 0; by < options.badgeSize; by += 1) {
    const y = options.originY + by;
    if (y < 0 || y >= options.size) {
      continue;
    }

    for (let bx = 0; bx < options.badgeSize; bx += 1) {
      const x = options.originX + bx;
      if (x < 0 || x >= options.size) {
        continue;
      }

      const srcOffset = (by * options.badgeSize + bx) * 4;
      const srcAlpha = options.badge[srcOffset + 3]!;
      if (srcAlpha === 0) {
        continue;
      }

      const dstOffset = (y * options.size + x) * 4;
      if (srcAlpha === 255) {
        options.base[dstOffset] = options.badge[srcOffset]!;
        options.base[dstOffset + 1] = options.badge[srcOffset + 1]!;
        options.base[dstOffset + 2] = options.badge[srcOffset + 2]!;
        options.base[dstOffset + 3] = 255;
        continue;
      }

      const keepRatio = (255 - srcAlpha) / 255;
      for (let channel = 0; channel < 4; channel += 1) {
        const src = options.badge[srcOffset + channel]!;
        const dst = options.base[dstOffset + channel]!;
        options.base[dstOffset + channel] = Math.round(src + dst * keepRatio);
      }
    }
  }
}

// 只要求"有任务栏按钮的窗口"能力，方便单测注入假窗口；
// skipTaskbar 窗口（CUA 指示器等）设置 overlay 无副作用，不必逐一排除。
export type TaskbarOverlayWindow = {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: unknown, description: string): void;
};

export function applyTaskbarOverlayToWindows(options: {
  label: string | null;
  windows: Iterable<TaskbarOverlayWindow>;
  badgeImageForLabel: (label: string) => unknown;
}): void {
  const image = options.label ? options.badgeImageForLabel(options.label) : null;
  const description = options.label ? `${options.label} unread tasks` : "";

  for (const win of options.windows) {
    if (win.isDestroyed()) {
      continue;
    }

    win.setOverlayIcon(image, description);
  }
}

// 角标只在任务完成/查看任务时变化，更新频率为事件级；徽章图按 label 缓存避免重复渲染。
// electron 侧（BrowserWindow.getAllWindows / nativeImage.createEmpty）由 desktopWindowLifecycle 注入。
export function createWindowsTaskbarOverlayApplier(deps: {
  getAllWindows: () => Iterable<TaskbarOverlayWindow>;
  createBadgeImage: (label: string) => unknown;
}): (label: string | null) => void {
  const badgeImageCache = new Map<string, unknown>();

  return (label) => {
    // 缓存只认 1…9/9+ 十种派生文案；不能让原始计数或任意字符串无限增长。
    const normalized =
      label === "9+"
        ? label
        : label && /^\d+$/.test(label)
          ? resolveBadgeOverlayLabel(Number(label))
          : null;
    applyTaskbarOverlayToWindows({
      label: normalized,
      windows: deps.getAllWindows(),
      badgeImageForLabel: (cachedLabel) => {
        const cachedImage = badgeImageCache.get(cachedLabel);
        if (cachedImage) {
          return cachedImage;
        }

        const image = deps.createBadgeImage(cachedLabel);
        badgeImageCache.set(cachedLabel, image);
        return image;
      },
    });
  };
}
