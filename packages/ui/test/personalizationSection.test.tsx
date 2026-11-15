import { describe, expect, it } from "vitest";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import {
  countUserInstructionBytes,
  formatUserInstructionKb,
  resolvePersonalizationSaveGate,
  usePersonalizationDraftStore,
} from "../src/settings/personalizationDraft.js";

/** 每个用例前重置模块级 store：它按设计跨组件卸载存活。 */
function resetStore() {
  usePersonalizationDraftStore.setState({
    generation: 0,
    loadRequestId: 0,
    boundService: null,
    readState: "loading",
    baseline: "",
    draft: "",
    saving: false,
    filePath: null,
  });
}

describe("个性化指令草稿 store", () => {
  it("读取成功写入基线；未修改时不可保存", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const marks = store.beginLoad({ service: 1 });
    store.markLoadSuccess(
      { content: "hello", filePath: "/home/u/.zcodium/AGENTS.md" },
      marks.generation,
      marks.requestId,
    );
    const next = usePersonalizationDraftStore.getState();
    expect(next.readState).toBe("ready");
    expect(next.draft).toBe("hello");
    expect(next.baseline).toBe("hello");
    expect(resolvePersonalizationSaveGate(next).canSave).toBe(false);
  });

  it("取消（恢复基线）丢弃草稿；脏态可保存", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const marks = store.beginLoad({ service: 1 });
    store.markLoadSuccess({ content: "base", filePath: "/f" }, marks.generation, marks.requestId);
    store.setDraft("changed");
    expect(resolvePersonalizationSaveGate(usePersonalizationDraftStore.getState()).canSave).toBe(
      true,
    );
    store.setDraft(usePersonalizationDraftStore.getState().baseline);
    const restored = usePersonalizationDraftStore.getState();
    expect(restored.draft).toBe("base");
    expect(resolvePersonalizationSaveGate(restored).canSave).toBe(false);
  });

  it("超过 100KB UTF-8 字节时禁止保存（中文按实际字节计）", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const marks = store.beginLoad({ service: 1 });
    store.markLoadSuccess({ content: "", filePath: "/f" }, marks.generation, marks.requestId);
    const content = "中".repeat(Math.floor(USER_INSTRUCTIONS_MAX_BYTES / 3) + 1);
    store.setDraft(content);
    const state = usePersonalizationDraftStore.getState();
    expect(countUserInstructionBytes(content)).toBeGreaterThan(USER_INSTRUCTIONS_MAX_BYTES);
    expect(resolvePersonalizationSaveGate(state)).toMatchObject({
      overLimit: true,
      canSave: false,
    });
    expect(formatUserInstructionKb(USER_INSTRUCTIONS_MAX_BYTES)).toBe("100 KB");
  });

  it("读取失败不把空串当基线放行保存", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const marks = store.beginLoad({ service: 1 });
    store.markLoadError(marks.generation, marks.requestId);
    store.setDraft("typed while failing");
    const state = usePersonalizationDraftStore.getState();
    expect(state.readState).toBe("error");
    expect(resolvePersonalizationSaveGate(state).canSave).toBe(false);
  });

  it("保存中切走分区后草稿与失败态保留，可重试", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const marks = store.beginLoad({ service: 1 });
    store.markLoadSuccess({ content: "base", filePath: "/f" }, marks.generation, marks.requestId);
    store.setDraft("draft-1");
    const generation = usePersonalizationDraftStore.getState().generation;
    store.beginSave(generation);
    store.endSaveFailure(generation);
    const failed = usePersonalizationDraftStore.getState();
    expect(failed.draft).toBe("draft-1");
    expect(failed.saving).toBe(false);
    expect(resolvePersonalizationSaveGate(failed).canSave).toBe(true);
  });

  it("保存成功后晚到的旧读取不覆盖新基线", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const marks = store.beginLoad({ service: 1 });
    store.markLoadSuccess({ content: "old", filePath: "/f" }, marks.generation, marks.requestId);
    store.setDraft("new");
    const generation = usePersonalizationDraftStore.getState().generation;
    store.beginSave(generation);
    // 读取请求在保存开始前发起，但响应晚于保存落盘返回。
    store.markLoadSuccess({ content: "old", filePath: "/f" }, marks.generation, marks.requestId);
    store.endSaveSuccess("new", generation);
    const state = usePersonalizationDraftStore.getState();
    expect(state.baseline).toBe("new");
    expect(state.draft).toBe("new");
  });

  it("外部改动文件后文件优先，不恢复旧草稿", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const first = store.beginLoad({ service: 1 });
    store.markLoadSuccess({ content: "base", filePath: "/f" }, first.generation, first.requestId);
    store.setDraft("local draft");
    // 再次进入分区：服务实例未变，文件已被外部改成 base-2。
    const second = usePersonalizationDraftStore.getState().beginLoad({ service: 1 });
    usePersonalizationDraftStore
      .getState()
      .markLoadSuccess({ content: "base-2", filePath: "/f" }, second.generation, second.requestId);
    const state = usePersonalizationDraftStore.getState();
    expect(state.baseline).toBe("base-2");
    expect(state.draft).toBe("base-2");
  });

  it("服务实例变化时整体重置，旧连接回调失效（不把 A 机草稿写到 B 机）", () => {
    resetStore();
    const store = usePersonalizationDraftStore.getState();
    const first = store.beginLoad({ service: 1 });
    store.markLoadSuccess(
      { content: "a-machine", filePath: "/f" },
      first.generation,
      first.requestId,
    );
    store.setDraft("a draft");
    const second = usePersonalizationDraftStore.getState().beginLoad({ service: 2 });
    expect(second.generation).toBe(first.generation + 1);
    // 旧服务的读取迟到：generation 已变，必须被丢弃。
    usePersonalizationDraftStore
      .getState()
      .markLoadSuccess({ content: "a-machine", filePath: "/f" }, first.generation, first.requestId);
    expect(usePersonalizationDraftStore.getState().draft).toBe("");
    usePersonalizationDraftStore
      .getState()
      .markLoadSuccess(
        { content: "b-machine", filePath: "/g" },
        second.generation,
        second.requestId,
      );
    expect(usePersonalizationDraftStore.getState().draft).toBe("b-machine");
  });
});
