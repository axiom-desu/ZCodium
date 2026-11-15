# Upstream 3.18.2 B1 — browser capabilities and installed-app enumeration

## Scope and ownership

Port the upstream `browser-design` inspector/property-editing/source-writing flows, page capture/export and site-permission prompts, plus the guest-backed foreground/background screenshot pipeline; do not restore removed CUA sleep-frame behavior. The existing Browser Guest manager remains the sole owner of guest/tab lifecycle and capture execution; existing browser-use side pane and toolbar own user-visible browser controls. Site permission decisions remain in the embedded-browser permission owner. Workspace source changes flow through the existing `IFileService`/validated project boundary and must be previewed as a precise draft before explicit apply. Installed-application enumeration is a platform capability exposed through `IPlatformService`; native Desktop adapters own OS enumeration and Web returns unsupported/empty.

## Invariants and boundaries

- No second browser manager, tab registry, site permission policy, or screenshot queue.
- Main/guest capture callbacks must be wired to existing routes and preserve browser owner, generation, workspace identity, `#92` mobile/full-view/frame policies, and `S1` mobile RPC deny policy.
- Browser page content is untrusted: cross-origin or untrusted pages cannot select filesystem paths, broaden permission, execute arbitrary source, or cause automatic HTML/script writes. Source edits accept only validated project-relative source paths and explicit, bounded text edits; preview draft then user-confirmed apply.
- Screenshot and export are page/browser outputs only; host filesystem destinations are selected by the trusted platform save path, never by page data.
- Preserve existing guest capture/background screenshot readiness and lifecycle behavior; no timer/sleep-frame fallback.
- Scope excludes E1 extension slots and A1 app-control navigation; they are separate capabilities.

## BN5 ownership split (implemented slice)

- Desktop main owns guest frame capture: `packages/desktop/src/main/desktopCaptureBrowserGuestPage.ts` registers the
  `PlatformChannels.CaptureBrowserGuestPage` handler. It never creates a second guest/tab registry; it resolves the
  current guest through the existing `BrowserGuestManager` owner lookup (`getTabOwnerByWebContentsId`) and only then
  reads a frame with `guest.capturePage()`.
- Crop math and the owner/generation accept-or-reject decision are pure modules
  (`desktopCaptureBrowserGuestPageCrop.ts`, `desktopCaptureBrowserGuestPagePolicy.ts`) so they can be tested without
  Electron. Reason codes stay identical to upstream: `guest_not_found`, `guest_not_owned`, `capture_in_progress`,
  `capture_timeout`, `capture_failed`, `clip_out_of_view`.
- Guest lifecycle: a destroyed/closed guest cancels its capture waiter; a timed-out capture keeps the guest busy
  until the underlying `capturePage()` settles or the late-release deadline expires. There is no sleep-frame or
  timer-driven frame source, and background/live-background residency stays owned by the existing manager.
- `captureBrowserGuestPage` is an optional `IPlatformService` method. Web/mobile platform services do not define it,
  so they deny the capability without new IPC or permission widening.
- Installed-application enumeration is a Desktop-only platform capability:
  `packages/desktop/src/main/file-open-apps/` (managed module) parses native associations per OS;
  `packages/desktop/src/main/fileApplications.ts` supplies editor-shaped file application definitions used by the
  existing `getInstalledEditors(filePath?)` getter, so Linux no longer resolves to an always-empty list.
  Consumers keep using the existing open-with surface; no second policy or file-menu store is introduced.
- Native parsing is pure/offline: Linux `.desktop` entries are parsed from an injected XDG root set, macOS/Windows
  records come from the native JSON payload. Malformed, BOM-only, non-array, relative-path, NUL-byte, directory,
  remote-target and workspace-identity-prefixed inputs fail closed to an empty list or `unsupported_file_target`.

## Event flow

```text
browser-use toolbar/UI -> existing guest/tab owner -> validated Main IPC callback -> guest capture / permission owner
                                                         |-> screenshot/export -> trusted platform save
                                                         `-> inspect -> validated project draft -> explicit apply -> IFileService
platform app enumeration UI -> IPlatformService -> Desktop native adapter (OS-specific) -> validated records
```

Tab/session/workspace owner identity and browser generation are revalidated on every Main-side operation. A stale or foreign-owner callback is rejected; denied/unresolved permission prompts default to deny. Validation failure never partially writes.

## Acceptance scenarios

1. Existing browser-use toolbar launches inspector and property editing on a controlled loopback page; generated changes are shown as a precise draft, and only explicit apply writes validated source through a fake-controlled or temporary workspace file service.
2. Cross-origin/untrusted content cannot write outside the validated project, request arbitrary filesystem paths, invoke unsafe HTML/script execution, or implicitly grant site permissions.
3. True Chromium/Electron browser guest using a temporary profile and loopback page captures screenshot and exports page; permission denial is observable and no external network or user profile is touched.
4. Background screenshot capture is guest-backed and owner/generation-safe, with no sleep-frame implementation; existing mobile/full-view/frame policy and S1 deny remain intact.
5. Linux/macOS/Windows installed-app parsers enumerate fixture data and reject malformed records/path injection; platform consumers call the existing interface.
6. The guest capture handler rejects a foreign sender window, a guest that is not the current tab guest (stale
   generation / closed tab), and non-integer webContents ids, and releases the per-guest in-flight slot on guest
   destruction.

## Migration boundary

Use upstream reference `.cache/upstream-3.18.2` at `fec97590` only as behavior evidence. Do not copy removed CUA sleep-frame code, create a parallel browser manager/policy, or change root lockfiles, package manifests, generated artifacts, global formatting baselines, or unrelated local work. Any behavior not safely implemented or validated must be listed explicitly in `/tmp/sync318-B1-result.md`.
