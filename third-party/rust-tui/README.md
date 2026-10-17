# Rust TUI third-party notice snapshot

`sources.json` records the conservatively selected registry-crate dependency closure of `zcode-cli-tui` from `apps/zcode-cli-rust/Cargo.lock`. It contains 279 crates, including target-specific dependencies. This is **not** the complete Rust CLI dependency set or a complete license/compliance review.

Each archive is tied to its Cargo.lock checksum and explicit crates.io archive URL. The synchronizer extracts matching upstream license/notice members byte-for-byte into `snapshots/`; `.gitattributes` disables text conversion for those originals. Ten crates currently lack a recognized license-text snapshot and are marked `reviewRequired`. Those obligations are unresolved; do not treat this snapshot as evidence of release readiness or legal compliance.

The legacy npm notice generation/classification baseline remains separate: npm generation has 9 unresolved materials and 14 previously classified items in the existing baseline. It is not fixed, replaced, or resolved by this Rust TUI snapshot.

To refresh from the lockfile, run:

```sh
node scripts/sync-rust-tui-notices.mjs
```

It uses Cargo's local registry cache when available and downloads missing crate archives from the recorded public crates.io URL, verifying the archive SHA-256 against Cargo.lock before extraction. No extra dependency is required; GNU-compatible `tar` must be available.

Preview packaging stages this directory independently at `resources/licenses/rust-tui`, as well as the existing general third-party notices. This independent packaging path ensures the Rust TUI snapshots are included even when npm notice generation cannot run. It does not imply that unresolved review items are acceptable for release.
