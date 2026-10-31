import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MESSAGES = {
  "zh-CN": {
    "projectSidebar.newProject": "新建项目",
    "projectSidebar.restoreProjects": "恢复已删除项目",
    "projectSidebar.restoreEmpty": "没有可恢复的项目",
    "projectSidebar.restoreHint": "恢复必须使用项目删除前的同一组 roots。",
    "projectSidebar.restore": "恢复",
    "projectSidebar.edit": "编辑项目",
    "projectSidebar.delete": "删除项目",
    "projectSidebar.pin": "置顶项目",
    "projectSidebar.unpin": "取消置顶",
    "projectSidebar.moveTasks": "移动任务…",
    "projectSidebar.viewFiles": "查看文件",
    "projectSidebar.newTask": "在此项目新建任务",
    "projectSidebar.noPrimaryRoot": "主目录不可用，新建与移动已禁用",
    "projectSidebar.legacyReadOnly": "旧远端项目只读",
    "projectSidebar.legacyReadOnlyHint":
      "旧远端没有项目服务能力，只能浏览历史任务；创建、编辑、删除、置顶、排序与移动已禁用。",
    "projectSidebar.createTitle": "新建项目",
    "projectSidebar.editTitle": "编辑项目",
    "projectSidebar.nameLabel": "项目名称",
    "projectSidebar.namePlaceholder": "例如：Website",
    "projectSidebar.rootsLabel": "源文件夹",
    "projectSidebar.rootsHint": "保存后只影响后续新任务的目录；已有任务 cwd 不变。",
    "projectSidebar.rootPlaceholder": "输入绝对路径，或选择文件夹",
    "projectSidebar.addRoot": "添加文件夹",
    "projectSidebar.removeRoot": "移除目录",
    "projectSidebar.primaryRoot": "主目录",
    "projectSidebar.noRoots": "未添加目录。创建空项目后，首次新建任务时才生成主目录。",
    "projectSidebar.trustTitle": "确认本次创建目录",
    "projectSidebar.trustDescription": "本次仅授权以下目录。不会持久化信任，也不会改变已有项目。",
    "projectSidebar.trustConfirm": "信任并保存",
    "projectSidebar.cancel": "取消",
    "projectSidebar.save": "保存",
    "projectSidebar.saving": "保存中…",
    "projectSidebar.deleteTitle": "删除项目",
    "projectSidebar.deleteDescription":
      "项目会被软删除，任务归属和历史仍保留；恢复时必须使用同一组 roots。",
    "projectSidebar.deleteConfirm": "删除",
    "projectSidebar.moveTitle": "移动任务",
    "projectSidebar.moveTaskLabel": "任务",
    "projectSidebar.moveTargetLabel": "目标项目",
    "projectSidebar.moveAction": "移动",
    "projectSidebar.moveMissingRoot": "目标项目没有该任务所在目录。",
    "projectSidebar.moveMissingRootAction": "加入目录并移动",
    "projectSidebar.emptyProjects": "还没有项目",
    "projectSidebar.emptyProjectTasks": "暂无任务",
    "projectSidebar.unassignedTitle": "未归类任务",
    "projectSidebar.loadError": "项目读取失败",
    "projectSidebar.retry": "重试",
    "projectSidebar.rootRequired": "请输入绝对路径",
    "projectSidebar.selectFolderUnavailable": "当前环境不支持系统目录选择",
    "projectSidebar.actionFailed": "操作失败：{error}",
    "projectSidebar.expand": "展开项目",
    "projectSidebar.collapse": "收起项目",
    "projectSidebar.showMore": "显示更多",
    "projectSidebar.viewProjects": "按项目",
    "projectSidebar.viewGrouped": "按分组",
    "projectSidebar.viewTimeline": "最近更新",
    "projectSidebar.viewArchive": "归档",
    "projectSidebar.viewsLabel": "项目视图",
    "projectSidebar.pinnedTasks": "置顶",
    "projectSidebar.groupsTitle": "分组",
    "projectSidebar.newGroup": "新建分组",
    "projectSidebar.emptyGroupTasks": "暂无任务",
    "projectSidebar.groupMenu": "分组菜单",
    "projectSidebar.renameGroup": "重命名分组",
    "projectSidebar.groupColor": "分组颜色",
    "projectSidebar.ungroup": "取消分组",
    "projectSidebar.groupsHint": "分组结构来自当前 Host 的任务组织事实。",
    "projectSidebar.moveTaskToGroup": "移动到分组",
    "projectSidebar.moveTaskToTop": "移到顶层",
    "projectSidebar.emptyTimeline": "暂无最近任务",
    "projectSidebar.emptyGrouped": "暂无可分组的任务",
    "projectSidebar.untitled": "未命名任务",
    "projectSidebar.unarchive": "取消归档",
    "projectSidebar.deleteTask": "删除任务",
    "projectSidebar.deleteTaskTitle": "删除归档任务",
    "projectSidebar.deleteTaskDescription": "任务及其历史将被删除，且无法从归档视图恢复。",
    "projectSidebar.emptyArchive": "暂无归档任务",
    "projectSidebar.deletedProject": "已删除项目",
    "projectSidebar.unclassified": "未归类",
  },
  "en-US": {
    "projectSidebar.newProject": "New project",
    "projectSidebar.restoreProjects": "Restore deleted project",
    "projectSidebar.restoreEmpty": "No deleted projects to restore",
    "projectSidebar.restoreHint":
      "Restore requires the exact same roots the project had before deletion.",
    "projectSidebar.restore": "Restore",
    "projectSidebar.edit": "Edit project",
    "projectSidebar.delete": "Delete project",
    "projectSidebar.pin": "Pin project",
    "projectSidebar.unpin": "Unpin project",
    "projectSidebar.moveTasks": "Move tasks…",
    "projectSidebar.viewFiles": "View files",
    "projectSidebar.newTask": "New task in this project",
    "projectSidebar.noPrimaryRoot": "Primary folder unavailable; new tasks and moves are disabled",
    "projectSidebar.legacyReadOnly": "Legacy remote project (read-only)",
    "projectSidebar.legacyReadOnlyHint":
      "This legacy remote has no project service. History stays browsable; create, edit, delete, pin, reorder and move are disabled.",
    "projectSidebar.createTitle": "New project",
    "projectSidebar.editTitle": "Edit project",
    "projectSidebar.nameLabel": "Project name",
    "projectSidebar.namePlaceholder": "For example: Website",
    "projectSidebar.rootsLabel": "Source folders",
    "projectSidebar.rootsHint":
      "Saving only affects future tasks; existing task cwd never changes.",
    "projectSidebar.rootPlaceholder": "Enter an absolute path or choose a folder",
    "projectSidebar.addRoot": "Add folder",
    "projectSidebar.removeRoot": "Remove folder",
    "projectSidebar.primaryRoot": "Primary folder",
    "projectSidebar.noRoots":
      "No folders yet. An empty project gets a deterministic primary folder on the first new task.",
    "projectSidebar.trustTitle": "Confirm folders for this creation",
    "projectSidebar.trustDescription":
      "Only these folders are authorized for this save. No trust is persisted and existing projects are unchanged.",
    "projectSidebar.trustConfirm": "Trust and save",
    "projectSidebar.cancel": "Cancel",
    "projectSidebar.save": "Save",
    "projectSidebar.saving": "Saving…",
    "projectSidebar.deleteTitle": "Delete project",
    "projectSidebar.deleteDescription":
      "The project is soft-deleted; task ownership and history remain. Restoring requires the same roots.",
    "projectSidebar.deleteConfirm": "Delete",
    "projectSidebar.moveTitle": "Move task",
    "projectSidebar.moveTaskLabel": "Task",
    "projectSidebar.moveTargetLabel": "Target project",
    "projectSidebar.moveAction": "Move",
    "projectSidebar.moveMissingRoot": "The target project does not contain this task's folder.",
    "projectSidebar.moveMissingRootAction": "Add folder and move",
    "projectSidebar.emptyProjects": "No projects yet",
    "projectSidebar.emptyProjectTasks": "No tasks",
    "projectSidebar.unassignedTitle": "Unassigned tasks",
    "projectSidebar.loadError": "Could not load projects",
    "projectSidebar.retry": "Retry",
    "projectSidebar.rootRequired": "Enter an absolute path",
    "projectSidebar.selectFolderUnavailable": "Folder picker is unavailable in this environment",
    "projectSidebar.actionFailed": "Action failed: {error}",
    "projectSidebar.expand": "Expand project",
    "projectSidebar.collapse": "Collapse project",
    "projectSidebar.showMore": "Show more",
    "projectSidebar.viewProjects": "By project",
    "projectSidebar.viewGrouped": "By group",
    "projectSidebar.viewTimeline": "Recently updated",
    "projectSidebar.viewArchive": "Archive",
    "projectSidebar.viewsLabel": "Project view",
    "projectSidebar.pinnedTasks": "Pinned",
    "projectSidebar.groupsTitle": "Groups",
    "projectSidebar.newGroup": "New group",
    "projectSidebar.emptyGroupTasks": "No tasks",
    "projectSidebar.groupMenu": "Group menu",
    "projectSidebar.renameGroup": "Rename group",
    "projectSidebar.groupColor": "Group color",
    "projectSidebar.ungroup": "Remove group",
    "projectSidebar.groupsHint": "Group structure comes from this Host's task organization facts.",
    "projectSidebar.moveTaskToGroup": "Move to group",
    "projectSidebar.moveTaskToTop": "Move to top",
    "projectSidebar.emptyTimeline": "No recent tasks",
    "projectSidebar.emptyGrouped": "No tasks to group",
    "projectSidebar.untitled": "Untitled task",
    "projectSidebar.unarchive": "Unarchive",
    "projectSidebar.deleteTask": "Delete task",
    "projectSidebar.deleteTaskTitle": "Delete archived task",
    "projectSidebar.deleteTaskDescription":
      "The task and its history will be deleted and cannot be restored from the archive.",
    "projectSidebar.emptyArchive": "No archived tasks",
    "projectSidebar.deletedProject": "Deleted project",
    "projectSidebar.unclassified": "Unclassified",
  },
} as const;

interface ProjectSidebarIntl {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

function format(
  messages: Record<string, string>,
  descriptor: { id: string },
  values?: Record<string, string | number>,
): string {
  let message = messages[descriptor.id] ?? descriptor.id;
  if (values) {
    for (const [key, value] of Object.entries(values)) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
  }
  return message;
}

/** 模块自带文案；缺失 id 回退全局 intl，避免在共享大表里重复登记项目侧栏词条。 */
export function useProjectSidebarIntl(): ProjectSidebarIntl {
  const { intl, locale } = useZCodeIntl();
  return useMemo(() => {
    const messages = MESSAGES[locale] as Record<string, string> | undefined;
    return {
      formatMessage(descriptor, values) {
        if (messages && descriptor.id in messages) {
          return format(messages, descriptor, values);
        }
        return intl.formatMessage(descriptor, values);
      },
    };
  }, [intl, locale]);
}
