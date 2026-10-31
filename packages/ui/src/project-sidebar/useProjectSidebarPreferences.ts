import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSidebarViewMode, VirtualProject } from "./contract.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";
import { readSidebarTaskPreferences } from "@/lib/sidebarTaskPreferences.js";
import { projectRowKey } from "./view.js";

const STORAGE_KEY = "zcode-project-sidebar-expanded";

interface StoredPreferences {
  expanded: Record<string, boolean>;
  view: ProjectSidebarViewMode;
}

const VIEW_MODES = new Set<ProjectSidebarViewMode>(["projects", "grouped", "timeline", "archive"]);

function isProjectSidebarViewMode(value: unknown): value is ProjectSidebarViewMode {
  return typeof value === "string" && VIEW_MODES.has(value as ProjectSidebarViewMode);
}

/** 新偏好缺失时只迁移旧 workspace 侧栏的 organizeBy；用户新选择不被以后重启覆盖。 */
function readViewMode(value: unknown): ProjectSidebarViewMode {
  if (isProjectSidebarViewMode(value)) return value;
  const legacy = readSidebarTaskPreferences().organizeBy;
  return legacy === "grouped" ? "grouped" : legacy === "chronological" ? "timeline" : "projects";
}

function readStored(): StoredPreferences {
  try {
    const parsed: unknown = JSON.parse(getSafeLocalStorage()?.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") {
      return { expanded: {}, view: readViewMode(undefined) };
    }
    const expanded = (parsed as { expanded?: unknown }).expanded;
    const view = (parsed as { view?: unknown }).view;
    return {
      expanded:
        expanded && typeof expanded === "object"
          ? (Object.fromEntries(
              Object.entries(expanded).filter(([, value]) => typeof value === "boolean"),
            ) as Record<string, boolean>)
          : {},
      view: readViewMode(view),
    };
  } catch {
    return { expanded: {}, view: readViewMode(undefined) };
  }
}

function writeStored(value: StoredPreferences): void {
  try {
    getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 浏览器禁用存储时保持当前窗口偏好；不阻塞项目命令。
  }
}

function readStoredExpanded(): Record<string, boolean> {
  return readStored().expanded;
}

/**
 * 只持本客户端的展开偏好。项目行、排序与任务事实来自 Host readTree，
 * 不在这里建立第二份项目/任务状态。
 */
export function useProjectSidebarPreferences(projects: readonly VirtualProject[]) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readStoredExpanded);
  const [view, setViewState] = useState<ProjectSidebarViewMode>(() => readStored().view);
  const viewRef = useRef(view);
  viewRef.current = view;

  const setView = useCallback((next: ProjectSidebarViewMode) => {
    setViewState(next);
    writeStored({ expanded: readStoredExpanded(), view: next });
  }, []);

  const visibleKeys = useMemo(
    () => new Set(projects.map((project) => projectRowKey(project))),
    [projects],
  );

  useEffect(() => {
    setExpanded((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key, value]) => value && visibleKeys.has(key)),
      );
      if (
        Object.keys(next).length === Object.keys(current).length &&
        Object.entries(next).every(([key, value]) => current[key] === value)
      ) {
        return current;
      }
      writeStored({ expanded: next, view: viewRef.current });
      return next;
    });
  }, [visibleKeys]);

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = { ...current, [key]: !current[key] };
      if (!next[key]) delete next[key];
      writeStored({ expanded: next, view: viewRef.current });
      return next;
    });
  }, []);

  const setAll = useCallback((keys: readonly string[], open: boolean) => {
    setExpanded(() => {
      const next = open ? Object.fromEntries(keys.map((key) => [key, true])) : {};
      writeStored({ expanded: next, view: viewRef.current });
      return next;
    });
  }, []);

  const expandedKeys = useMemo(
    () => new Set(Object.entries(expanded).flatMap(([key, value]) => (value ? [key] : []))),
    [expanded],
  );

  return { expandedKeys, toggle, setAll, view, setView };
}
