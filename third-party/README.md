# Third-party materials

The application license does not replace third-party licenses. Original license,
copyright and NOTICE texts are preserved with exact versions, source references
and hashes. Records distinguish upstream originals, explicitly selected standard
license terms, locally written source instructions and material still requiring
review. They are not a legal compliance certification.

## Commands

- `node scripts/licenses.mjs notices`: regenerate `THIRD-PARTY-NOTICES.md` and
  `third-party/inventory.json` from current facts, without deleting unresolved
  obligations.
- `node scripts/licenses.mjs check`: validate installed-package license categories,
  narrow evidence-backed exact-version reviews, and notice/input freshness.
- `node scripts/licenses.mjs check --strict`: additionally reject **all** unresolved
  material/provenance obligations, including Rust entries absent from an old
  aggregate inventory. An ordinary pass is not a strict/release pass.

## Materials and refresh

- `npm-overrides.json`, `upstream/`: version-specific npm publisher originals or
  explicitly marked incomplete evidence. No invented copyright or adjacent
  version substitute.
- `cua-driver/`: CUA 0.28.2 / UBJS 0.31.0-3 publisher metadata, pinned upstream
  MIT/MPL terms, original runtime NOTICE, corresponding-source/build references
  and local packaging instructions. Refresh with
  `node scripts/sync-cua-license-review.mjs`, then regenerate aggregate notices.
  This review covers only the 15 exact name/version/license-expression tuples;
  it is not a general MPL allowlist. Changes or missing evidence fail closed.
- `rust-tui/`: locked crate archives, exact-revision upstream originals, selected
  standard terms and source-correspondence evidence. Refresh with
  `node scripts/sync-rust-tui-notices.mjs`, then regenerate aggregate notices.
- `office-runtime/`: exact name/version/license registrations for the three
  non-green Office build dependencies (`@fontsource/noto-sans-sc@5.3.1` OFL-1.1,
  `buffers@0.1.1` and `chainsaw@0.1.0` MIT/X11). Original material bytes live
  under the existing `upstream/office-runtime/` byte-preserving boundary, with
  97 font-slice hashes and publisher evidence. The font is a build-only
  dependency and is distributed only as a plugin asset; buffers/chainsaw are
  installed-only. Root identifiers scan prod+dev, root notices only the
  production graph. These records are not exemptions and do not reduce the 16
  remaining strict obligations.
- `copied-components.json`, `embedded-components.json`, `native-search/`,
  `runtime/`: copied-source, embedded native/WASM and runtime provenance. Some
  linked-library build provenance and original publisher material remains
  incomplete; consult the generated `reviewRequired` list rather than inferring
  completeness from a LICENSE file's presence.

Snapshot refresh commands intentionally use public upstream network resources;
ordinary verification is offline and does not depend on machine-specific caches.
Do not reformat original text snapshots. Generated notices and inventories are
updated through their generators, not by manually deleting review markers.

## Remaining strict obligations

After the Desktop CLI backfill, the aggregate lists 16 unresolved records: older
publisher/copy notices, Skia and QuickJS build provenance, one old Rust standard
library revision, and two objc2 Apple SDK-derived licensing questions. These
remain visible and blocked. No general exemption was added to make strict green.
