import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ZipFile } from "yazl";
import { tsImport } from "tsx/esm/api";

const { encodeConversationArchive, decodeConversationArchive, ConversationArchiveError } =
  await tsImport(
    "../../packages/services/src/conversation-share/conversationArchive.ts",
    import.meta.url,
  );
const { buildConversationSharePublicProjection } = await tsImport(
  "../../packages/services/src/conversation-share/conversationSharePublicProjection.ts",
  import.meta.url,
);
const { sha256ConversationShareJson } = await tsImport(
  "../../packages/services/src/conversation-share/conversationShareIntegrity.ts",
  import.meta.url,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(withArtifact = true) {
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10]);
  const base = {
    turnId: "private-turn",
    productTurnId: "private-product",
    createdAt: 1,
    createdAtSeq: 1,
  };
  const rows = [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    {
      ...base,
      rowId: 2,
      kind: "userInput",
      origin: "realUser",
      text: "Selected text 中文",
      clientId: "PRIVATE client",
      sourceCommandId: "PRIVATE command",
    },
  ];
  if (withArtifact)
    rows.push({
      ...base,
      rowId: 3,
      kind: "artifact",
      artifactVersionId: "private-artifact",
      logicalArtifactKey: "private-key",
      displayName: "result.txt",
      artifactType: "text",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: hash(bytes),
      ref: "zcode-artifact://session/private-result",
      state: "current",
    });
  const projection = buildConversationSharePublicProjection({
    rows,
    selectedProductTurnIds: ["private-product"],
  });
  return {
    title: "Selected conversation",
    rows: projection.rows,
    selectedProductTurnIds: projection.selectedProductTurnIds,
    artifacts: projection.artifacts.map(({ descriptor }) => ({ descriptor, bytes })),
  };
}

async function zip(entries) {
  const zip = new ZipFile();
  const chunks = [];
  const done = (async () => {
    for await (const chunk of zip.outputStream) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  for (const [name, value, options] of entries) zip.addBuffer(Buffer.from(value), name, options);
  zip.end();
  return done;
}
function manifest(input) {
  return {
    format: "zcodium-conversation",
    version: 1,
    title: input.title,
    rows: input.rows,
    selectedProductTurnIds: input.selectedProductTurnIds,
    artifacts: input.artifacts.map(({ descriptor }) => descriptor),
  };
}
function manifestBytes(content) {
  return JSON.stringify({ content, sha256: sha256ConversationShareJson(content) });
}
async function rawArchive(input, mutate = (entries) => entries) {
  return zip(
    mutate([
      ["manifest.json", manifestBytes(manifest(input))],
      ...input.artifacts.map(({ descriptor, bytes }) => [`blobs/${descriptor.sha256}`, bytes]),
    ]),
  );
}
async function rejects(bytes, code) {
  await assert.rejects(decodeConversationArchive(bytes), (error) => {
    assert.ok(error instanceof ConversationArchiveError);
    if (code) assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /PRIVATE|private-result|Selected text/);
    return true;
  });
}

test("portable archive round-trips selected public rows and binary artifacts without network", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network forbidden");
  };
  try {
    for (const withArtifact of [true, false]) {
      const input = fixture(withArtifact);
      const encoded = await encodeConversationArchive(input);
      assert.equal(encoded.subarray(0, 2).toString(), "PK");
      const result = await decodeConversationArchive(encoded);
      assert.deepEqual(result.content, manifest(input));
      for (const artifact of input.artifacts)
        assert.deepEqual(result.artifacts.get(artifact.descriptor.artifact_id), artifact.bytes);
      assert.doesNotMatch(
        JSON.stringify(result.content),
        /PRIVATE|private-turn|private-product|private-artifact/,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("manifest rejects unknown versions, private metadata, open references and incomplete turns", async () => {
  for (const mutate of [
    (content) => {
      content.version = 2;
    },
    (content) => {
      content.workspacePath = "/PRIVATE/workspace";
    },
    (content) => {
      content.artifacts[0].original_path = "/PRIVATE/file";
    },
    (content) => {
      content.rows[1].clientId = "PRIVATE client";
    },
    (content) => {
      content.rows[0].sourceCommandId = "PRIVATE command";
    },
    (content) => {
      content.rows[1].originMeta = { workId: "PRIVATE work" };
    },
    (content) => {
      content.rows[1].unknown = "PRIVATE field";
    },
    (content) => {
      content.rows[0].state = "running";
    },
    (content) => {
      content.rows[2].sha256 = "0".repeat(64);
    },
    (content) => {
      content.artifacts[0].producer_product_turn_id = "unknown";
    },
    (content) => {
      content.artifacts = [];
    },
    (content) => {
      content.rows.pop();
    },
    (content) => {
      content.selectedProductTurnIds.push(content.selectedProductTurnIds[0]);
    },
  ]) {
    const input = fixture();
    const content = manifest(input);
    mutate(content);
    await rejects(
      await rawArchive(input, (entries) => [
        ["manifest.json", manifestBytes(content)],
        ...entries.slice(1),
      ]),
    );
  }
});

test("archive rejects altered hashes, missing/extra/duplicate entries and damaged ZIP", async () => {
  const input = fixture();
  for (const mutate of [
    (entries) => entries.slice(0, 1),
    (entries) => [...entries, ["extra.txt", "PRIVATE extra"]],
    (entries) => [...entries, entries[0]],
    (entries) => [...entries, entries[1]],
    (entries) => [entries[0], [entries[1][0], "bad"]],
    (entries) => [
      ["manifest.json", JSON.stringify({ content: manifest(input), sha256: "0".repeat(64) })],
      entries[1],
    ],
    (entries) => [["manifest.json", "not JSON"], entries[1]],
  ])
    await rejects(await rawArchive(input, mutate));
  const encoded = await encodeConversationArchive(input);
  await rejects(encoded.subarray(0, encoded.length - 10));
  await rejects(Buffer.from("not a zip"));
});

test("archive rejects path traversal, symlinks, encrypted entries and oversized metadata before use", async () => {
  const input = fixture(false);
  const valid = await rawArchive(input);
  const replaceName = (name) => {
    const copy = Buffer.from(valid);
    for (let offset = 0; (offset = copy.indexOf("manifest.json", offset)) >= 0; offset += 13)
      copy.write(name, offset);
    return copy;
  };
  await rejects(replaceName("../evilx.json"));
  await rejects(replaceName("C:/evilx.json"));
  const symlink = await zip([
    ["manifest.json", manifestBytes(manifest(input)), { mode: 0o120777 }],
  ]);
  await rejects(symlink);
  const encrypted = Buffer.from(valid);
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await rejects(encrypted);
  const oversized = Buffer.from(valid);
  oversized.writeUInt32LE(4 * 1024 * 1024 + 1, central + 24);
  await rejects(oversized, "limit_exceeded");
  await rejects(await zip([["manifest.json", " ".repeat(4 * 1024 * 1024 + 1)]]), "limit_exceeded");
});

test("encoder fails closed for changed bytes, extra descriptors and oversized logical attachments", async () => {
  const input = fixture();
  input.artifacts[0].bytes = Buffer.from("changed");
  await assert.rejects(encodeConversationArchive(input), ConversationArchiveError);
  const large = fixture();
  large.artifacts[0].descriptor.size_bytes = 16 * 1024 * 1024 + 1;
  await assert.rejects(encodeConversationArchive(large), ConversationArchiveError);
});

test("repeated file content shares one blob while retaining each artifact identity", async () => {
  const input = fixture();
  const original = input.artifacts[0];
  const descriptor = {
    ...original.descriptor,
    artifact_id: "share-artifact-2",
    logical_artifact_key: "share-artifact-key-2",
    ref: "zcode-artifact://share/share-artifact-2",
    display_name: "second.txt",
  };
  input.artifacts.push({ descriptor, bytes: original.bytes });
  input.rows.push({
    ...input.rows[2],
    rowId: 4,
    artifactVersionId: descriptor.artifact_id,
    logicalArtifactKey: descriptor.logical_artifact_key,
    ref: descriptor.ref,
    displayName: descriptor.display_name,
  });
  const encoded = await encodeConversationArchive(input);
  const result = await decodeConversationArchive(encoded);
  assert.equal(result.artifacts.size, 2);
  assert.deepEqual(result.artifacts.get(descriptor.artifact_id), original.bytes);
  // Central directory has manifest + one content blob, not one file per descriptor.
  const end = encoded.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(encoded.readUInt16LE(end + 10), 2);
});

test("input attachments and previews require closed, matching local descriptors", async () => {
  const input = fixture();
  input.rows.pop();
  const descriptor = input.artifacts[0].descriptor;
  const attachment = {
    ref: descriptor.ref,
    fileName: descriptor.display_name,
    mime: descriptor.mime_type,
    bytes: descriptor.size_bytes,
    previewRef: descriptor.ref,
  };
  input.rows[1].attachments = [attachment];
  const result = await decodeConversationArchive(await encodeConversationArchive(input));
  assert.equal(result.content.rows[1].attachments[0].ref, descriptor.ref);
  for (const mutate of [
    (value) => {
      value.rows[1].attachments[0].bytes++;
    },
    (value) => {
      value.rows[1].attachments[0].previewRef = "zcode-artifact://share/missing";
    },
    (value) => {
      value.rows[1].attachments[0].ref = "file:///PRIVATE/file";
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    await assert.rejects(encodeConversationArchive(changed), ConversationArchiveError);
  }
});

test("bounded decoding rejects deep JSON, false ZIP sizes and excess entries", async () => {
  const deep = '{"x":'.repeat(66) + "null" + "}".repeat(66);
  await rejects(await zip([["manifest.json", deep]]), "limit_exceeded");
  await rejects(
    await zip(Array.from({ length: 130 }, (_, i) => [`unused-${i}`, ""])),
    "limit_exceeded",
  );
  const forged = await rawArchive(fixture(false));
  const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(1, central + 24);
  await rejects(forged);
  await rejects(Buffer.alloc(72 * 1024 * 1024 + 1), "limit_exceeded");
  const input = fixture();
  input.title = "x".repeat(513);
  await assert.rejects(encodeConversationArchive(input), ConversationArchiveError);
});

test("file operations snapshot mutable inputs before asynchronous compression and decoding", async () => {
  const input = fixture();
  const expected = Buffer.from(input.artifacts[0].bytes);
  const writing = encodeConversationArchive(input);
  input.artifacts[0].bytes.fill(0);
  input.rows[1].text = "PRIVATE late mutation";
  const encoded = await writing;
  const reading = decodeConversationArchive(encoded);
  encoded.fill(0);
  const result = await reading;
  assert.deepEqual(result.artifacts.get(input.artifacts[0].descriptor.artifact_id), expected);
  assert.equal(result.content.rows[1].text, "Selected text 中文");
});

test("unsupported versions and logical size limits have actionable, content-free errors", async () => {
  const input = fixture(false);
  const content = manifest(input);
  // 归档 v2 已支持内容块；未来版本才是「请升级」。
  content.version = 3;
  await rejects(await zip([["manifest.json", manifestBytes(content)]]), "unsupported_version");
  const missingBlocks = { ...manifest(input), version: 2 };
  await rejects(await zip([["manifest.json", manifestBytes(missingBlocks)]]), "invalid_archive");
  const large = fixture();
  const original = large.artifacts[0];
  for (let i = 0; i < 5; i++) {
    const descriptor = {
      ...original.descriptor,
      artifact_id: `share-artifact-${i + 1}`,
      logical_artifact_key: `share-artifact-key-${i + 1}`,
      ref: `zcode-artifact://share/share-artifact-${i + 1}`,
      size_bytes: 16 * 1024 * 1024,
    };
    large.artifacts[i] = { descriptor, bytes: original.bytes };
    large.rows[i + 2] = {
      ...large.rows[2],
      rowId: i + 3,
      artifactVersionId: descriptor.artifact_id,
      logicalArtifactKey: descriptor.logical_artifact_key,
      ref: descriptor.ref,
      sizeBytes: descriptor.size_bytes,
    };
  }
  await assert.rejects(
    encodeConversationArchive(large),
    (error) => error instanceof ConversationArchiveError && error.code === "limit_exceeded",
  );
});
