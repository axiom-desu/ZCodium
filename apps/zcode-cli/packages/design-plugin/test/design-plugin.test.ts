import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CONFIG, MAX_BYTES, buildCatalog } from "../skills/design/scripts/build-catalog.mjs";
import { lintDesign } from "../skills/design/scripts/design-lint.mjs";
import { parseDesignSystem } from "../skills/design/scripts/design-tokens.mjs";
import { parseTailwindTheme } from "../skills/design/scripts/import-design-system.mjs";

// 内置 design 插件是纯内容资产（技能 + design-resources + SessionStart hook，无 MCP / 无原生依赖）。
// 上游 3.18.2 用 vitest 测这些内容；本仓 apps/zcode-cli 统一 node:test，断言语义保持一致。
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = join(pluginRoot, "skills", "design");
const resourceRoot = join(skillRoot, "design-resources");

const read = (relative: string): string =>
  readFileSync(join(skillRoot, ...relative.split("/")), "utf8");

const listMarkdown = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name: string) => join(dir, name));

const ruleFiles = (): string[] => [
  join(skillRoot, "SKILL.md"),
  ...listMarkdown(join(skillRoot, "references")),
];

describe("design 插件内容与加载", () => {
  it("manifest 与 package 版本一致，只声明技能，不声明 MCP、不需要配置", () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, ".zcodium-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      version: string;
      name: string;
    };

    assert.equal(manifest.name, "design");
    assert.equal(manifest.version, pkg.version);
    assert.equal(pkg.name, "@zcode/design-plugin");
    assert.equal(manifest.skills, "./skills");
    for (const forbidden of [
      "agents",
      "hooks",
      "commands",
      "identity",
      "instructions",
      "mcpServers",
      "userConfig",
    ]) {
      assert.equal(Object.hasOwn(manifest, forbidden), false, forbidden);
    }
    assert.equal(existsSync(join(pluginRoot, "mcp")), false);
    assert.equal(existsSync(join(pluginRoot, ".mcp.json")), false);
  });

  it("技能发现只扫 skills/ 下一层：只有入口技能 design，design-resources 里的嵌套技能不会被单独注册", () => {
    const entries = readdirSync(join(pluginRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.deepEqual(entries, ["design"]);
    assert.equal(existsSync(join(pluginRoot, "skills", "design", "SKILL.md")), true);
  });

  it("随包子技能与许可原文齐全", () => {
    const skills = join(resourceRoot, "skills");
    for (const kept of [
      "design-review",
      "plan-design-review",
      "design-consultation",
      "brand-guidelines",
    ]) {
      assert.equal(existsSync(join(skills, kept, "SKILL.md")), true, kept);
    }
    // 带独立许可的子技能随目录带上游许可原文；主体许可是 Open Design 的 Apache-2.0。
    assert.match(readFileSync(join(skills, "frontend-design", "LICENSE.txt"), "utf8"), /Apache License/u);
    assert.match(
      readFileSync(join(skills, "taste-skill", "LICENSE"), "utf8"),
      /Copyright \(c\) 2026 Leonxlnx/u,
    );
    assert.match(readFileSync(join(resourceRoot, "LICENSE.md"), "utf8"), /Copyright 2026 Open Design/u);
    assert.match(
      readFileSync(join(resourceRoot, "NOTICE.md"), "utf8"),
      /https:\/\/github\.com\/nexu-io\/open-design/u,
    );
    // HTML 演示稿模板系列与品牌声明各自带许可/免责声明。
    assert.equal(existsSync(join(resourceRoot, "LICENSE-html-ppt")), true);
    assert.equal(existsSync(join(resourceRoot, "design-systems", "BRAND-DISCLAIMER.md")), true);
  });

  it("入口技能 frontmatter 声明 design，描述在宿主 1024 字符上限内", () => {
    const entry = read("SKILL.md");
    assert.match(entry, /^---\nname: design\n/u);
    const description = entry.match(/^description: "([^"]+)"/mu)?.[1] ?? "";
    assert.match(description, /visualize/u);
    assert.match(description, /presentations/u);
    assert.ok([...description].length <= 1024);
  });

  it("规则层文件不超体量上限，长文件带目录，都不超过 500 行", () => {
    const limits: Record<string, number> = {
      "SKILL.md": 4,
      "references/design-system.md": 5,
      "references/create.md": 9,
      "references/redesign.md": 5,
      "references/output.md": 9,
      "references/check.md": 8,
      "references/interact.md": 3,
      "references/catalog.md": 8,
    };
    const actual = ruleFiles().map((file) => file.slice(skillRoot.length + 1));
    assert.deepEqual(actual.sort(), Object.keys(limits).sort());

    let total = 0;
    for (const [file, kb] of Object.entries(limits)) {
      const text = read(file);
      const bytes = Buffer.byteLength(text, "utf8");
      total += bytes;
      assert.ok(bytes <= kb * 1024, `${file}: ${bytes}B`);
      const lines = text.split("\n").length;
      assert.ok(lines <= 500, `${file}: ${lines} lines`);
      if (lines > 100) assert.match(text.split("\n").slice(0, 12).join("\n"), /Contents|目录/u);
    }
    assert.ok(total <= 54 * 1024, `${total}B`);
  });

  it("相对链接从所在文件出发都能解析到随包文件", () => {
    const broken: string[] = [];
    let checked = 0;
    for (const file of ruleFiles()) {
      for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/gu)) {
        const target = (match[1] as string).split("#")[0] as string;
        // 「原型/…」是交付示例里的工作区产物路径，不是随包文件。
        if (target === "" || target.startsWith("原型/") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
          continue;
        }
        checked += 1;
        if (!existsSync(join(dirname(file), ...target.split("/")))) {
          broken.push(`${file.slice(skillRoot.length)} -> ${target}`);
        }
      }
    }
    assert.ok(checked > 15, `checked ${checked}`);
    assert.deepEqual(broken, []);
  });

  it("不残留宿主专有写法，也不点名只有某一个宿主才有的工具", () => {
    const banned =
      /skill:\/\/|deliver_file|zwork|memory_change|browser_tool|process\.exec|ask_user_question|tool_search|image_recognition|update_run_checklist|propose_work_plan|artifactCard|generate_image|search_image|control-browser|zcode-file-citation|在 Browser 中|AskUserQuestion|TodoWrite|ToolSearch/iu;
    const hits = ruleFiles().filter((file) => banned.test(readFileSync(file, "utf8")));
    assert.deepEqual(hits, []);
  });

  it("adapt-canvas.mjs 校验模板哈希并写出适配副本，已存在的输出不覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-design-canvas-"));
    try {
      const out = join(dir, "canvas.html");
      const script = join(skillRoot, "scripts", "adapt-canvas.mjs");
      execFileSync(process.execPath, [script, out], { encoding: "utf8" });
      const adapted = readFileSync(out, "utf8");
      const template = read(
        "design-resources/skills/infinite-canvas/assets/infinite-canvas-template.html",
      );
      assert.notEqual(adapted, template);
      assert.match(adapted, /prefers-reduced-motion/u);
      assert.throws(() => execFileSync(process.execPath, [script, out], { stdio: "pipe" }));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  describe("SessionStart 注入设计工作流", () => {
    const hooksDir = join(pluginRoot, "hooks");
    const runHook = (env: Record<string, string>) =>
      spawnSync("sh", [join(hooksDir, "run-hook.cmd"), "design-rules"], {
        encoding: "utf8",
        timeout: 20_000,
        env: { PATH: "/usr/bin:/bin", ...env },
      });

    it("hooks.json 先用 sh 调启动器、失败再直接调（市场安装不恢复可执行位），且出错放行", () => {
      const hooks = JSON.parse(readFileSync(join(hooksDir, "hooks.json"), "utf8")) as {
        hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> };
      };
      const entry = hooks.hooks.SessionStart[0]?.hooks[0];
      assert.ok(entry);
      assert.equal(
        entry.command,
        'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" design-rules || "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" design-rules',
      );
      assert.equal(entry.onError, "allow");
      assert.doesNotMatch(String(entry.command), /\bnode\b/u);
    });

    it("在没有 Node 的 PATH 下输出合法的 additionalContext：只是指针，并写明 base directory", () => {
      const run = runHook({ ZCODE_PLUGIN_ROOT: pluginRoot.replace(/\/$/u, "") });
      assert.equal(run.status, 0);
      const out = JSON.parse(run.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
      const context = out.hookSpecificOutput.additionalContext;
      assert.ok(context.includes(`relative to: ${skillRoot.replace(/\/$/u, "")}`));
      assert.ok(context.includes("load the `design` skill first"));
      for (const deliverable of ["HTML design", "prototype", "HTML deck", "redesign"]) {
        assert.ok(context.includes(deliverable), deliverable);
      }
      // 内置后默认关闭但可显式启用，一旦启用每个会话都会带上它：只放一句指针 + 路径基准。
      assert.equal(context.includes("# 设计专家 · 工作流入口"), false);
      assert.ok(
        Buffer.byteLength(context.replace(skillRoot.replace(/\/$/u, ""), ""), "utf8") <= 160,
      );
    });

    it("宿主只提供 CLAUDE_PLUGIN_ROOT 时也能定位插件目录", () => {
      const run = runHook({ CLAUDE_PLUGIN_ROOT: pluginRoot.replace(/\/$/u, "") });
      assert.equal(run.status, 0);
      const out = JSON.parse(run.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      assert.ok(
        out.hookSpecificOutput.additionalContext.includes(
          `relative to: ${skillRoot.replace(/\/$/u, "")}`,
        ),
      );
    });

    it("Windows（Git Bash 有 cygpath）时把路径转成 C:/ 形式", () => {
      const bin = mkdtempSync(join(tmpdir(), "design-cygpath-"));
      try {
        writeFileSync(
          join(bin, "cygpath"),
          '#!/bin/sh\n[ "$1" = "-m" ] && printf "C:/fake%s\\n" "$2" || printf "%s\\n" "$2"\n',
        );
        chmodSync(join(bin, "cygpath"), 0o755);
        const run = spawnSync("sh", [join(hooksDir, "run-hook.cmd"), "design-rules"], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            ZCODE_PLUGIN_ROOT: pluginRoot.replace(/\/$/u, ""),
          },
        });
        assert.equal(run.status, 0);
        const out = JSON.parse(run.stdout) as {
          hookSpecificOutput: { additionalContext: string };
        };
        assert.ok(
          out.hookSpecificOutput.additionalContext.includes(
            `relative to: C:/fake${skillRoot.replace(/\/$/u, "")}`,
          ),
        );
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it("入口缺失或路径错误时静默退出 0，不阻塞会话", () => {
      const run = runHook({ ZCODE_PLUGIN_ROOT: join(pluginRoot, "does-not-exist") });
      assert.equal(run.status, 0);
      assert.equal(run.stdout, "");
    });
  });
});

describe("design 随包脚本", () => {
  it("catalog.md 与 design-resources 的新鲜度一致，且在体量上限内", () => {
    const committed = readFileSync(join(skillRoot, "references", "catalog.md"), "utf8");
    assert.equal(buildCatalog(resourceRoot), committed);
    assert.ok(Buffer.byteLength(committed, "utf8") <= MAX_BYTES);
  });

  it("catalog 点名的资源都真实存在；不提供的是刻意排除（需要宿主没有的运行时）", () => {
    const committed = readFileSync(join(skillRoot, "references", "catalog.md"), "utf8");
    const section = (title: string): string => {
      const begin = committed.indexOf(`\n## ${title}\n`);
      assert.ok(begin >= 0, title);
      const stop = committed.indexOf("\n## ", begin + 1);
      return committed.slice(begin + 1, stop < 0 ? undefined : stop);
    };
    // 默认项必须能直接用。
    for (const name of Object.values(CONFIG.defaults as Record<string, string>)) {
      assert.ok(existsSync(join(resourceRoot, "design-skeletons", name)), name);
    }
    // 设计系统与 skills 每一行点名的资源都要有目录，否则模型会读到不存在的路径。
    // Design systems 按分组写在多行、多个反引号里；Skills 一行一个。
    for (const [title, dir] of [
      ["Design systems", "design-systems"],
      ["Skills", "skills"],
    ] as const) {
      const names = [...section(title).matchAll(/`([a-z][a-z0-9-]*)`/gu)].map(
        (match) => match[1] as string,
      );
      assert.ok(names.length > 0, title);
      for (const name of names) {
        if (name === "name") continue; // 路径模板 `design-resources/<dir>/<name>`
        assert.ok(existsSync(join(resourceRoot, dir, name)), `${title}: ${name}`);
      }
    }
    // skeleton 允许 zhangzara 系列按 `html-ppt-zhangzara-<x>` 缩写列名。
    const skeletons = [...section("Skeletons").matchAll(/^- `([^`]+)`/gmu)].map(
      (match) => match[1] as string,
    );
    assert.ok(skeletons.length > 10);
    for (const name of skeletons) {
      const resolved = existsSync(join(resourceRoot, "design-skeletons", name))
        ? name
        : `html-ppt-zhangzara-${name}`;
      assert.ok(existsSync(join(resourceRoot, "design-skeletons", resolved)), resolved);
    }
    // 需要 Open Design daemon / 媒体运行时的 skeleton 按设计不列，避免给出走不通的流程。
    for (const name of CONFIG.excludeSkeletons as string[]) {
      assert.equal(committed.includes(`\`${name}\``), false, name);
    }
  });

  it("design-lint 判设计稿偏离设计系统，干净稿不报", () => {
    const fixtures = join(pluginRoot, "test", "fixtures", "lint");
    const system = parseDesignSystem(readFileSync(join(fixtures, "system.md"), "utf8"), "system.md");

    const clean = lintDesign(readFileSync(join(fixtures, "clean.html"), "utf8"), system) as {
      violations?: unknown[];
    };
    assert.deepEqual(clean.violations ?? [], []);

    const violations = lintDesign(
      readFileSync(join(fixtures, "violations.html"), "utf8"),
      system,
    ) as { violations: Array<{ kind?: string }> };
    assert.ok(violations.violations.length > 0);
  });

  it("import-design-system 的 Tailwind 解析产物能被 design-lint 读取", () => {
    const fixtures = join(pluginRoot, "test", "fixtures", "frontend");
    const theme = parseTailwindTheme(
      readFileSync(join(fixtures, "tailwind.config.js"), "utf8"),
    ) as Record<string, unknown>;
    assert.ok(Object.keys(theme).length > 0);
  });
});
