import type { RefObject } from "react";
import { ChevronRightIcon, MessageSquarePlus, PencilIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Annotation, AnnotationTool } from "@/image-preview-editor/geometry.js";
import { ImageEditorToolbar } from "@/image-preview-editor/ImageEditorToolbar.js";

export function ImageTextAnnotationInput({
  textDraft,
  disabled,
  onText,
  onCommit,
  onCancel,
}: {
  textDraft: Annotation;
  disabled: boolean;
  onText: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="absolute left-1/2 top-20 z-30 flex max-w-full -translate-x-1/2 gap-1 rounded-xl border border-popover-border bg-popover p-2"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Input
        autoFocus
        aria-label={intl.formatMessage({ id: "imageEditor.textValue" })}
        value={textDraft.text}
        disabled={disabled}
        className="w-48 text-mobile-input-safe sm:text-ui-base"
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onCommit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Button disabled={disabled} onClick={onCommit}>
        {intl.formatMessage({ id: "imageEditor.applyText" })}
      </Button>
    </div>
  );
}

/** 侧边轨道预留图片外边距，收起只保留小入口；窄屏竖向滚动不遮挡顶部操作。 */
export function ImageDrawingRail({
  editing,
  tool,
  color,
  canUndo,
  canRedo,
  disabled,
  width,
  onToggleEditing,
  onTool,
  onColor,
  onUndo,
  onRedo,
}: {
  editing: boolean;
  tool: AnnotationTool;
  color: string;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  width: number;
  onToggleEditing: () => void;
  onTool: (tool: AnnotationTool) => void;
  onColor: (color: string) => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "preview.image.annotate" });
  return (
    <div
      data-image-preview-drawing-rail=""
      className="absolute top-1/2 z-20 flex max-h-[calc(100%-10rem)] -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-popover-border bg-popover p-1 shadow-md"
      style={{ right: `max(0.5rem, calc(50% - ${width / 2}px - 3.25rem))` }}
    >
      <div className="shrink-0">
        <Button
          variant="ghost"
          size="icon-lg"
          title={label}
          aria-label={label}
          aria-expanded={editing}
          data-image-preview-annotate=""
          aria-pressed={editing}
          disabled={disabled}
          onClick={onToggleEditing}
        >
          {editing ? <ChevronRightIcon /> : <PencilIcon />}
        </Button>
      </div>
      {editing ? (
        <ImageEditorToolbar
          tool={tool}
          onTool={onTool}
          color={color}
          onColor={onColor}
          undo={onUndo}
          redo={onRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

export function ImageAddToChatButton({
  buttonRef,
  position,
  disabled,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  position: { left: number; top: number } | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="absolute z-20 -translate-x-1/2"
      style={{ ...position, visibility: position ? "visible" : "hidden" }}
    >
      <Button
        ref={buttonRef}
        data-image-preview-save=""
        variant="outline"
        size="lg"
        className="h-9 gap-2 whitespace-nowrap rounded-lg border-popover-border bg-popover px-4 text-ui-base font-medium text-foreground shadow-md hover:bg-menu-hover"
        disabled={disabled}
        onClick={onClick}
      >
        <MessageSquarePlus className="size-4" />
        {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
      </Button>
    </div>
  );
}

/** 有未保存标注时的离开确认；Add 复用同一保存路径，Discard 只丢弃编辑历史。 */
export function UnsavedAnnotationsDialog({
  open,
  saving,
  keepEditingRef,
  onClose,
  onKeepEditing,
  onDiscard,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  keepEditingRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onKeepEditing: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepEditingRef.current?.focus();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <AlertDialogTitle>
          {intl.formatMessage({ id: "imageEditor.unsavedTitle" })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {intl.formatMessage({ id: "imageEditor.unsavedDescription" })}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <Button ref={keepEditingRef} variant="ghost" disabled={saving} onClick={onKeepEditing}>
            {intl.formatMessage({ id: "imageEditor.keepEditing" })}
          </Button>
          <Button variant="outline" disabled={saving} onClick={onDiscard}>
            {intl.formatMessage({ id: "imageEditor.discard" })}
          </Button>
          <Button disabled={saving} onClick={onSave}>
            {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
