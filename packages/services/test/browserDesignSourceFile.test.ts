import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileService } from "../src/file/fileService.js";

// 真实 Host 文件服务：项目 root、路径、旧版本 CAS 和串行写都由 designSourceFile 负责。
// 这里用临时项目目录，不读写用户 workspace。

const tempRoots: string[] = [];

async function createTempProject(): Promise<{
  base: string;
  root: string;
  /** 可变的批准根集合：模拟 Host 项目事实变化（移除项目/改 root 后下一次调用立即失效）。 */
  approvedRoots: string[];
  fileService: ReturnType<typeof createFileService>;
}> {
  const base = await mkdtemp(join(tmpdir(), "zcode-design-source-"));
  tempRoots.push(base);
  const root = join(base, "project");
  await mkdir(root, { recursive: true });
  // B7：设计读写先由服务端批准根授权；真实 authority 来自 project readTree，见 designSourceAuthority.test.ts。
  const approvedRoots = [root];
  const fileService = createFileService({
    designSourceAuthority: { resolveApprovedRoots: async () => approvedRoots },
  });
  return { base, root, approvedRoots, fileService };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("browser design source file port", () => {
  it("reads and CAS-writes only the requested bytes", async () => {
    const { root, fileService } = await createTempProject();
    const path = join(root, "index.html");
    const original =
      '<!doctype html>\n<html><body><h1 id="title" style="color: #111">Hi</h1></body></html>\n';
    await writeFile(path, original, "utf-8");

    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).resolves.toEqual({
      content: original,
    });
    const next = original.replace("color: #111", "color: #222");
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: original,
        content: next,
      }),
    ).resolves.toEqual({ written: true });
    await expect(readFile(path, "utf-8")).resolves.toBe(next);
  });

  it("rejects a target outside the project root without writing", async () => {
    const { root, fileService } = await createTempProject();
    const outside = join(root, "..", "outside.html");
    await writeFile(outside, "<html></html>", "utf-8");

    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: outside,
        expectedContent: "<html></html>",
        content: "<html><body>x</body></html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(readFile(outside, "utf-8")).resolves.toBe("<html></html>");
  });

  it("rejects a symlink that resolves outside the project root", async () => {
    const { root, fileService } = await createTempProject();
    const outside = join(root, "..", "linked.html");
    const link = join(root, "link.html");
    await writeFile(outside, "<html>outside</html>", "utf-8");
    await symlink(outside, link);

    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: link,
        expectedContent: "<html>outside</html>",
        content: "<html>changed</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(readFile(outside, "utf-8")).resolves.toBe("<html>outside</html>");
  });

  it("rejects non-HTML and stale CAS", async () => {
    const { root, fileService } = await createTempProject();
    const textPath = join(root, "notes.txt");
    await writeFile(textPath, "hello", "utf-8");
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: textPath,
        expectedContent: "hello",
        content: "bye",
      }),
    ).resolves.toEqual({ written: false, reason: "not_html" });

    const htmlPath = join(root, "page.html");
    await writeFile(htmlPath, "<html>one</html>", "utf-8");
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: htmlPath,
        expectedContent: "<html>old</html>",
        content: "<html>new</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "changed" });
    await expect(readFile(htmlPath, "utf-8")).resolves.toBe("<html>one</html>");
  });

  it("serializes concurrent same-baseline writes: one wins, one reports changed", async () => {
    const { root, fileService } = await createTempProject();
    const path = join(root, "race.html");
    await writeFile(path, "<html>base</html>", "utf-8");
    const results = await Promise.all([
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: "<html>base</html>",
        content: "<html>first</html>",
      }),
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: "<html>base</html>",
        content: "<html>second</html>",
      }),
    ]);
    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect(results.some((result) => result.reason === "changed")).toBe(true);
  });

  it("rejects invalid UTF-8 instead of lossy rewriting", async () => {
    const { root, fileService } = await createTempProject();
    const path = join(root, "gbk.html");
    await writeFile(
      path,
      Buffer.from([
        0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0xc4, 0xe3, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e,
      ]),
    );
    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).rejects.toThrow(
      "design_source_invalid_utf8",
    );
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: "x",
        content: "<html>changed</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_utf8" });
  });

  it("rejects a hardlink that aliases a file outside the project", async () => {
    const { root, fileService } = await createTempProject();
    const outside = join(root, "..", "outside-hardlink.html");
    const html = "<html>outside</html>";
    await writeFile(outside, html, "utf-8");
    const alias = join(root, "alias.html");
    // nlink=2：项目内的名字和项目外的名字指向同一 inode，原地写会同时改到项目外文件。
    await link(outside, alias);

    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: alias,
        expectedContent: html,
        content: "<html>changed</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(fileService.readDesignSourceFile({ rootPath: root, path: alias })).rejects.toThrow(
      "design_source_invalid_path",
    );
    await expect(readFile(outside, "utf-8")).resolves.toBe(html);
  });

  it("refuses to write when the previewed path was swapped to an outside symlink", async () => {
    const { root, fileService } = await createTempProject();
    const inside = join(root, "page.html");
    const outside = join(root, "..", "outside-target.html");
    const html = "<html>base</html>";
    await writeFile(inside, html, "utf-8");
    await writeFile(outside, html, "utf-8");
    // 宿主预览读的是项目内文件。
    await expect(
      fileService.readDesignSourceFile({ rootPath: root, path: inside }),
    ).resolves.toEqual({ content: html });

    // 预览之后把路径换成指向项目外的软链接。
    await rm(inside);
    await symlink(outside, inside);

    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: inside,
        expectedContent: html,
        content: "<html>preview</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(readFile(outside, "utf-8")).resolves.toBe(html);
  });

  it("rejects an ancestor directory swapped for an outside symlink", async () => {
    const { root, fileService } = await createTempProject();
    const pages = join(root, "pages");
    const inside = join(pages, "index.html");
    const outsideDir = join(root, "..", "outside-pages");
    const outsideFile = join(outsideDir, "index.html");
    const html = "<html>base</html>";
    await mkdir(pages, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(inside, html, "utf-8");
    await writeFile(outsideFile, html, "utf-8");
    await expect(
      fileService.readDesignSourceFile({ rootPath: root, path: inside }),
    ).resolves.toEqual({ content: html });

    // 祖先目录整体换成指向项目外的软链接：realpath 会把目标解析到 root 之外。
    await rename(pages, join(root, "pages-old"));
    await symlink(outsideDir, pages);

    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: inside,
        expectedContent: html,
        content: "<html>preview</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(readFile(outsideFile, "utf-8")).resolves.toBe(html);
  });

  it("reports real IO failures explicitly instead of claiming a write", async () => {
    if (process.getuid?.() === 0) return; // root 不受文件权限限制，跳过
    const { root, fileService } = await createTempProject();
    const path = join(root, "readonly.html");
    const html = "<html>base</html>";
    await writeFile(path, html, "utf-8");
    await chmod(path, 0o400);
    try {
      await expect(
        fileService.writeDesignSourceFile({
          rootPath: root,
          path,
          expectedContent: html,
          content: "<html>preview</html>",
        }),
      ).resolves.toEqual({ written: false, reason: "io_failed" });
      await expect(readFile(path, "utf-8")).resolves.toBe(html);
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("rejects an invalid user target (missing file, html-named directory)", async () => {
    const { root, fileService } = await createTempProject();
    const dirAsHtml = join(root, "folder.html");
    await mkdir(dirAsHtml, { recursive: true });

    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: join(root, "missing.html"),
        expectedContent: "x",
        content: "y",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: dirAsHtml,
        expectedContent: "x",
        content: "y",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path: "relative.html",
        expectedContent: "x",
        content: "y",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
  });
});

describe("host-approved design root authority (B7)", () => {
  it("denies design reads and writes when the Host assembled no authority", async () => {
    const { root } = await createTempProject();
    const path = join(root, "index.html");
    const html = "<html>base</html>";
    await writeFile(path, html, "utf-8");
    const fileService = createFileService();

    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).rejects.toThrow(
      "design_source_unauthorized_root",
    );
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: html,
        content: "<html>pwned</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "unauthorized_root" });
    await expect(readFile(path, "utf-8")).resolves.toBe(html);
  });

  it("rejects '/', '/tmp' and a symlink alias as the root even for a real project file", async () => {
    const { base, root, fileService } = await createTempProject();
    const path = join(root, "index.html");
    const html = "<html>base</html>";
    await writeFile(path, html, "utf-8");

    for (const rootPath of ["/", "/tmp"]) {
      await expect(fileService.readDesignSourceFile({ rootPath, path })).rejects.toThrow(
        "design_source_unauthorized_root",
      );
      await expect(
        fileService.writeDesignSourceFile({
          rootPath,
          path,
          expectedContent: html,
          content: "<html>pwned</html>",
        }),
      ).resolves.toEqual({ written: false, reason: "unauthorized_root" });
    }

    // 指向已批准 root 的软链接是新路径，不是 authority 的批准 root，不能自我授权。
    const alias = join(base, "alias");
    await symlink(root, alias, "dir");
    await expect(fileService.readDesignSourceFile({ rootPath: alias, path })).rejects.toThrow(
      "design_source_unauthorized_root",
    );
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: alias,
        path,
        expectedContent: html,
        content: "<html>pwned</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "unauthorized_root" });
    await expect(readFile(path, "utf-8")).resolves.toBe(html);
  });

  it("re-reads approval on every call: a removed root is denied until restored", async () => {
    const { root, approvedRoots, fileService } = await createTempProject();
    const path = join(root, "index.html");
    const html = "<html>base</html>";
    await writeFile(path, html, "utf-8");

    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).resolves.toEqual({
      content: html,
    });
    // 项目移除/root 改动后，旧批准立即失效；这里没有授权缓存可命中。
    approvedRoots.splice(0);
    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).rejects.toThrow(
      "design_source_unauthorized_root",
    );
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: html,
        content: "<html>pwned</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "unauthorized_root" });
    await expect(readFile(path, "utf-8")).resolves.toBe(html);

    approvedRoots.push(root);
    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).resolves.toEqual({
      content: html,
    });
  });

  it("fails closed when the authority cannot produce facts", async () => {
    const { root } = await createTempProject();
    const path = join(root, "index.html");
    const html = "<html>base</html>";
    await writeFile(path, html, "utf-8");
    const fileService = createFileService({
      designSourceAuthority: {
        resolveApprovedRoots: async () => {
          throw new Error("projects-unavailable");
        },
      },
    });

    await expect(fileService.readDesignSourceFile({ rootPath: root, path })).rejects.toThrow(
      "design_source_unauthorized_root",
    );
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: root,
        path,
        expectedContent: html,
        content: "<html>pwned</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "unauthorized_root" });
    await expect(readFile(path, "utf-8")).resolves.toBe(html);
  });
});
