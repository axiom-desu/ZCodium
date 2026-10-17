# Rust TUI license provenance

Scope: the conservative transitive registry closure of `zcode-cli-tui` in
`apps/zcode-cli-rust/Cargo.lock`, including target-specific and same-name
multi-version dependencies. This is **not** a complete Rust CLI SBOM.

`node scripts/sync-rust-tui-notices.mjs` verifies crate archives against Cargo.lock
and refreshes `sources.json` and original text snapshots. Ordinary verification
uses checked-in evidence, not the developer's Cargo cache or network.

Additional source registrations are in `scripts/rust-tui-upstream-notices.mjs`:

- JNI, JNI macros, JNI sys macros, RMCP and Android platform verifier: original
  MIT/Apache texts from the revision identified by the published archive's VCS
  metadata and package manifest.
- `r-efi`: the original archive's **AUTHORS** file already contains the MIT grant
  and original copyright. The collector now recognizes this material rather than
  treating a plain author list as sufficient permission.
- Winapi GNU import-library crates 0.4.0: their archives lack VCS metadata. Every
  published file except Cargo-generated normalized Cargo.toml was compared with
  Git revision `b76bbbf40dbfe5bec35a566caa70fd852824213a`: **1390 / 1419** exact Git
  blob matches, including original manifests, source and static import libraries.
  The file-by-file evidence and hashes are in
  `snapshots/winapi-source-matches.json.txt`; original MIT/Apache terms come from
  that same revision. This is source-correspondence evidence, not a fabricated
  archive VCS field or a nearby-version license.
- objc2 Core Foundation / IOKit: retain the same-revision original licensing
  declaration and explicitly selected Apache-2.0 **standard terms** from Apache.
  These standard terms are labelled as such, not as an upstream copyright notice.
  Their original declaration also warns of Apple SDK-derived source licensing
  implications, so both remain `reviewRequired`; this task does not approve that
  separate issue merely because license text is now present.

Current material set: 279 registry crates, 492 archive notices, 17 additional
upstream/selected-standard texts, plus source-match evidence. No originally
reported crate remains without license material, but the two objc2 substantive
reviews remain blocking under `check --strict`.

Verification binds the exact lock-derived crate set/checksums, pinned source
registrations, text hashes and source-match evidence. It rejects omissions,
duplicates, wrong revisions/versions, tampering and paths/symlinks escaping the
snapshot root. Original bytes (including CRLF) are preserved by `.gitattributes`.

Aggregate generation includes these texts and provenance inputs. Preview also
ships this directory separately at `resources/licenses/rust-tui`. See
`../README.md` for the ordinary/strict checks and remaining repository-wide
review obligations. These records are evidence, not a compliance certification.
