// 用户可见 Mark；协议、包名与兼容命令仍保留原标识。
export const ZCODIUM_LOGO_LINES = [
  "███████╗ ██████╗ ██████╗ ██████╗ ██╗██╗   ██╗███╗   ███╗",
  "   ███╔╝██╔════╝██╔═══██╗██╔══██╗██║██║   ██║████╗ ████║",
  "  ███╔╝ ██║     ██║   ██║██║  ██║██║██║   ██║██╔████╔██║",
  " ███╔╝  ██║     ██║   ██║██║  ██║██║██║   ██║██║╚██╔╝██║",
  "███████╗╚██████╗╚██████╔╝██████╔╝██║╚██████╔╝██║ ╚═╝ ██║",
  "╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝     ╚═╝",
] as const;

export function logoLinesForWidth(width: number): readonly string[] {
  const available = Math.max(0, Math.floor(width));
  if (available < "ZCodium".length) return [];
  // ZCODIUM 比原 ZCODE 更宽；窄终端显示字标而非挤出内容区，resize 后按真实宽度重算。
  return available >= Math.max(...ZCODIUM_LOGO_LINES.map((line) => line.length))
    ? ZCODIUM_LOGO_LINES
    : ["ZCodium"];
}
