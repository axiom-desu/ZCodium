import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";

/**
 * 连接方式：默认同网直连；跨网由用户填写自己的隧道 / 自托管 relay 地址
 * （`packages/relay`，本项目不运营任何中转服务）。
 */
export function WebRemoteControlEndpointSection() {
  const { intl } = useZCodeIntl();
  const settings = useSettings();
  const savedMode = settings.settings?.webRemoteControlEndpointMode ?? "lan";
  const savedUrl = settings.settings?.webRemoteControlCustomEndpointUrl ?? "";
  const [url, setUrl] = useState(savedUrl);
  const [saving, setSaving] = useState(false);

  // 保存后设置快照会推新值；同步回输入框，避免显示过期地址。
  useEffect(() => {
    setUrl(savedUrl);
  }, [savedUrl]);

  const save = async () => {
    const trimmed = url.trim();
    if (trimmed && !/^wss?:\/\//u.test(trimmed)) {
      toast(intl.formatMessage({ id: "webRemoteControl.endpoint.invalidUrl" }));
      return;
    }
    setSaving(true);
    try {
      await settings.update({
        webRemoteControlEndpointMode: trimmed ? "custom" : "lan",
        ...(trimmed ? { webRemoteControlCustomEndpointUrl: trimmed } : {}),
      });
      toast(intl.formatMessage({ id: "webRemoteControl.endpoint.saved" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.endpoint.saveFailed" }, { error: message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "webRemoteControl.endpoint.title" })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={savedMode === "lan" ? "default" : "outline"}
          size="sm"
          className="enabled:cursor-pointer"
          onClick={() =>
            void settings.update({ webRemoteControlEndpointMode: "lan" }).catch(() => undefined)
          }
        >
          {intl.formatMessage({ id: "webRemoteControl.endpoint.modeLan" })}
        </Button>
        <Button
          type="button"
          variant={savedMode === "custom" ? "default" : "outline"}
          size="sm"
          className="enabled:cursor-pointer"
          onClick={() =>
            void settings.update({ webRemoteControlEndpointMode: "custom" }).catch(() => undefined)
          }
        >
          {intl.formatMessage({ id: "webRemoteControl.endpoint.modeCustom" })}
        </Button>
      </div>
      <p className="text-ui-xs/relaxed text-foreground-subtle">
        {intl.formatMessage({
          id:
            savedMode === "custom"
              ? "webRemoteControl.endpoint.modeCustomHint"
              : "webRemoteControl.endpoint.modeLanHint",
        })}
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={intl.formatMessage({ id: "webRemoteControl.endpoint.urlPlaceholder" })}
          aria-label={intl.formatMessage({ id: "webRemoteControl.endpoint.urlLabel" })}
          className="h-9 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="enabled:cursor-pointer"
          disabled={saving}
          onClick={() => void save()}
        >
          {intl.formatMessage({ id: "webRemoteControl.endpoint.save" })}
        </Button>
      </div>
    </section>
  );
}
