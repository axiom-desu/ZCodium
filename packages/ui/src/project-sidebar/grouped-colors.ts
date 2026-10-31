import type { ProjectTaskGroupColor } from "./contract.js";

export const TASK_GROUP_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const satisfies readonly ProjectTaskGroupColor[];

export const GROUP_COLOR_CLASS: Record<ProjectTaskGroupColor, string> = {
  gray: "bg-zinc-400",
  red: "bg-rose-400",
  orange: "bg-orange-400",
  yellow: "bg-amber-400",
  green: "bg-emerald-400",
  blue: "bg-sky-400",
  purple: "bg-violet-400",
};
