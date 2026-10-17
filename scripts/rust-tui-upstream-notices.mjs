import { createHash } from "node:crypto";

// Extra license originals for crates whose published archive omits them.
// Descriptors are pinned to the archive's .cargo_vcs_info.json and normalized Cargo.toml.
export function verifyRustSourceMatch(registration, bytes) {
  const expected = registration.evidence.sourceMatch;
  if (!expected) return;
  if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
    throw new Error("Rust source-match evidence changed");
  const proof = JSON.parse(bytes);
  const records = proof.packages.filter(
    (item) => item.name === registration.name && item.version === registration.version,
  );
  const item = records[0];
  if (
    records.length !== 1 ||
    item.archiveSha256 !== registration.archiveSha256 ||
    item.revision !== registration.revision ||
    item.pathInVcs !== registration.pathInVcs ||
    item.mismatches.length ||
    item.matches.length !== expected.matchedFiles ||
    new Set(item.matches.map((match) => match.sourcePath)).size !== expected.matchedFiles ||
    item.matches.some(
      (match) =>
        !/^[a-f0-9]{40}$/u.test(match.gitBlobSha1) ||
        !/^[a-f0-9]{64}$/u.test(match.sha256) ||
        !match.sourcePath.startsWith(`${registration.pathInVcs}/`),
    )
  )
    throw new Error("Rust source-match version/revision proof mismatch");
}

export function rustUpstreamEvidence(registration) {
  return {
    repository: registration.repository,
    revision: registration.revision,
    pathInVcs: registration.pathInVcs,
    archiveVcs: registration.evidence.archiveVcs,
    package: registration.evidence.package,
    ...(registration.evidence.sourceMatch
      ? { sourceMatch: registration.evidence.sourceMatch }
      : {}),
  };
}

export const upstreamNoticeRegistrations = [
  {
    name: "jni",
    version: "0.22.4",
    archiveSha256: "5efd9a482cf3a427f00d6b35f14332adc7902ce91efb778580e180ff90fa3498",
    repository: "https://github.com/jni-rs/jni-rs",
    revision: "5ae9458a4ec44c5318f37ddc7569c1d4ae8a69e7",
    pathInVcs: "crates/jni",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository",
      package: "jni@0.22.4",
    },
    notices: [
      {
        member: "LICENSE-MIT",
        url: "https://raw.githubusercontent.com/jni-rs/jni-rs/5ae9458a4ec44c5318f37ddc7569c1d4ae8a69e7/LICENSE-MIT",
        sha256: "fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960",
      },
      {
        member: "LICENSE-APACHE",
        url: "https://raw.githubusercontent.com/jni-rs/jni-rs/5ae9458a4ec44c5318f37ddc7569c1d4ae8a69e7/LICENSE-APACHE",
        sha256: "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
      },
    ],
  },
  {
    name: "jni-macros",
    version: "0.22.4",
    archiveSha256: "a00109accc170f0bdb141fed3e393c565b6f5e072365c3bd58f5b062591560a3",
    repository: "https://github.com/jni-rs/jni-rs",
    revision: "33045a124105c939d1e2cbdcb5a39e5d868ffa03",
    pathInVcs: "crates/jni-macros",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository",
      package: "jni-macros@0.22.4",
    },
    notices: [
      {
        member: "LICENSE-MIT",
        url: "https://raw.githubusercontent.com/jni-rs/jni-rs/33045a124105c939d1e2cbdcb5a39e5d868ffa03/LICENSE-MIT",
        sha256: "fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960",
      },
      {
        member: "LICENSE-APACHE",
        url: "https://raw.githubusercontent.com/jni-rs/jni-rs/33045a124105c939d1e2cbdcb5a39e5d868ffa03/LICENSE-APACHE",
        sha256: "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
      },
    ],
  },
  {
    name: "jni-sys-macros",
    version: "0.4.1",
    archiveSha256: "38c0b942f458fe50cdac086d2f946512305e5631e720728f2a61aabcd47a6264",
    repository: "https://github.com/jni-rs/jni-sys",
    revision: "64d77b7a5f119d7b55b4e2c169a4668067ff59e6",
    pathInVcs: "jni-sys-macros",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository",
      package: "jni-sys-macros@0.4.1",
    },
    notices: [
      {
        member: "LICENSE-MIT",
        url: "https://raw.githubusercontent.com/jni-rs/jni-sys/64d77b7a5f119d7b55b4e2c169a4668067ff59e6/LICENSE-MIT",
        sha256: "1d85bd754b04ceec93e98e890edd1fa3c6a22e81bcb32135806beeccefa51cd1",
      },
      {
        member: "LICENSE-APACHE",
        url: "https://raw.githubusercontent.com/jni-rs/jni-sys/64d77b7a5f119d7b55b4e2c169a4668067ff59e6/LICENSE-APACHE",
        sha256: "c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08",
      },
    ],
  },
  {
    name: "objc2-core-foundation",
    version: "0.3.2",
    archiveSha256: "2a180dd8642fa45cdb7dd721cd4c11b1cadd4929ce112ebd8b9f5803cc79d536",
    repository: "https://github.com/madsmtm/objc2",
    revision: "7b1abfd750a2cacaea71d6a56ecfb83cb7de560b",
    pathInVcs: "framework-crates/objc2-core-foundation",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository",
      package: "objc2-core-foundation@0.3.2",
    },
    notices: [
      {
        member: "LICENSE.md",
        url: "https://raw.githubusercontent.com/madsmtm/objc2/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md",
        sha256: "7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54",
      },
      {
        member: "selected-Apache-2.0-standard-terms.txt",
        kind: "standard-terms",
        url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
        sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
      },
    ],
    reviewRequired:
      "Original project grant and selected Apache-2.0 terms are preserved; upstream LICENSE.md expressly identifies unresolved Apple SDK-derived source licensing implications. This material audit does not approve those separate implications.",
  },
  {
    name: "objc2-io-kit",
    version: "0.3.2",
    archiveSha256: "33fafba39597d6dc1fb709123dfa8289d39406734be322956a69f0931c73bb15",
    repository: "https://github.com/madsmtm/objc2",
    revision: "7b1abfd750a2cacaea71d6a56ecfb83cb7de560b",
    pathInVcs: "framework-crates/objc2-io-kit",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository",
      package: "objc2-io-kit@0.3.2",
    },
    notices: [
      {
        member: "LICENSE.md",
        url: "https://raw.githubusercontent.com/madsmtm/objc2/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md",
        sha256: "7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54",
      },
      {
        member: "selected-Apache-2.0-standard-terms.txt",
        kind: "standard-terms",
        url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
        sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
      },
    ],
    reviewRequired:
      "Original project grant and selected Apache-2.0 terms are preserved; upstream LICENSE.md expressly identifies unresolved Apple SDK-derived source licensing implications. This material audit does not approve those separate implications.",
  },
  {
    name: "rmcp",
    version: "3.5.1",
    archiveSha256: "ab5023804cbe0304cbe06197ac16e645a0a0d0ffa2953bf735c15c2fa0213350",
    repository: "https://github.com/modelcontextprotocol/rust-sdk/",
    revision: "79437f291b2c44053d00dcd5db969fd0cca7c887",
    pathInVcs: "crates/rmcp",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository/license=Apache-2.0",
      package: "rmcp@3.5.1",
    },
    notices: [
      {
        member: "LICENSE",
        url: "https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/79437f291b2c44053d00dcd5db969fd0cca7c887/LICENSE",
        sha256: "0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a",
      },
    ],
  },
  {
    name: "rustls-platform-verifier-android",
    version: "0.2.0",
    archiveSha256: "eec689c0bc40ff2458a5977b6619cb718087084a18e02a131c599b62d05e1a5f",
    repository: "https://github.com/rustls/rustls-platform-verifier",
    revision: "252e25161a91af476cbea620e29d277592d27ec7",
    pathInVcs: "android-release-support",
    evidence: {
      archiveVcs:
        ".cargo_vcs_info.json git.sha1 + path_in_vcs; Cargo.toml package name/version/repository/license=MIT OR Apache-2.0",
      package: "rustls-platform-verifier-android@0.2.0",
    },
    notices: [
      {
        member: "LICENSE-MIT",
        url: "https://raw.githubusercontent.com/rustls/rustls-platform-verifier/252e25161a91af476cbea620e29d277592d27ec7/LICENSE-MIT",
        sha256: "1c7cf76689c837a68ed8d704994e52a0f2940c087958f860d17f3186afbdcc0c",
      },
      {
        member: "LICENSE-APACHE",
        url: "https://raw.githubusercontent.com/rustls/rustls-platform-verifier/252e25161a91af476cbea620e29d277592d27ec7/LICENSE-APACHE",
        sha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
      },
    ],
  },
  // r-efi 6.0.0 的完整 MIT 原文在 archive/AUTHORS，由同步器按原文收录；无需外部替代。
  {
    name: "winapi-i686-pc-windows-gnu",
    version: "0.4.0",
    archiveSha256: "ac3b87c63620426dd9b991e5ce0329eff545bccbbb34f3be09ff6fb6ab51b7b6",
    repository: "https://github.com/retep998/winapi-rs",
    revision: "b76bbbf40dbfe5bec35a566caa70fd852824213a",
    pathInVcs: "i686",
    evidence: {
      package: "winapi-i686-pc-windows-gnu@0.4.0",
      archiveVcs:
        "Archive omits cargo VCS metadata; all 1390 published files except Cargo-generated Cargo.toml match the pinned Git tree, including Cargo.toml.orig and every static import library.",
      sourceMatch: {
        file: "third-party/rust-tui/snapshots/winapi-source-matches.json.txt",
        sha256: "b9e0999060865c3fc42a60be71bc722514e5a5aa441a05fc93f8aebbd6f904d5",
        matchedFiles: 1390,
      },
    },
    notices: [
      {
        member: "LICENSE-MIT",
        url: "https://raw.githubusercontent.com/retep998/winapi-rs/b76bbbf40dbfe5bec35a566caa70fd852824213a/LICENSE-MIT",
        sha256: "5b19674a1db628a475850a131956ed49521b744e3dda8f5a94141f9aba681219",
      },
      {
        member: "LICENSE-APACHE",
        url: "https://raw.githubusercontent.com/retep998/winapi-rs/b76bbbf40dbfe5bec35a566caa70fd852824213a/LICENSE-APACHE",
        sha256: "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1",
      },
    ],
  },
  {
    name: "winapi-x86_64-pc-windows-gnu",
    version: "0.4.0",
    archiveSha256: "712e227841d057c1ee1cd2fb22fa7e5a5461ae8e48fa2ca79ec42cfc1931183f",
    repository: "https://github.com/retep998/winapi-rs",
    revision: "b76bbbf40dbfe5bec35a566caa70fd852824213a",
    pathInVcs: "x86_64",
    evidence: {
      package: "winapi-x86_64-pc-windows-gnu@0.4.0",
      archiveVcs:
        "Archive omits cargo VCS metadata; all 1419 published files except Cargo-generated Cargo.toml match the pinned Git tree, including Cargo.toml.orig and every static import library.",
      sourceMatch: {
        file: "third-party/rust-tui/snapshots/winapi-source-matches.json.txt",
        sha256: "b9e0999060865c3fc42a60be71bc722514e5a5aa441a05fc93f8aebbd6f904d5",
        matchedFiles: 1419,
      },
    },
    notices: [
      {
        member: "LICENSE-MIT",
        url: "https://raw.githubusercontent.com/retep998/winapi-rs/b76bbbf40dbfe5bec35a566caa70fd852824213a/LICENSE-MIT",
        sha256: "5b19674a1db628a475850a131956ed49521b744e3dda8f5a94141f9aba681219",
      },
      {
        member: "LICENSE-APACHE",
        url: "https://raw.githubusercontent.com/retep998/winapi-rs/b76bbbf40dbfe5bec35a566caa70fd852824213a/LICENSE-APACHE",
        sha256: "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1",
      },
    ],
  },
];
