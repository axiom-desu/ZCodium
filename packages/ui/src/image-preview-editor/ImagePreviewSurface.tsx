import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ImagePreviewActions } from "@/image-preview-editor/ImagePreviewActions.js";
import { ImagePreviewViewport } from "@/image-preview-editor/ImagePreviewViewport.js";
import {
  ImageAddToChatButton,
  ImageDrawingRail,
  ImageTextAnnotationInput,
  UnsavedAnnotationsDialog,
} from "@/image-preview-editor/ImagePreviewEditorPanels.js";
import { useImagePreviewEditor } from "@/image-preview-editor/useImagePreviewEditor.js";
import type { ImagePreviewSurfaceProps } from "@/image-preview-editor/contract.js";

export function ImagePreviewSurface({
  src,
  alt,
  filename,
  imageTestId,
  onDownload,
  downloading,
  onSaved,
  onClose,
  onNavigationGuardChange,
}: ImagePreviewSurfaceProps) {
  const { intl } = useZCodeIntl();
  const editor = useImagePreviewEditor({ alt, filename, onSaved, onNavigationGuardChange });
  return (
    <>
      <ImagePreviewActions
        src={src}
        alt={alt}
        filename={filename}
        imageRef={editor.imageRef}
        ready={!editor.saving && editor.natural.width > 0}
        onAdded={onSaved}
        onBusyChange={editor.setActionBusy}
        onAddEdited={editor.dirty ? () => void editor.save() : undefined}
        onDownload={onDownload}
        downloading={downloading}
        zoomControls={
          <>
            <Button
              aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
              disabled={editor.actionBusy || editor.saving || editor.transform.scale <= 0.5}
              onClick={() => editor.zoom(editor.transform.scale - 0.5)}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
            >
              <MinusIcon />
            </Button>
            <button
              type="button"
              title={intl.formatMessage({ id: "preview.image.resetZoom" })}
              onClick={editor.resetTransform}
              className="min-w-10 text-center text-ui-sm"
            >
              {Math.round(editor.transform.scale * 100)}%
            </button>
            <Button
              aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
              disabled={editor.actionBusy || editor.saving || editor.transform.scale >= 3}
              onClick={() => editor.zoom(editor.transform.scale + 0.5)}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
            >
              <PlusIcon />
            </Button>
          </>
        }
      >
        <ImagePreviewViewport
          alt={alt}
          src={src}
          imageTestId={imageTestId}
          imageRef={editor.imageRef}
          surfaceRef={editor.surfaceRef}
          overlayRef={editor.overlayRef}
          viewportRef={editor.viewportRef}
          size={editor.size}
          transform={editor.transform}
          cursor={editor.cursor}
          editing={editor.editing}
          displayed={editor.displayed}
          selected={editor.selected}
          natural={editor.natural}
          onPointerDown={editor.pointerDown}
          onPointerMove={editor.pointerMove}
          onPointerEnd={editor.pointerEnd}
          onImageLoad={editor.onImageLoad}
          onClose={onClose}
        />
      </ImagePreviewActions>
      {editor.textDraft ? (
        <ImageTextAnnotationInput
          textDraft={editor.textDraft}
          disabled={editor.actionBusy || editor.saving}
          onText={(text) => editor.setTextDraft({ ...editor.textDraft!, text })}
          onCommit={editor.commitTextDraft}
          onCancel={() => editor.setTextDraft(null)}
        />
      ) : null}
      <ImageDrawingRail
        editing={editor.editing}
        tool={editor.tool}
        color={editor.color}
        canUndo={editor.history.past.length > 0}
        canRedo={editor.history.future.length > 0}
        disabled={editor.actionBusy || editor.saving || !editor.natural.width}
        width={editor.size.width}
        onToggleEditing={editor.toggleEditing}
        onTool={editor.selectTool}
        onColor={editor.setColor}
        onUndo={editor.undo}
        onRedo={editor.redo}
      />
      {editor.dirty ? (
        <ImageAddToChatButton
          buttonRef={editor.addButtonRef}
          position={editor.addPosition}
          disabled={editor.actionBusy || editor.saving}
          onClick={() => void editor.save()}
        />
      ) : null}
      <UnsavedAnnotationsDialog
        open={Boolean(editor.pendingExit)}
        saving={editor.saving}
        keepEditingRef={editor.keepEditingRef}
        onClose={() => {
          if (!editor.saving) editor.setPendingExit(null);
        }}
        onKeepEditing={() => editor.setPendingExit(null)}
        onDiscard={() => {
          const proceed = editor.pendingExit;
          editor.setPendingExit(null);
          proceed?.();
        }}
        onSave={() => void editor.save()}
      />
    </>
  );
}
