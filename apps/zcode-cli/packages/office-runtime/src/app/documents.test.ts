import { expect, it } from "vitest";
import { createDocumentOwner } from "#office/app/documents.ts";
import type { LoadedFile } from "#office/adapters/files.ts";
import type { ParsedDocument } from "#office/domain/model.ts";

const bytes = new TextEncoder().encode("%PDF-1.4 test");
const doc = (): ParsedDocument => ({
  kind: "pdf",
  title: "test",
  units: 1,
  outline: [{ at: "page:1", label: "1", level: 1 }],
  read: () => ({ text: "text", next: null }),
  search: () => [],
  check: (locator) => locator,
});

function files(version = 1) {
  let current = version;
  const loaded = (): LoadedFile => ({
    path: "a.pdf",
    kind: "pdf",
    bytes,
    revision: `r${current}`,
    mtimeMs: current,
  });
  return {
    resolve: async (input: string) => ({
      path: input,
      absolute: `/w/${input}`,
      kind: "pdf" as const,
    }),
    load: async () => loaded(),
    fingerprint: async () => `fingerprint-${current}`,
    list: async () => [],
    // 模拟磁盘上文件大小/修改时间变化，触发同一个 owner 的缓存失效。
    touch: () => {
      current++;
    },
  };
}

it("caches a parsed document by path and size+mtime fingerprint", async () => {
  let parsed = 0;
  const source = files(1);
  const owner = createDocumentOwner({
    files: source,
    parse: async () => {
      parsed++;
      return doc();
    },
  });
  expect((await owner.info("a.pdf")).revision).toBe("r1");
  await owner.info("a.pdf");
  expect(parsed).toBe(1);
  // 同一路径指纹变化后才重新解析，旧条目随之淘汰。
  source.touch();
  expect((await owner.info("a.pdf")).revision).toBe("r2");
  expect(parsed).toBe(2);
});

it("hands out at most four file handles and expires the oldest token", async () => {
  const owner = createDocumentOwner({ files: files(), parse: async () => doc() });
  const tokens: string[] = [];
  for (let i = 0; i < 5; i++) tokens.push((await owner.load("a.pdf")).file.token);
  expect(() => owner.chunk(tokens[0], 0)).toThrow(/expired/u);
  expect(Buffer.from(owner.chunk(tokens[4], 0), "base64")).toEqual(Buffer.from(bytes));
  // 越界分片（含非整数、负数与超出块数）一律拒绝。
  for (const index of [-1, 1, 1.5]) expect(() => owner.chunk(tokens[4], index)).toThrow();
});

it("describes a loaded file and reports its chunk count", async () => {
  const owner = createDocumentOwner({ files: files(), parse: async () => doc() });
  const loaded = await owner.load("a.pdf");
  expect(loaded.info).toMatchObject({ path: "a.pdf", kind: "pdf", revision: "r1", units: 1 });
  expect(loaded.file).toMatchObject({ bytes: bytes.byteLength, chunks: 1 });
});
