import { Button } from "@/components/ui/button.js";

/** 临时预测只提供显式采纳入口；它不持有或写入草稿。 */
export function ComposerInputPrediction({
  draft,
  text,
  onAccept,
}: {
  draft: string;
  text: string;
  onAccept: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Accept suggested continuation"
      data-testid="composer-input-prediction"
      onClick={onAccept}
      className="mx-2 mb-1 max-w-full justify-start truncate text-muted-foreground"
    >
      <span className="truncate">
        {draft}
        {text}
      </span>
      <span className="ml-2 shrink-0">Accept</span>
    </Button>
  );
}
