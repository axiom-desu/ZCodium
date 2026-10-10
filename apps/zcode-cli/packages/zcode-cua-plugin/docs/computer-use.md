# Computer Use

Model-facing API reference for the `computer-use` plugin. The skill
([`skills/computer-use/SKILL.md`](../skills/computer-use/SKILL.md)) holds the working
rules; this page holds the argument shapes and response fields. It is served on demand
through `agent.documentation.get("computer-use")` — the host never pushes it into the
conversation, so read it only when an argument shape below is not enough.

The plugin supplies this SDK and the instructions. `node-repl-host` owns the Worker
bridge and the authenticated broker; `@zcode/zcode-cua` adapts calls to the bundled
`@trycua/cua-driver` runtime. Linux and Windows use the in-process SDK when Computer Use
is enabled. An unavailable runtime fails closed.

```text
node_repl cell → skill SDK → Worker bridge → host broker
              → CUA adapter → bundled native driver → application UI
```

## Bootstrap

```js
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const root = process.env.ZCODE_CUA_PLUGIN_ROOT;
if (!root) throw new Error("Enable Computer Use before using this skill.");
const sdk = await import(pathToFileURL(join(root, "scripts/computer-use-client.mjs")).href);
await sdk.setupComputerUseRuntime({ globals: globalThis });
const cua = agent.computerUse;
```

Every `node_repl` cell is a fresh JavaScript Worker: imports, module cache and bindings
are gone by the next call. The runtime keeps the current window observation, so a new
cell rebinds rather than re-observing from scratch. Bootstrap and act in the same cell.

## Availability

| Capability | Status |
| --- | --- |
| `getState` / `listApps` / `getApp` / `getWindow` and the observation methods | Available |
| `click` `drag` `scroll` `typeText` `pressKey` `setValue` `paste` | Available |
| `selectText` / `performSecondaryAction` | Reachable but the runtime answers `ACTION_UNAVAILABLE` |
| `paste` rich formats (`md`, `html`) | Not implemented; `PasteOptions.format` is accepted and ignored — plain text only |
| Launching a closed application | Not implemented — `getApp` binds an app that is running |
| macOS | Outside the Linux/Windows release validation; permissions use the existing embedded-host route |

A missing runtime, an unavailable operation and a denied permission are reported as
such. None of them is reported as success.

## API

```typescript
type Vec2 = [x: number, y: number];
type ObservationOptions = { emit?: boolean };
type StateOptions = ObservationOptions & { disableDiffing?: boolean };
type StateAndScreenshot = { state: string; screenshot?: Uint8Array };
type Direction = "up" | "down" | "left" | "right";
type MouseButton = "left" | "right" | "middle";
type Strategy = "auto" | "a11y" | "event";
type DeliveryMode = "background" | "foreground";

type ClickOptions = {
  mouseButton?: MouseButton;
  clickCount?: number;
  modifiers?: string;
  strategy?: Strategy;
};
type DragOptions = { deliveryMode?: DeliveryMode; modifiers?: string };
type KeyOptions = { holdSeconds?: number; strategy?: Strategy };
type ScrollOptions = { strategy?: Strategy };
type PasteOptions = { format?: "text" }; // accepted; the runtime pastes plain text only
type SelectTextOptions = { prefix?: string; suffix?: string; selectionType?: "text" | "cursor_before" | "cursor_after" };

type Target = number | Vec2;
type AppRef = { name?: string; bundle_id?: string; pid?: number; window_id?: number };
type AppInfo = { pid: number; name: string | null; bundle_id: string | null; active: boolean };
type AppState = { apps: AppInfo[] };
type Element = { index: number; kind: string; title: string | null; value: string | null; actions: string[] };

interface BoundApp {
  getAXState(options?: StateOptions): Promise<string>;
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  getAXStateAndScreenshot(options?: StateOptions): Promise<StateAndScreenshot>;
  elements(): Promise<Element[]>;

  click(target: Target, options?: ClickOptions): Promise<void>;
  drag(from: Target, to: Target, options?: DragOptions): Promise<void>;
  scroll(target: Target, direction: Direction, pages?: number, options?: ScrollOptions): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string, options?: KeyOptions): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  paste(text: string, options?: PasteOptions): Promise<void>;
  selectText(elementIndex: number, text: string, options?: SelectTextOptions): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
}

declare const agent: {
  computerUse: {
    getState(options?: ObservationOptions): Promise<AppState>;
    listApps(options?: ObservationOptions): Promise<AppInfo[]>;
    getApp(target: string | AppRef): Promise<BoundApp>;
    getWindow(target: string | AppRef, windowId: number): Promise<BoundApp>;
    computer: Record<string, (args: object) => Promise<unknown>>;
    requestAccess(capabilities?: string[]): Promise<Record<string, unknown>>;
    stop(reason?: string): Promise<void>;
  };
};
```

`getState`, `listApps`, `getAXState`, `getScreenshot` and `getAXStateAndScreenshot`
display their own result; pass `{ emit: false }` to read the value without adding it to
the conversation. Action methods display nothing. Never write an observation to
`nodeRepl.write` or `nodeRepl.emitImage` yourself: a second raster in one result breaks
the one-raster rule and the whole frame is discarded.

### `agent.computerUse`

- `listApps()` — every app the runtime can address. `getState()` returns the same list
  on the `apps` key.
- `getApp(target)` — binds an app by display name, bundle id or `{name|bundle_id|pid|window_id}`.
  Binding performs a hidden observation to resolve identity and window, and validates the
  app, but shows nothing: call `getAXState()` to see the tree. It does not launch a closed
  app.
- `getWindow(target, windowId)` — binds one window of an app. Available but not part of the
  documented surface; prefer pinning through `getApp({ pid, window_id })`.
- `elements()` — on the bound app. Returns every element with its index, including ones the
  trimmed tree omitted. Filter in JavaScript; never guess an index.
- `requestAccess(capabilities?)` — asks the runtime to report the permissions it currently
  holds. Loading the SDK grants nothing.
- `stop(reason?)` — ends the control session. The reason is accepted for symmetry and is
  not forwarded to the driver today.
- `computer.target` — `"linux"`, `"windows"` or `"mac"` for the current platform.

## Tool arguments

`agent.computerUse.computer.<tool>(args)` is the low-level surface behind the bound
object. Reach for a tool only for what the bound API does not express — window
enumeration, key repeat, or reading state back in the same call. Each tool takes exactly
one arguments object; the names below are its keys, not positional parameters. Any
other key is ignored rather than forwarded to the driver, so do not invent one.

```js
await cua.computer.get_app_state({ app_ref: { name: "Calculator" }, include_screenshot: true });
```

| Tool | Arguments |
| --- | --- |
| `list_apps` | — |
| `list_windows` | `app_ref` |
| `get_app_state` | `app_ref`, `window_id?`, `include_screenshot?` (`false`), `disable_diffing?` (`false`), `tree_shown_to_model?` (`true`) |
| `left_click` | `target`, `app_ref`, `mouse_button?` (`"left"`), `click_count?` (`1`), `modifiers?` |
| `left_click_drag` | `from_target`, `to`, `app_ref`, `modifiers?`, `delivery_mode?` |
| `scroll` | `target`, `app_ref`, `scroll_direction` (`up`\|`down`\|`left`\|`right`), `scroll_amount?` (pages, `1`) |
| `type` | `text`, `app_ref`, `target?` |
| `key` | `text` (chord), `app_ref`, `repeat?`, `hold_seconds?` |
| `set_value` | `target`, `app_ref`, `value` |
| `paste` | `text`, `app_ref` — the runtime writes the clipboard and sends the paste chord |
| `select_text` | `target`, `app_ref`, `text_range` — answers `ACTION_UNAVAILABLE` |
| `perform_action` | `target`, `app_ref`, `action` — answers `ACTION_UNAVAILABLE` |
| `request_access` | `capabilities?` |
| `stop_computer_control` | — |

A bare string passed as `app_ref` is read as a bundle id. Pass `{ name: "…" }` for a
display name. `target` is an element index or `[x, y]` screenshot pixels, exactly as in
the bound API. An unknown tool name answers `INTERNAL`.

## Observations

The runtime holds the current observation per window. Element numbers belong to the
latest observation of that window; never reuse a number from another app or infer one
from a screenshot.

- `getAXState()` shows the tree and returns it as text. The tree comes back as a diff
  against a tree this cell already showed; the first tree after binding, and the first
  after `getScreenshot()` or `elements()`, are always complete. Pass
  `{ disableDiffing: true }` for a full tree at any point.
- `getScreenshot()` returns the bytes of one window. It yields no tree, so it never
  becomes a diff baseline.
- `getAXStateAndScreenshot()` returns `{ state, screenshot? }` and shows both.
- A large tree is trimmed by priority and the header says so; indices then skip numbers.
  `elements()` is the way to reach a trimmed index.
- Without a `window_id` the main window is re-resolved on every observation, so a modal
  that just opened becomes the captured window. When an action fails, read the returned
  `window` and act on it or dismiss it.
- Producer notes such as `[effect_evidence unchanged]` or `[screenshot unavailable: …]`
  are appended to the returned text. They are the only signal that an accepted action
  changed nothing, so read them before deciding the action worked.

## Coordinates

Use non-negative integers inside the raster you are looking at. Desktop coordinates and
window bounds are diagnostic screen points, not screenshot pixels — never copy an
element or window bound into a coordinate. A new observation invalidates an older frame:
re-observe after switching windows or after `STALE_STATE`.

## Errors

Actions resolve to `undefined` on success and throw `ComputerUseError` otherwise.

| Field | Meaning |
| --- | --- |
| `code` | One of the codes below |
| `actionSent` | Whether the action may already have reached the app |
| `retry` | `"reobserve"`, `"retry"` or `"never"` |
| `dispatchStatus` | The runtime's own status string, when it sent one |
| `details` | Diagnostic fields such as `method`, `brokerCode` or `missing` |

| Code | Raised when |
| --- | --- |
| `STALE_STATE` | The target has no current observation, or the observation is stale |
| `INVALID_APP` | The app reference is missing, malformed or unresolvable |
| `PERMISSION_DENIED` / `NOT_AUTHORIZED` | The platform refused the operation |
| `LAUNCH_FAILED` | The app could not be brought up |
| `ELEMENT_UNAVAILABLE` | The element is gone, or pixels are unavailable |
| `NOT_SETTABLE` / `NOT_SELECTABLE` | The element does not support that edit |
| `ACTION_UNAVAILABLE` | The operation is not implemented by the runtime |
| `FOREGROUND_REQUIRED` | The app ignores background input |
| `CONTROLLER_BUSY` | Another live session owns input |
| `HELPER_UNAVAILABLE` | The runtime bridge is not reachable |
| `VERSION_MISMATCH` | Driver and adapter versions disagree |
| `TIMEOUT` | The runtime did not become ready within its bounded wait |
| `STRUCTURED_STATE_UNAVAILABLE` | An observation arrived without usable state fields |
| `INTERNAL` | Anything unclassified, including an unmapped runtime code |

`actionSent: true` means the UI may already have changed: observe again before retrying
so a click is not sent twice. `retry: "reobserve"` means the same. `retry: "never"` means
the failure will not change on its own — report it instead of repeating the call. An
unknown runtime code is mapped to `INTERNAL` rather than to a success.
