import { create } from "zustand";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";

/**
 * 个性化（用户自定义指令）表单状态。
 *
 * spec：`.agents/specs/upstream-3.18-ui-settings-files.md` §1。
 * 状态收口在组件外的模块级 store（与上游一致）：
 * - 卸载不失活：保存中切走分区后组件卸载，草稿与失败态仍可恢复重试；
 * - 双层失效边界：`generation` 绑定服务实例（Host/连接身份），实例变化时整体重置，
 *   旧连接的在途回调失效；`loadRequestId` 标记每次读取，`beginSave` 也递增它，
 *   迟到的旧读取不得覆盖新草稿/已保存基线。
 */
interface PersonalizationLoadResult {
  content: string;
  filePath: string;
  /** 文件超过读取上限时内容只是前 100KiB；保存必须被门控。 */
  truncated?: boolean;
}

interface PersonalizationDraftState {
  generation: number;
  loadRequestId: number;
  boundService: object | null;
  readState: "loading" | "ready" | "error";
  baseline: string;
  draft: string;
  /** 读取到超限文件的截断内容：不能作为可保存基线。 */
  truncated: boolean;
  saving: boolean;
  filePath: string | null;
  beginLoad: (service: object) => { generation: number; requestId: number };
  markLoadSuccess: (
    result: PersonalizationLoadResult,
    generation: number,
    requestId: number,
  ) => void;
  markLoadError: (generation: number, requestId: number) => void;
  setDraft: (content: string) => void;
  beginSave: (generation: number) => number;
  endSaveSuccess: (content: string, generation: number) => void;
  endSaveFailure: (generation: number) => void;
}

export function countUserInstructionBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function formatUserInstructionKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** 保存门控：只有「读取完成 + 脏 + 未超限 + 未在保存中」才允许写出。 */
export function resolvePersonalizationSaveGate(state: {
  readState: PersonalizationDraftState["readState"];
  baseline: string;
  draft: string;
  truncated: boolean;
  saving: boolean;
}): { dirty: boolean; overLimit: boolean; canSave: boolean } {
  // 截断读取同样视为超限：编辑器可看/可清理，但不得把不完整草稿写回完整文件。
  const overLimit =
    state.truncated || countUserInstructionBytes(state.draft) > USER_INSTRUCTIONS_MAX_BYTES;
  const dirty = state.readState === "ready" && state.draft !== state.baseline;
  return { dirty, overLimit, canSave: dirty && !overLimit && !state.saving };
}

export const usePersonalizationDraftStore = create<PersonalizationDraftState>((set, get) => ({
  generation: 0,
  loadRequestId: 0,
  boundService: null,
  readState: "loading",
  baseline: "",
  draft: "",
  truncated: false,
  saving: false,
  filePath: null,
  beginLoad: (service) => {
    set((state) => ({
      ...(state.boundService === service
        ? state
        : {
            generation: state.generation + 1,
            boundService: service,
            readState: "loading" as const,
            baseline: "",
            draft: "",
            truncated: false,
            saving: false,
            filePath: null,
          }),
      loadRequestId: state.loadRequestId + 1,
    }));
    return { generation: get().generation, requestId: get().loadRequestId };
  },
  markLoadSuccess: (result, generation, requestId) =>
    set((state) => {
      if (state.generation !== generation || state.loadRequestId !== requestId) return state;
      // 文件未被外部改过（仍等于基线）且草稿有待保存修改时续用草稿；
      // 文件已变化（外部/其他设备写入）时文件优先。
      const resumeDraft = state.draft !== state.baseline && result.content === state.baseline;
      return {
        readState: "ready",
        filePath: result.filePath,
        baseline: result.content,
        truncated: result.truncated === true,
        draft: resumeDraft ? state.draft : result.content,
      };
    }),
  markLoadError: (generation, requestId) =>
    set((state) =>
      state.generation !== generation || state.loadRequestId !== requestId
        ? state
        : { readState: "error", saving: false },
    ),
  setDraft: (content) => set({ draft: content }),
  // 保存同时使在途读取失效：读取响应可能晚于保存落盘返回，其内容是旧快照。
  beginSave: (generation) => {
    set((state) =>
      state.generation !== generation
        ? state
        : { saving: true, loadRequestId: state.loadRequestId + 1 },
    );
    return get().loadRequestId;
  },
  endSaveSuccess: (content, generation) =>
    set((state) =>
      state.generation !== generation ? state : { saving: false, baseline: content },
    ),
  endSaveFailure: (generation) =>
    set((state) => (state.generation !== generation ? state : { saving: false })),
}));
