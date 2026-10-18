import React from "react";
import { useTerminalDimensions } from "@mbears/opentui-react";
import { logoLinesForWidth } from "./app-logo.js";
import { palette } from "./app-model.js";
import { ShimmerText, useShimmerFrame } from "./app-motion.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function EmptyTranscriptLogo({
  animated = false,
  width,
}: {
  animated?: boolean;
  width?: number;
} = {}): React.ReactElement {
  const terminal = useTerminalDimensions();
  const lines = logoLinesForWidth(width ?? terminal.width - 2);
  if (animated) {
    return h(AnimatedEmptyTranscriptLogo, { lines });
  }
  return renderLogoContent({ animated: false, lines });
}

function AnimatedEmptyTranscriptLogo({ lines }: { lines: readonly string[] }): React.ReactElement {
  const frameMs = useShimmerFrame(true);
  return renderLogoContent({ animated: true, frameMs, lines });
}

function renderLogoContent(input: {
  animated: boolean;
  frameMs?: number;
  lines: readonly string[];
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "center",
        minHeight: input.lines.length,
        width: "100%",
      },
    },
    ...input.lines.map((line, index) =>
      renderLogoText({
        animated: input.animated,
        baseColor: palette.accent,
        frameMs: input.frameMs,
        key: `zcodium-logo-${index}`,
        text: line,
      }),
    ),
  );
}

function renderLogoText(input: {
  animated: boolean;
  baseColor: string;
  frameMs?: number;
  key: string;
  text: string;
}): React.ReactElement {
  if (!input.animated) {
    return h("text", { key: input.key, style: { fg: input.baseColor } }, input.text);
  }
  return h(ShimmerText, {
    animated: true,
    baseColor: input.baseColor,
    frameMs: input.frameMs,
    highlightColor: palette.text,
    key: input.key,
    text: input.text,
  });
}
