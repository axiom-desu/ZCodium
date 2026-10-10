---
name: computer-use
description: "Operate a desktop application through its accessibility tree and window screenshots: click, drag, scroll, type, paste, and set field values. Use when the task requires an application's UI and there is no dedicated API, connector, CLI, or skill. Web-page tasks belong to Browser Use. Main agent only. Requires the Computer Use plugin to be enabled and a supported local desktop session."
---

# Computer Use

Use the shared `node_repl` tool. Linux and Windows builds carry the cua-driver SDK
and native libraries; do not download a Helper, install another driver, or launch
an external computer-control server. Computer Use is disabled until the plugin
is enabled. A missing runtime or denied operation must be reported as unavailable,
not treated as success.

Operate only the application needed for the user's task. Keep screenshots and
application text in the current tool result; do not add them to diagnostic logs
or upload them to another service. Browser pages normally use Browser Use;
Computer Use is for desktop UI, including browser chrome when necessary.

## Start each cell

Every `node_repl` call uses a fresh JavaScript Worker. Repeat this bootstrap and
bind the target in every cell; variables from a previous cell do not survive.

```js
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const root = process.env.ZCODE_CUA_PLUGIN_ROOT;
if (!root) throw new Error("Enable Computer Use before using this skill.");
const sdk = await import(pathToFileURL(join(root, "scripts/computer-use-client.mjs")).href);
await sdk.setupComputerUseRuntime({ globals: globalThis });
const cua = agent.computerUse;
```

Discover the requested app with `await cua.listApps()`, then use its returned
name, bundle ID, or PID. `getApp` binds an existing app; do not assume it launches
a closed app. If the app has several windows, inspect
`await cua.computer.list_windows({ app_ref: { pid } })` and pin the intended window
with `await cua.getWindow({ pid }, windowId)`.

Copy an application name character-for-character from `listApps()`: do not
translate, localize, shorten or drop a suffix. `{"name":"网易云音乐app"}` is not
`{"name":"网易云音乐"}`, and a rewritten name resolves to another app or to
nothing. If the exact string does not resolve, call `listApps()` once and use the
identifier it returns instead of guessing a variation.

```js
// Replace the example PID with the one returned for the requested application.
const app = await cua.getApp({ pid: 1234 });
await app.getAXState();
```

Binding performs a hidden observation to validate the app. Call `getAXState()`
to actually show the tree. Element numbers belong to the latest observation of
that window; never reuse numbers from another app or infer them from a screenshot.

`await app.elements()` returns every element with its index, including the ones a
trimmed tree omitted — filter it in JavaScript instead of guessing an index.

The tree comes back as a diff against a tree this cell already showed: unchanged
rows are omitted and their indices stay valid. The first tree after binding, and the
first after `getScreenshot()` or `elements()`, is always complete, so pass
`{ disableDiffing: true }` only when you need a full tree at another point. A large
tree is trimmed by priority and the header says so, which is why indices then skip
numbers.

A capture is scoped to one window. Without a pinned `window_id` the main window is
re-resolved on every observation, so a modal that just opened becomes the captured
window: read the returned `window`, act on it or dismiss it, then observe again. A
missing element is not proof that an action worked.

## Observe, act, check

1. Read the tree with `getAXState()`, or obtain pixels with `getScreenshot()` /
   `getAXStateAndScreenshot()`.
2. Act on an observed element number or on pixels from that window's latest
   screenshot.
3. Observe again and verify the requested outcome. A successful input dispatch
   alone does not prove that a field changed or a button completed its operation.

```js
// Use the element number shown for the intended field in the current tree.
await app.click(7);
await app.typeText("the text requested by the user");
await app.getAXState();
```

For keyboard replacement, click the intended field first, then
`await app.pressKey("CTRL+A")` and `await app.typeText(text)` on Linux / Windows.
A field that supports semantic editing can use `await app.setValue(index, text)`.
Do not silently fall back to another field if the target is unavailable.

## Bound app methods

| Method                                        | Behavior                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAXState(options?)`                        | Shows the accessibility tree and returns its text. `{ emit: false }` suppresses text display; `{ disableDiffing: true }` requests the full tree.                                                                                                              |
| `getScreenshot(options?)`                     | Returns screenshot bytes; the host forwards the image itself.                                                                                                                                                                                                |
| `getAXStateAndScreenshot(options?)`           | Returns `{ state, screenshot? }`, showing the tree and forwarding any available image.                                                                                                                                                                        |
| `click(target, options?)`                     | `target` is an element number or `[x, y]`; options include `mouseButton`, `clickCount`, and `modifiers`.                                                                                                                                                      |
| `drag(from, to, options?)`                    | Both endpoints use element numbers or `[x, y]`. First obtain a screenshot; an element endpoint needs usable geometry in that same observation. `deliveryMode: "foreground"` explicitly permits the driver to activate the target and restore the prior focus. |
| `scroll(target, direction, pages?, options?)` | Scroll an observed target; direction is `up`, `down`, `left`, or `right`.                                                                                                                                                                                     |
| `typeText(text)`                              | Types into the focused field of the bound app.                                                                                                                                                                                                                |
| `pressKey(key, options?)`                     | Sends a key or chord to the bound app.                                                                                                                                                                                                                        |
| `setValue(index, value)`                      | Sets the value of an observed editable element if the platform supports it.                                                                                                                                                                                   |
| `paste(text, options?)`                       | Uses the clipboard; it changes clipboard contents. Only plain text is supported by the current adapter.                                                                                                                                                       |

`selectText` and `performSecondaryAction` are exposed by the compatibility SDK
but currently return `ACTION_UNAVAILABLE` from the runtime. Do not plan a task
around them or invent action names.

## Other entry points

- `await cua.getState()` / `await cua.listApps()` — the app inventory; both display
  their own result.
- `await agent.documentation.get("computer-use")` — the full API reference
  (argument shapes, response fields, error codes). Read it on demand instead of
  guessing an argument; the host does not push it into the conversation.
- `await cua.requestAccess(capabilities?)` — reports the permissions the runtime
  currently holds. Loading the SDK grants nothing.
- `await cua.stop(reason?)` — ends the control session. Stop immediately after a
  permission refusal or a non-retryable error instead of switching to another
  UI-automation technology.
- `await cua.computer.<tool>(args)` — the low-level surface. Prefer the bound-object
  API above; reach for a tool only for what the API does not express.

An observation displays itself; never pass its return value to `nodeRepl.write` or
`nodeRepl.emitImage` as well. A second raster in one result breaks the one-raster
rule and the frame is removed entirely, leaving no picture at all. Action methods
display nothing.

Never use AppleScript, `osascript`, JXA, System Events or shell commands to drive an
application, and do not use Computer Use for anything inside a web page — that
belongs to Browser Use.

For coordinate actions, use non-negative integer pixels inside the returned
image. Desktop coordinates and window bounds are not screenshot pixels,
especially with display scaling. A new observation invalidates an older frame;
get a fresh screenshot after switching windows or receiving `STALE_STATE`.
Do not bypass missing screenshot, stale-frame, or bounds errors with a guessed
coordinate. Accessibility targets remain available when their native tokens are
valid; their validity is checked by the driver.

## Failures and permissions

A failed action throws with `code`, `actionSent` and `retry`. Read `retry` before
repeating anything.

| Code | What to do |
| --- | --- |
| `STALE_STATE`, `STRUCTURED_STATE_UNAVAILABLE` | Observe the correct window again |
| `ELEMENT_UNAVAILABLE` | Inspect the updated UI; do not guess another element |
| `PERMISSION_DENIED`, `NOT_AUTHORIZED` | Explain the required local permission |
| `ACTION_UNAVAILABLE` | Unsupported; choose another interaction or explain the limitation |
| `INVALID_APP`, `LAUNCH_FAILED` | Resolve the app through `listApps()` and retry once |
| `NOT_SETTABLE`, `NOT_SELECTABLE` | The element does not support that edit |
| `FOREGROUND_REQUIRED` | The app ignores background input; decide deliberately |
| `CONTROLLER_BUSY` | Another live session owns input: report the owner and stop |
| `HELPER_UNAVAILABLE`, `VERSION_MISMATCH` | Enable the plugin or restore the bundled runtime; never fetch an official binary |
| `TIMEOUT` | The runtime did not become ready; do not loop |
| `INTERNAL` | Unclassified; re-observe and report if it repeats |

An error with `actionSent: true` may have changed the UI. Re-observe before
retrying to avoid duplicate clicks, typing, or submissions. Do not add your own
retry loop around actions; the runtime handles bounded cold-start waits and
only retries a background operation in the foreground when it was not sent.
Foreground fallback may briefly change focus.

Some applications, including Chromium on X11, ignore background synthetic drags.
For an interaction that requires foreground input, use
`await app.drag(from, to, { deliveryMode: "foreground" })` deliberately and verify
the result. A background dispatch returning success is not evidence of a drop;
do not automatically repeat it in the foreground.

Subagents and stale Worker generations are rejected by the host. Do not bypass
that boundary with shell automation. Linux accessibility and input support depend
on the desktop session; older GNOME/Wayland sessions may need the documented
local compatibility extension. macOS permissions use the existing embedded-host
route and are outside the Linux/Windows release validation.
