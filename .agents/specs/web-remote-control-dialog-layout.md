# Mobile Remote Control Dialog: Two-Column Layout

## Behavior and boundaries

The mobile remote-control dialog presents two ways to reach a workspace: a phone-browser QR connection and Bot Channel configuration. At viewport widths of at least 768 CSS px, show QR/connection settings in the left column and Bot Channel choices in the right column. Below 768px, show one column with QR first and Bot Channels second. The dialog stays inset from viewport edges, and neither layout may cause horizontal overflow. The QR image remains square at all column widths.

Both columns are named semantic sections/regions. Copy, refresh confirmation, stop, failure display, busy/disabled states, and Bot entry/manage actions retain their current behavior. All five provider entry points remain, including the existing `entryProvider` routing to `BotsDialog`; only AstrBot is currently usable and other provider items must not imply native integrations are already available. Preserve the workspace path, identity, and remote session ID handoff.

## State ownership and interfaces

This is a presentation-only change. The existing desktop runtime retains authoritative connection state and Host attachment routing. `useWebRemoteControl` remains the UI projection/command boundary; `WebRemoteControlDialog` invokes its existing hook methods without adding a second runtime owner. `useZCodeTaskService` remains the public task-listing boundary used by the existing hook payload. `BotsDialog` remains the owner of bot configuration and receives the same workspace identity and selected `entryProvider`. Local dialog state remains limited to existing presentation state (open confirmation/dialog and provider selection). No command, Host/owner lease, admission queue, replay/recovery, configuration-discovery, or protocol interfaces change.

```text
QR input → existing useWebRemoteControl commands → platform → existing desktop runtime
                         ↑ status projection ←──────────────────────┘
                         └── WebRemoteControlDialog (presentation only)
Bot selection → existing entryProvider/workspace props → BotsDialog → existing BotsService
Task list → existing useZCodeTaskService payload → existing remote workspace/task sync

No owner/lease, admission, stale-run, desktop-continuous or web-remote-replayable changes.
```

## Localization

Keep existing translation keys compatible. In Chinese and English, the dialog summary describes both scanning a QR code to connect from a phone browser and using Bot Channels. QR and Bot Channel heading/help/CTA text is updated to be accurate and parallel. Bot text must not suggest that plain chat platforms open a workspace browser; communicate the AstrBot bridge path and that other native entries are not yet available, or use equally non-misleading concise wording. The close button uses the existing `common.close` localized message.

## Acceptance scenarios

- Actual browser rendering of the production component and Tailwind-compiled `styles.css` shows left QR/right Bots at >=768px and QR-above-Bots below 768px, with no horizontal overflow at either width.
- QR image geometry remains square in wide and narrow layouts.
- Validate English and Simplified Chinese under Zai Light and Zai Dark themes.
- QR copy, refresh cancel, refresh confirm, and stop trigger only their existing hook methods; busy/failure semantics remain intact.
- Each of the five Bot choices opens `BotsDialog` with its provider as `entryProvider`; manage opens it without a provider; close button invokes `onOpenChange(false)`.
- The browser smoke uses local fixtures/fake hooks and a simplified configuration boundary, makes no external or real-service requests, and uses no user configuration, credentials, or logs.

## Verification

`node scripts/ci/web-remote-control-dialog-smoke.mjs` renders the production `WebRemoteControlDialog`, real Button/Dialog/AlertDialog primitives, `WebRemoteControlEndpointSection`, `ProviderIcon`, `botsUi` helpers and the Tailwind-compiled `styles.css` in Chromium. Only service boundaries are fixture-backed: `useWebRemoteControl`, `useZCodeTaskService`, `useSettingService` and `BotsDialog` configuration; the real `ZCodeIntlProvider` and both locale dictionaries are used.

The smoke asserts, at 1200/768/390/320 CSS px, in `en-US` and `zh-CN`, under Zai Light and Zai Dark, that the dialog keeps viewport margins, does not overflow internally, keeps the QR image square, and places the QR region left of the Bot region at >=768px or above it below 768px. It also asserts copy/refresh-cancel/refresh-confirm/stop dispatch exactly their existing hook methods, busy/idle/failure states, endpoint settings saves, all five provider routes plus the manage route, the close callback, the workspace/identity/session handoff and that no non-loopback request is made. Removing the responsive two-column class makes the geometry assertions fail, so the layout claim is enforced rather than incidental.

The smoke runs in `desktop.yml` checks, so this layout stays gated in CI.
