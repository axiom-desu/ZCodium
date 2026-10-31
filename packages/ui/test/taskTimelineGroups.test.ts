import { beforeAll, describe, expect, it } from "vitest";
import { groupTaskTimelineItems } from "@/lib/taskTimelineGroups.js";

// 日期段必须按本地日历判断：夏令时切换日只有 23/25 小时，用毫秒差取整会把
// 上周的日期误判成“本月”。固定一个真实 DST 时区验证与上游 timeline 规则一致。
beforeAll(() => {
  process.env.TZ = "America/New_York";
});

function groupKeys(now: string, timestamps: string[], locale: "en-US" | "zh-CN" = "en-US") {
  return groupTaskTimelineItems(
    timestamps.map((timestamp, index) => ({
      taskId: `t-${index}`,
      createdAt: Date.parse(timestamp),
      updatedAt: Date.parse(timestamp),
    })) as never,
    { sortBy: "updated", now: Date.parse(now), locale },
  ).map((group) => group.key);
}

describe("timeline 日期段规则", () => {
  it("今天/昨天/3 天内使用日历日而不是毫秒差", () => {
    // DST 结束（2026-11-01）当天是 25 小时；同一天的两个时间仍必须都是 today。
    expect(new Date(Date.parse("2026-11-01T12:00:00")).getTimezoneOffset()).toBe(300);
    expect(
      groupKeys("2026-11-01T23:30:00", ["2026-11-01T00:10:00", "2026-10-31T23:50:00"]),
    ).toEqual(["today", "yesterday"]);
    // 1 天前是 yesterday，2/3 天前才进入 daysAgo 分组。
    expect(
      groupKeys("2026-11-03T12:00:00", ["2026-11-01T12:00:00", "2026-11-02T12:00:00"]),
    ).toEqual(["daysAgo:2", "yesterday"]);
  });

  it("上周覆盖 DST 切换日，不被误判成本月", () => {
    // now = 2026-11-08（周日，EST）；上一周是 11-01..11-07，其中 11-01 仍是 EDT。
    // 旧实现用 weekStart - 7*24h 会把 11-01 整天挤出 lastWeek。
    expect(groupKeys("2026-11-08T12:00:00", ["2026-11-01T00:30:00"])).toEqual(["lastWeek"]);
    expect(groupKeys("2026-11-08T12:00:00", ["2026-10-25T12:00:00"])).toEqual(["lastMonth"]);
  });

  it("周起点按 locale 决定（en-US 周日 / zh-CN 周一）", () => {
    // now = 2026-11-15（周日）：en-US 的 thisWeek 从当天开始，11-09 属于 lastWeek；
    // zh-CN 的 thisWeek 从 11-09（周一）开始，所以同一天是 thisWeek。
    expect(groupKeys("2026-11-15T12:00:00", ["2026-11-09T12:00:00"], "en-US")).toEqual([
      "lastWeek",
    ]);
    expect(groupKeys("2026-11-15T12:00:00", ["2026-11-09T12:00:00"], "zh-CN")).toEqual([
      "thisWeek",
    ]);
    expect(groupKeys("2026-11-15T12:00:00", ["2026-11-08T12:00:00"], "zh-CN")).toEqual([
      "lastWeek",
    ]);
  });

  it("更早的日期落到本月/上月/更早，且同段只出现一次标题", () => {
    expect(
      groupKeys("2026-11-20T12:00:00", [
        "2026-11-18T12:00:00",
        "2026-11-12T12:00:00",
        "2026-09-20T12:00:00",
      ]),
    ).toEqual(["daysAgo:2", "lastWeek", "older"]);
    expect(
      groupKeys("2026-11-20T12:00:00", [
        "2026-11-10T12:00:00",
        "2026-10-05T12:00:00",
        "2026-09-20T12:00:00",
      ]),
    ).toEqual(["lastWeek", "lastMonth", "older"]);
  });
});
