import { describe, expect, it, vi } from "vitest";
import {
  dispatchSourceSettingsAttachment,
  parseSourceSettingsSourceServerId,
} from "./sourceSettingsAttachmentRequest.js";

describe("Source 设置 attachment Main 入口", () => {
  it("接受字符串或对象 payload 并 trim source id", () => {
    expect(parseSourceSettingsSourceServerId("  source-1  ")).toBe("source-1");
    expect(parseSourceSettingsSourceServerId({ sourceServerId: "  source-2  " })).toBe("source-2");
  });

  it.each([undefined, null, "", "   ", {}, { sourceServerId: 1 }, { sourceServerId: "  " }])(
    "拒绝无 source id 的 payload: %j",
    (payload) => {
      expect(() => parseSourceSettingsSourceServerId(payload)).toThrow(
        /Invalid source-settings attachment payload/u,
      );
    },
  );

  it("只把当前请求窗口绑定的 window 与 source id 交给已有 attachment 创建", () => {
    const win = { id: 7 };
    const attach = vi.fn(() => ({ attachmentId: "attachment-1" }));
    const findWindow = vi.fn(() => win);

    expect(
      dispatchSourceSettingsAttachment({
        rawPayload: { sourceServerId: " source-1 " },
        sender: { id: 42 },
        findWindow,
        attach,
      }),
    ).toEqual({ attachmentId: "attachment-1" });
    expect(findWindow).toHaveBeenCalledWith({ id: 42 });
    expect(attach).toHaveBeenCalledWith(win, "source-1");
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("窗口已不存在时拒绝，且不创建 attachment 或触碰其他 scope", () => {
    const attach = vi.fn(() => ({ attachmentId: "attachment-1" }));
    expect(() =>
      dispatchSourceSettingsAttachment({
        rawPayload: { sourceServerId: "source-1" },
        sender: { id: 42 },
        findWindow: () => null,
        attach,
      }),
    ).toThrow(/未找到当前窗口/u);
    expect(attach).not.toHaveBeenCalled();
  });
});
