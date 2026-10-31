import type { SlideHandle, SlideNode } from "@aiden0z/pptx-renderer/browser";

export interface SlideSlot {
  frame: HTMLDivElement;
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  handle?: SlideHandle;
  ready?: Promise<void>;
}

type TextBodyLike = { paragraphs?: { runs?: { text?: string }[] }[] };

function bodyText(body: TextBodyLike | undefined): string {
  return (body?.paragraphs ?? [])
    .map((paragraph) => (paragraph.runs ?? []).map((run) => run.text ?? "").join(""))
    .join("\n")
    .trim();
}

export function nodeText(node: SlideNode): string {
  const data = node as unknown as {
    textBody?: TextBodyLike;
    rows?: { cells: { textBody?: TextBodyLike }[] }[];
  };
  if (data.rows)
    return data.rows
      .map((row) => row.cells.map((cell) => bodyText(cell.textBody)).join(" | "))
      .join("\n");
  return bodyText(data.textBody);
}

export const GAP = 16;
