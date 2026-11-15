import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExtensionStatusSlotView } from "@/extensions/components/ExtensionStatusSlotView.js";
import { examplePendingSlotView, exampleReadySnapshot } from "@/extensions/contract.example.js";
import { selectSlotView } from "@/extensions/domain/slotSelectors.js";

const LABELS = {
  label: "Extensions",
  start: "Start extensions",
  stop: "Stop extensions",
  enable: "Enable",
  revoke: "Revoke",
  pending: "Extension permissions pending",
  loading: "Loading extensions…",
  error: "Extensions unavailable",
  notice:
    "Extensions run third-party Node.js code with your user permissions. Enabling does not provide OS-level isolation.",
};

describe("ExtensionStatusSlotView", () => {
  it("renders the contributed slot with its generation", () => {
    const view = selectSlotView(exampleReadySnapshot, "status.composer", {
      available: true,
      loading: false,
    });
    const html = renderToStaticMarkup(
      <ExtensionStatusSlotView view={view} labels={LABELS} actions={{}} />,
    );
    expect(html).toContain('data-testid="extension-status-slot"');
    expect(html).toContain('data-generation="1"');
    expect(html).toContain("Projects");
    expect(html).toContain("Stop extensions");
  });

  it("renders nothing when the host has no extension service (mobile/Web)", () => {
    const view = selectSlotView(null, "status.composer", { available: false, loading: false });
    expect(renderToStaticMarkup(<ExtensionStatusSlotView view={view} labels={LABELS} />)).toBe("");
  });

  it("asks for consent and wires enable/revoke actions", () => {
    const grant = vi.fn();
    const revoke = vi.fn();
    const html = renderToStaticMarkup(
      <ExtensionStatusSlotView
        view={examplePendingSlotView}
        labels={LABELS}
        actions={{ start: vi.fn(), stop: vi.fn(), grant, revoke }}
      />,
    );
    expect(html).toContain("Extension permissions pending");
    expect(html).toContain("third-party Node.js code");
    expect(html).toContain("Example Extensions");
    expect(html).toContain("Enable");
    expect(html).toContain("Revoke");
    expect(html).toContain("Start extensions");
  });

  it("hides slots from a stale generation", () => {
    const stale = {
      ...exampleReadySnapshot,
      generation: 2,
      slots: exampleReadySnapshot.slots.map((slot) => ({ ...slot, generation: 1 })),
    };
    const view = selectSlotView(stale, "status.composer", { available: true, loading: false });
    expect(view.slots).toEqual([]);
    const html = renderToStaticMarkup(<ExtensionStatusSlotView view={view} labels={LABELS} />);
    expect(html).not.toContain("Projects");
  });

  it("surfaces a host error without claiming the extension is running", () => {
    const view = selectSlotView(
      { ...exampleReadySnapshot, phase: "error", slots: [] },
      "status.composer",
      { available: true, loading: false, error: "boom" },
    );
    const html = renderToStaticMarkup(<ExtensionStatusSlotView view={view} labels={LABELS} />);
    expect(html).toContain("Extensions unavailable");
  });
});
