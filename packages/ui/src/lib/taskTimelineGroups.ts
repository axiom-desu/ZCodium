import type { Locale, ZCodeTaskMeta } from "@zcode/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

// 日期段按本地日历计算：夏令时切换日只有 23/25 小时，用毫秒差取整会把"今天"
// 判成"昨天"（25 小时）并错误跳过日期标题。这里统一比较日历日序号。
function calendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

type TaskTimelineGroupKind =
  | "today"
  | "yesterday"
  | "daysAgo"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "older";

interface TaskTimelineGroupKey {
  kind: TaskTimelineGroupKind;
  daysAgo?: number;
}

interface TaskTimelineGroup<TTask> {
  key: string;
  label: TaskTimelineGroupKey;
  items: TTask[];
}

function resolveTaskTimelineGroupKey(
  timestamp: number,
  now: number,
  locale: Locale,
): TaskTimelineGroupKey {
  const today = calendarDay(now);
  const nowDate = new Date(now);
  // 与上游 timeline 规则一致：week 起点按 locale 决定（en-US 周日，其余周一）。
  const weekStartsOn = locale === "en-US" ? 0 : 1;
  const weekStart = today - ((nowDate.getDay() - weekStartsOn + 7) % 7);
  const thisMonthStart = calendarDay(
    new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime(),
  );
  const lastMonthStart = calendarDay(
    new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1).getTime(),
  );
  const day = calendarDay(timestamp);
  const daysAgo = today - day;

  if (daysAgo <= 0) {
    return { kind: "today" };
  }
  if (daysAgo === 1) {
    return { kind: "yesterday" };
  }
  if (daysAgo <= 3) {
    return { kind: "daysAgo", daysAgo };
  }
  if (day >= weekStart) {
    return { kind: "thisWeek" };
  }
  if (day >= weekStart - 7) {
    return { kind: "lastWeek" };
  }
  if (day >= thisMonthStart) {
    return { kind: "thisMonth" };
  }
  if (day >= lastMonthStart) {
    return { kind: "lastMonth" };
  }
  return { kind: "older" };
}

export function getTaskTimelineGroupMessage(groupKey: TaskTimelineGroupKey): {
  id: string;
  values?: Record<string, string>;
} {
  if (groupKey.kind === "daysAgo") {
    return {
      id: "taskTimeline.daysAgo",
      values: { days: String(groupKey.daysAgo ?? 0) },
    };
  }
  return { id: `taskTimeline.${groupKey.kind}` };
}

function serializeTaskTimelineGroupKey(groupKey: TaskTimelineGroupKey): string {
  return groupKey.kind === "daysAgo" ? `${groupKey.kind}:${groupKey.daysAgo ?? 0}` : groupKey.kind;
}

export function groupTaskTimelineItems<
  TTask extends Pick<ZCodeTaskMeta, "createdAt" | "updatedAt">,
>(
  items: TTask[],
  options: {
    sortBy: "created" | "updated";
    now: number;
    locale: Locale;
  },
): TaskTimelineGroup<TTask>[] {
  const groups: TaskTimelineGroup<TTask>[] = [];
  const groupByKey = new Map<string, TaskTimelineGroup<TTask>>();

  for (const item of items) {
    const timestamp = options.sortBy === "created" ? item.createdAt : item.updatedAt;
    const label = resolveTaskTimelineGroupKey(timestamp, options.now, options.locale);
    const key = serializeTaskTimelineGroupKey(label);
    const existingGroup = groupByKey.get(key);
    if (existingGroup) {
      existingGroup.items.push(item);
      continue;
    }
    const group = { key, label, items: [item] };
    groupByKey.set(key, group);
    groups.push(group);
  }

  return groups;
}
