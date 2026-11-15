import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExtensionStatusSlotView } from "@/extensions/components/ExtensionStatusSlotView.js";
import { examplePendingSlotView, exampleReadySnapshot } from "@/extensions/contract.example.js";
import type { ExtensionsSnapshot } from "@zcode/services";
import { consentGrantRequest } from "@/extensions/domain/consent.js";
import { selectSlotView } from "@/extensions/domain/slotSelectors.js";
import enUS from "@/i18n/locales/en-US.js";
import jaJP from "@/i18n/locales/ja-JP.js";
import koKR from "@/i18n/locales/ko-KR.js";
import ruRU from "@/i18n/locales/ru-RU.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const LABELS = {
  label: "Extensions",
  start: "Start extensions",
  stop: "Stop extensions",
  enable: "Enable",
  revoke: "Revoke",
  pending: "Extension permissions pending",
  loading: "Loading extensions…",
  error: "Extensions unavailable",
  grants: {
    "projects.read": "Read the project list",
    "sessions.read": "Read conversations in this window",
    "sessions.write": "Read and change conversations in this window. Includes read access.",
  },
  notice:
    "Extensions run third-party Node.js code with your user permissions. Enabling does not provide OS-level isolation.",
};

describe("ExtensionStatusSlotView", () => {
  it("provides consent grant labels in all five supported locales", () => {
    const locales = [enUS, zhCN, jaJP, koKR, ruRU];
    for (const locale of locales) {
      for (const key of [
        "extensions.status.grant.projects.read",
        "extensions.status.grant.sessions.read",
        "extensions.status.grant.sessions.write",
        "extensions.status.notice",
      ]) {
        expect(locale[key]).toBeTruthy();
      }
    }
    expect(jaJP["extensions.status.grant.sessions.write"]).not.toMatch(/^Read and change/u);
    expect(koKR["extensions.status.grant.sessions.write"]).not.toMatch(/^Read and change/u);
    expect(ruRU["extensions.status.grant.sessions.write"]).not.toMatch(/^Read and change/u);
  });
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
    // 授权前必须看到每个声明档位的含义；sessions.write 明文说明包含读权限。
    expect(html).toContain('data-testid="extension-consent-grants"');
    expect(html).toContain("Read the project list");
    expect(html).toContain("Read and change conversations in this window");
    expect(html).toContain("Includes read access");
  });

  it("submits exactly the declared grants for consent, never the recorded ones", () => {
    // 真实快照：声明 sessions.write（write 包含 read），没有旧记录。
    const snapshot = {
      ...exampleReadySnapshot,
      plugins: [
        {
          ...exampleReadySnapshot.plugins[0]!,
          status: "needs-consent" as const,
          declared: ["projects.read", "sessions.write"] as const,
          granted: [],
          recorded: ["projects.read"],
        },
      ],
      slots: [],
    } satisfies ExtensionsSnapshot;
    const view = selectSlotView(snapshot, "status.composer", {
      available: true,
      loading: false,
    });
    expect(view.pending[0]?.declared).toEqual(["projects.read", "sessions.write"]);
    const request = consentGrantRequest(view.pending[0]!);
    expect(request).toEqual({
      pluginId: "example-extensions",
      grants: ["projects.read", "sessions.write"],
    });
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
