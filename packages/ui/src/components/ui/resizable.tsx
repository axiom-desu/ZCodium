// import { GripHorizontal, GripVertical } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type Ref } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  useGroupRef,
  type GroupImperativeHandle,
  type GroupProps,
  type Layout,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

/* ------------------------------------------------------------------ */
/*  布局持久化模型                                                     */
/* ------------------------------------------------------------------ */

/**
 * 持久化开关切换时对内存布局的唯一动作。
 * - `freeze-desktop-layout`：停止写盘前先冻结当前（桌面）比例，之后的比例变化只留在内存。
 * - `restore-desktop-layout`：重新开启持久化时把冻结的桌面比例交回 Group，抵消临时维度上的拖拽。
 * - `none`：开关未变化。
 */
type LayoutPersistenceStep = "none" | "freeze-desktop-layout" | "restore-desktop-layout";

function resolveLayoutPersistenceStep(
  wasPersisting: boolean,
  persistLayout: boolean,
): LayoutPersistenceStep {
  if (wasPersisting === persistLayout) return "none";
  return persistLayout ? "restore-desktop-layout" : "freeze-desktop-layout";
}

/**
 * 只有面板集合完全一致时才允许把快照交回 Group。
 * 条件渲染（预览面板/终端开关）会改变面板数量，库会直接抛错，这里交给 Group 自己按当前面板收敛。
 */
function isSameResizableLayoutPanels(a: Layout, b: Layout): boolean {
  const aIds = Object.keys(a);
  const bIds = Object.keys(b);
  return aIds.length === bIds.length && bIds.every((id) => id in a);
}

function assignGroupRef(
  ref: Ref<GroupImperativeHandle | null> | undefined,
  handle: GroupImperativeHandle | null,
): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(handle);
    return;
  }
  ref.current = handle;
}

/* ------------------------------------------------------------------ */
/*  ResizablePanelGroup                                                */
/* ------------------------------------------------------------------ */

/**
 * 带 localStorage 持久化的 PanelGroup 封装。
 * 传入 layoutId 即可自动保存/恢复布局；不传则不持久化。
 * panelIds 用于支持条件渲染的面板（面板数量会变化时必须传）。
 */
function ResizablePanelGroup({
  className,
  layoutId,
  panelIds,
  persistLayout = true,
  groupRef,
  ...props
}: Omit<GroupProps, "defaultLayout" | "onLayoutChange" | "onLayoutChanged" | "groupRef"> & {
  /** 持久化 key，对应 useDefaultLayout 的 id */
  layoutId: string;
  /** 条件渲染面板时需要传当前可见面板的 id 列表 */
  panelIds?: string[];
  /**
   * 是否把布局写入 localStorage（默认 true）。
   *
   * 手机预览这类临时维度传 false：Group 实例和子级（编辑器/终端）都不重建，
   * 只是停止写盘，并把最后一次桌面比例留在内存里，重新开启时用它还原。
   * 这样手机上的开合/拖拽既不会污染桌面的持久化 key，也不会改变桌面的面板比例。
   */
  persistLayout?: boolean;
  /** 需要同时访问 Group 命令式句柄的调用方 */
  groupRef?: Ref<GroupImperativeHandle | null>;
}) {
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    id: layoutId,
    panelIds,
  });
  const internalGroupRef = useGroupRef();
  const setGroupRef = useCallback(
    (handle: GroupImperativeHandle | null) => {
      internalGroupRef.current = handle;
      assignGroupRef(groupRef, handle);
    },
    [groupRef, internalGroupRef],
  );

  // 持久化开启期间最后一次「桌面」布局。persistLayout=false 期间的拖拽只改 Group 内存比例，
  // 既不写 localStorage，也不覆盖这份快照——重新开启时用它顶掉手机上的拖拽结果。
  const desktopLayoutRef = useRef<Layout | undefined>(defaultLayout);
  const persistLayoutRef = useRef(persistLayout);
  // 还原桌面比例本身不是用户意图，不能把它当成一次新的布局变更写回 storage。
  const restoringLayoutRef = useRef(false);
  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      // 关闭持久化后不再落盘；用 ref 判断，避免这一帧的旧闭包把手机比例写回桌面 key。
      if (!persistLayoutRef.current || restoringLayoutRef.current) return;
      desktopLayoutRef.current = layout;
      onLayoutChange(layout);
    },
    [onLayoutChange],
  );

  useLayoutEffect(() => {
    const step = resolveLayoutPersistenceStep(persistLayoutRef.current, persistLayout);
    persistLayoutRef.current = persistLayout;
    if (step === "none") return;

    const handle = internalGroupRef.current;
    if (!handle) return;
    if (step === "freeze-desktop-layout") {
      // 快照取自被关闭前的实际布局，而不是渲染时的旧闭包值。
      const currentLayout = handle.getLayout();
      if (Object.keys(currentLayout).length > 0) {
        desktopLayoutRef.current = currentLayout;
      }
      return;
    }

    // 重新开启：defaultLayout 只在挂载时生效，这里必须用命令式句柄还原，否则不会重建 Group。
    const snapshot = desktopLayoutRef.current;
    if (!snapshot) return;
    if (!isSameResizableLayoutPanels(handle.getLayout(), snapshot)) return;
    restoringLayoutRef.current = true;
    try {
      handle.setLayout(snapshot);
    } finally {
      restoringLayoutRef.current = false;
    }
  }, [persistLayout, internalGroupRef]);

  return (
    <Group
      className={cn("flex h-full w-full", className)}
      // 关闭持久化时也不恢复桌面比例：手机直接按面板默认尺寸排版。
      defaultLayout={persistLayout ? defaultLayout : undefined}
      // onLayoutChanged 会在每次布局变化后立刻写 localStorage。
      // 窗口 resize 时 PanelGroup 会连续产生成百上千次 layout 更新，必须走库内置
      // debounce 的 onLayoutChange，避免同步持久化放大主线程压力。
      onLayoutChange={handleLayoutChange}
      groupRef={setGroupRef}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  ResizablePanel                                                     */
/* ------------------------------------------------------------------ */

const ResizablePanel = Panel;
type ResizablePanelProps = PanelProps;

/* ------------------------------------------------------------------ */
/*  ResizableHandle                                                    */
/* ------------------------------------------------------------------ */

function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      // react-resizable-panels 的 Separator 不会暴露 data-orientation，
      // 实际输出的是 aria-orientation，而且方向和 PanelGroup 相反。
      // 之前写的 data-[orientation=...] 一直没有命中，所以 w-px / h-px 看起来“没生效”。

      className={cn(
        "group/handle relative flex shrink-0 items-center justify-center bg-transparent outline-none transition-colors focus:outline-none focus-visible:outline-none focus-visible:bg-border-hover/60 focus-visible:ring-0",
        "hover:bg-border-hover/60 data-[separator=hover]:bg-border-hover/60 data-[separator=active]:bg-border-hover z-10",

        // react-resizable-panels 会在 pointerdown 时主动 focus 当前 Separator，
        // 如果这里不接管 focus 样式，Chromium 会给可聚焦的 role=separator 画默认黄色高亮。
        // 终端/浏览器打开后颜色恢复，本质上只是焦点被转移了，不是布局自己修好了。
        "aria-[orientation=vertical]:translate-x-px",
        "aria-[orientation=vertical]:my-6",
        "aria-[orientation=vertical]:w-px",
        "aria-[orientation=vertical]:h-[calc(100%-48px)]",
        "aria-[orientation=vertical]:[mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]",
        "aria-[orientation=vertical]:[-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]",

        "aria-[orientation=horizontal]:translate-y-px",
        "aria-[orientation=horizontal]:mx-6",
        "aria-[orientation=horizontal]:h-px",
        "aria-[orientation=horizontal]:w-[calc(100%-48px)]",
        "aria-[orientation=horizontal]:[mask-image:linear-gradient(to_right,transparent_0%,black_18%,black_82%,transparent_100%)]",
        "aria-[orientation=horizontal]:[-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_18%,black_82%,transparent_100%)]",

        className,
      )}
      {...props}
    >
      {/* <div
        className="z-10 flex items-center justify-center rounded-sm
          text-on-surface-muted/40
          transition-colors
          group-data-[orientation=horizontal]/handle:h-6
          group-data-[orientation=horizontal]/handle:w-3
          group-data-[orientation=vertical]/handle:h-3
          group-data-[orientation=vertical]/handle:w-6"
      >
        <GripVertical
          size={12}
          className="group-data-[orientation=vertical]/handle:hidden"
        />
        <GripHorizontal
          size={12}
          className="hidden group-data-[orientation=vertical]/handle:block"
        /> 
      </div>*/}
    </Separator>
  );
}

export {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  isSameResizableLayoutPanels,
  resolveLayoutPersistenceStep,
  type LayoutPersistenceStep,
  type ResizablePanelProps,
};
