# Upstream 3.18.2 BUI5 — browser design inspect loop

## Scope and ownership

Port the first closed loop of the upstream browser design tool into the existing human
browser side pane. The loop is: user starts inspect → guest page selects one element →
the inspector panel edits allow-listed style properties → the page previews the value →
the panel shows a precise source diff → the user explicitly applies → the existing
`IFileService` writes the validated HTML source.

This spec is the BUI5 contract. B1 (`upstream-3.18-browser-capabilities.md`) remains the
umbrella capability spec. BN5 owns Desktop native capture/export and the public platform
adapter; BUI5 only consumes that public adapter.

Owners:

- `packages/ui/src/browser-use/UnifiedBrowserView.tsx` stays the side-pane composition
  owner. BUI5 adds a design session beside it, not a second browser/tab owner.
- The existing human/agent tab registry and `browserKey` remain the only tab owner.
  `#92` mobile/full-view/frame policy and the embedded-browser permission owner are not
  touched.
- The Browser Guest remains the only page/capture owner. Inspect uses the existing
  transport-neutral `webview.executeJavaScript` exit; no second guest, iframe, queue, or
  postMessage bridge is introduced.
- The selected element, draft values, preview diff, and apply/cancel state are owned by
  one `useBrowserDesignInspect` instance per mounted browser tab.
- `IFileService` remains the only source writer. The design port only adds two narrow
  methods: strict UTF-8/HTML read and root-validated CAS write.
- The page/DOM is untrusted. It may return a source path, but it never chooses the file
  path, root, permissions, or executable code.

Web and mobile remote-control have no built-in guest browser. The design entry defaults
to unavailable there and adds no new RPC, permission, or tab capability.

## State and event order

```text
user toolbar ──inspect──▶ useBrowserDesignInspect (generation++)
                              │ executeJavaScript(inspect script)
                              ▼
                         guest page (untrusted)
                              │ one selected snapshot + claimed source path
                              ▼
                       validate shape / path grammar
                              │
                     IFileService.readDesignSourceFile(root,path)
                              │ locate element by tag/index/siblings/id/class
                              ▼
draft edit ──preview──▶ page style preview (no write)
      │               └─ read + rewrite source in memory → diff
      ▼
user Apply ──CAS write(expected=preview source)──▶ IFileService
      ├─ written → toast, clear preview baseline
      └─ changed / invalid / stale → revert page preview, keep source untouched
```

- One apply at a time. Every inspect/apply captures a generation keyed by browser key,
  workspace identity, and current page URL. A navigation, tab close, workspace switch,
  or cancel increments the generation; late async results are dropped and never update
  the new page.
- Preview is in-memory only. Only explicit Apply calls `writeDesignSourceFile`.
- The service resolves the real project root and the real target path, requires a
  project-relative `.html`/`.htm` file inside that root (symlinks followed and rechecked),
  accepts only lossless UTF-8 up to 4 MB, and writes only when the current bytes equal
  `expectedContent`. Read-compare-write is serialized per real path.
- Page-claimed source paths are only locator hints. A wrong sibling count, tag, id, or
  class makes the locator return `null`; the panel becomes read-only and nothing is
  written. The page cannot select the file, root, or write destination.
- Style edits are an allow-list of CSS properties with anchored value validators. Values
  containing declaration/rule/URL/expression syntax are rejected before preview or apply.
  No HTML, JavaScript, `eval`, `new Function`, or `url(...)` is accepted from the page.
- Screenshot/page export calls only the public platform adapter when
  `captureBrowserGuestPage` / `printBrowserGuestPage` + `saveFile` capabilities exist.
  Otherwise the action is visibly disabled as unavailable. BUI5 does not add or change
  the platform interface, Desktop capture, or preload bridge.

## B6 — two-end integration (UI ↔ platform) and source write safety

B6 closes the seams BUI5/BN5 left open. BN5 stays the owner of the Main capture handler,
its crop math, and `resolveCaptureGuestBinding`; B6 only consumes them and adds the
matching print port. BUI5 stays the owner of the inspect session.

### One export contract

- `browserDesignExport` must not declare private `CaptureBrowserGuestPageRequest` /
  `...Result` shapes. Requests and results are the `@zcode/shared` public contract
  (`CaptureBrowserGuestPageRequest/Result`, `PrintBrowserGuestPageRequest/Result`,
  `SaveFileRequest/Result`); no `as` cast, no structurally-compatible twin. A button is
  enabled only when the real port method exists and the tab's current guest id is valid,
  so a "available but always fails" button cannot appear.
- Page PNG / element PNG go through `captureBrowserGuestPage`; PDF goes through the real
  public print port `printBrowserGuestPage` (Main prints the owned guest). The UI never
  declares or calls a `printToPDF` on the `<webview>`.
- Request fields come from the real view: `webContentsId` is the guest id the renderer
  reported for this tab, `clip` is the inspected element's `getBoundingClientRect()`
  (CSS px) plus the measured CSS viewport. Main re-validates the clip against the actual
  frame (`clip_out_of_view`); the UI does not clamp silently.
- Each export snapshots owner/session/tab/generation (`browserKey`, `sessionId`,
  `workspaceKey`, `residencyGeneration`, webview generation). The snapshot is compared
  after every await; a changed snapshot returns `stale` and drops the result instead of
  saving a frame from the previous page. The renderer "exporting" flag is per hook
  instance, Main serializes per guest.

### Source writer path safety

`designSourceFile` writes the same inode it validated. The flow is:

```text
realpath(root) + open(root, O_DIRECTORY|O_NOFOLLOW) → root dev/ino
realpath(path) → containment(.html) → open(path, O_RDONLY|O_RDWR + O_NOFOLLOW)
  → fstat(fd): regular file, nlink == 1 (a hardlink may alias outside the project)
  → realpath(path) again + stat: same dev/ino as fd, still inside root, root dev/ino unchanged
    (both before and after the write; the resolved root must be a real directory, not a link)
  → owner lock keyed by dev:ino → read via fd → UTF-8 + size checks → CAS
  → verify path/fd/root identity again → truncate+write+fsync via the fd
```

- A preview path swapped to a symlink between resolution and open fails with `ELOOP`
  (`invalid_path`); a path re-pointed after the check is caught by the second identity
  verification; the write still goes to the originally validated inode, never to a newly
  linked external file.
- Two same-baseline writers serialize on one owner lock keyed by `dev:ino`; exactly one
  writes, the other returns `changed`. This is a single-process guarantee — uncooperative
  external processes are detected only by the content compare, not by a cross-process
  strong CAS. Replacing the whole workspace root directory between two calls is not
  detectable statelessly; the checked boundary is the target path inside the resolved root.
- IO failure is explicit: traversal/type/link errors map to `invalid_path`, real write
  failures (EACCES/ENOSPC/EIO/…) to `io_failed`; nothing is reported as success.

## B7 — host-approved design root authority

B6 proves the _target_ is inside the `rootPath` the caller sent, but it never proves the
`rootPath` itself is an approved project root. The interface doc claims the opposite
ownership ("the page cannot choose root/path"), so the Host must own the root fact
too: a renderer that hosts an untrusted guest page (the weakest trust boundary here)
could otherwise pass `rootPath: "/"` and read/CAS-overwrite any `*.html` on disk.

### Owner and facts

- `DesignSourceAuthority` is a read-only resolver injected into the `createFileService`
  instance. It returns the roots this Host currently approves for design source I/O:
  `resolveApprovedRoots(): Promise<readonly string[]>`.
- The production assembly (`createLocalServices`, desktop-local Host only) derives them
  from the facts the Host already owns — `IProjectService.readTree()`: every root of a
  non-deleted project owned by this Host, plus every current task workspace/cwd of this
  Host. No new project table, authorization cache, or second store is created; each
  read/write re-reads the tree, so adding/removing a project root or project takes
  effect on the next call.
- The resolver is wired through a lazy callback because `createFileService` is assembled
  before `projectService` in `createLocalServices`; a direct reference would be a TDZ
  error, and evaluating the tree during assembly would recurse into startup. The callback
  is only evaluated by a real design read/write.

### Authorization

Per read and per write, before opening anything:

```text
authority.resolveApprovedRoots()          # fresh Host facts, no cache
  → requested rootPath must be absolute
  → resolve(rootPath) must equal one approved root (normalized)
  → reject symlink aliases, foreign Host roots, removed roots, stale grants
  → then the B6 path: realpath(root) + realpath(path) containment + .html + O_NOFOLLOW
    + nlink==1 + identity/root re-verification + CAS
```

- The approved root must match as the canonical absolute path string. A symlink that
  points at an approved root is a _different_ root string and is rejected
  (`unauthorized_root`); the renderer cannot mint its own authority by linking.
- `rootPath: "/"` or `"/tmp"` is rejected even when the target file itself is a real
  project file. The UI may only send the project root the Host already knows; it cannot
  widen the allow-list.
- Fail closed when no authority is assembled (legacy constructor calls, Web/server Host,
  desktop-attached-remote Host): design read rejects with
  `design_source_unauthorized_root`, design write returns
  `{ written: false, reason: "unauthorized_root" }`. Every other `IFileService` method
  keeps its previous behavior — this is **not** a claim that the renderer is globally
  FS-sandboxed.
- Web/mobile: only the desktop-local assembly injects an authority, so the design ports
  default-deny there without adding channels to any allow-list. The UI design entry is
  additionally unavailable for remote workspace identities, and a remote workspace's
  absolute path is never resolved against local project facts.

## Acceptance scenarios

1. A controlled loopback page served over `127.0.0.1` runs the production inspect script
   in real Chromium: selecting the heading returns its tag/source path and computed
   values. Editing the font size previews on the page and computes a source diff, but the
   temp project file is unchanged until Apply.
2. Apply writes only the selected `style` attribute in the temp project through the real
   `createFileService`, preserving every other source byte.
3. A target outside the project root is rejected by the service with no write. A link or
   traversal that resolves outside the root is rejected after `realpath`.
4. A stale CAS (`expectedContent` no longer matches) returns `changed`, leaves the file
   untouched, and the hook reverts the page preview without changing the new session.
5. Cancel/dispose removes the temporary target marker and restores the original style
   attribute; a late result from the cancelled generation is ignored.
6. A forged source path (wrong index/siblings/id/class) cannot write. Invalid style values
   (`red; }`, `url(...)`, `<script>`) are rejected.
7. Existing human/agent tabs, mobile/full view, site permissions, browser generation,
   CommandInbox, and workspace identity/lease behavior are unchanged; agent tabs never
   receive the design entry.
8. Electron loopback drives the production design toolbar in a real renderer with the
   production platform bridge: the PNG button reaches the real Main capture handler and
   the PNG bytes arrive at `saveFile`; the element button sends the inspected element's
   rect as `clip` and the saved PNG has the clipped size; the PDF button reaches the real
   Main print handler and the saved bytes start with `%PDF`.
9. A capture for a guest of another window/tab is rejected by Main (`guest_not_owned`) and
   nothing is saved; an export whose tab generation changed before the frame returned
   reports `stale` and does not save.
10. In a temp project: a symlinked preview path, an ancestor symlink swap, and a hardlink
    to an outside file are rejected without touching the outside file; two concurrent
    same-baseline writes produce exactly one write.
11. A `getInstalledEditors` consumer that asks for "open with" on a concrete file passes
    the file path, so Desktop can append file-type applications.
12. A real `createFileService` with an authority approving a temp project reads and
    CAS-writes its HTML; the same service called with `rootPath: "/"` or `"/tmp"`
    returns `unauthorized_root` and leaves the file untouched; `createFileService()`
    without an authority denies both read and write.
13. A symlink alias of the approved root, a root removed from the authority, and an
    authority that throws are rejected on the next call (no cached grant), while the
    approved root keeps working.
14. The production authority reads the Host project/task facts: local project roots and
    task cwds are approved; a foreign-Host row, a deleted project, and a non-absolute
    entry are not; replacing a project's roots revokes the old root on the next read.
15. A remote workspace identity does not expose the design entry, and no assembly other
    than desktop-local can read/write design sources by default.

## Migration boundary

Use `.cache/upstream-3.18.2@fec97590` only as behavior evidence. Do not copy the upstream
`design-runtime` package, page postMessage bridge, preload changes, parse5 dependency,
CUA sleep-frame code, or Desktop capture/platform contract. Do not add a second
project/root store or an authorization cache: the design authority must read the
existing project tree. Do not change root lockfiles, generated catalogs, licenses,
global formatting baselines, or unrelated local work. Unimplemented upstream behaviors (multi-select, CSS variables, variants,
slides, undo/redo history, auto live-reload, element screenshot) are listed in
`/tmp/sync318-BUI5-result.md`.
