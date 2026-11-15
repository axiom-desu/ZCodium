import { useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { fileSaveSuccessMessageId, saveFileCopy } from "@/file-menu/fileCopy.js";
import { logger } from "@/logger.js";

interface FileSaveAsMenuItemProps {
  /** 文件所属 workspace：读取走它的 Host，不是本机路径假设。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  path: string;
  variant?: "context" | "dropdown";
  disabled?: boolean;
}

/**
 * 「另存为」菜单项。
 *
 * 字节来自文件所属 Host 的 `stat/readFileRange`（≤50 MiB、前后核对 size/mtime），
 * 写出只走 `IPlatformService.saveFile`（桌面另存对话框 / Web 浏览器下载）。
 * 取消不是错误，不提示「已保存」。spec §3。
 */
export function FileSaveAsMenuItem(props: FileSaveAsMenuItemProps) {
  const services = useOptionalServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const Item = props.variant === "context" ? ContextMenuItem : DropdownMenuItem;
  if (!services || !platform.saveFile) {
    return (
      <Item disabled title={intl.formatMessage({ id: "fileActions.saveAsUnavailable" })}>
        <DownloadIcon className="size-4" />
        {intl.formatMessage({ id: "fileActions.saveAs" })}
      </Item>
    );
  }
  return <WorkspaceFileSaveAsMenuItem {...props} />;
}

function WorkspaceFileSaveAsMenuItem(props: FileSaveAsMenuItemProps) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const { fileService } = useWorkspaceServices(
    props.workspacePath,
    props.workspaceRemoteSessionId,
    props.workspaceIdentity,
  );
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const Item = props.variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const save = async () => {
    if (pending.current || !platform.saveFile) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await saveFileCopy(fileService, props.path, platform.saveFile.bind(platform));
      const messageId = fileSaveSuccessMessageId(result, platform.canOpenLocalFiles);
      if (messageId) toast(intl.formatMessage({ id: messageId }));
    } catch (error) {
      logger.warn("[FileSaveAs] 保存文件副本失败", { path: props.path, error: String(error) });
      const code = error instanceof Error ? error.message : "";
      toast(
        intl.formatMessage({
          id:
            code === "file_too_large"
              ? "fileActions.saveAsTooLarge"
              : code === "file_size_unavailable"
                ? "fileActions.saveAsUnavailable"
                : "fileActions.saveAsFailed",
        }),
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Item disabled={props.disabled || saving} onSelect={() => void save()}>
      <DownloadIcon className="size-4" />
      {intl.formatMessage({ id: "fileActions.saveAs" })}
    </Item>
  );
}
