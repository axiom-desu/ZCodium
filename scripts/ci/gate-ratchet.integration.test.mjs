// gate-ratchet 的端到端测试：每个用例在独立临时目录里生成假工具，再以真实子进程跑 CLI。
// 不 chdir、不共享 env、不读写仓库基线：CI 用 --test-isolation=none，同进程内不能依赖用例顺序。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENGINE = path.join(REPO_ROOT, "scripts", "ci", "gate-ratchet.mjs");
const BASELINE_DIR = ".gate-baseline";
const TOOL = {
  knip: { pkg: "knip", bin: "knip.js" },
  lint: { pkg: "oxlint", bin: "oxlint" },
  format: { pkg: "oxfmt", bin: "oxfmt" },
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "gate-ratchet-it-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "package.json"),
    '{"name":"fixture","private":true,"type":"module"}\n',
  );
  return dir;
}

// 假工具保留 dist/ 层：resolveToolBin 从包入口回推 ../bin/<bin>，写成包根会解析到 node_modules/bin。
async function installFakeTool(dir, gate, behaviour) {
  const { pkg, bin } = TOOL[gate];
  const pkgDir = path.join(dir, "node_modules", pkg);
  await mkdir(path.join(pkgDir, "dist"), { recursive: true });
  await mkdir(path.join(pkgDir, "bin"), { recursive: true });
  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkg,
      version: "0.0.0",
      type: "module",
      main: "dist/index.js",
      bin: { [bin]: `bin/${bin}` },
    }),
  );
  await writeFile(path.join(pkgDir, "dist", "index.js"), "export {};\n");
  const body = behaviour.specFile
    ? [
        'import { readFileSync } from "node:fs";',
        `const spec = JSON.parse(readFileSync(${JSON.stringify(behaviour.specFile)}, "utf8"));`,
        'process.stdout.write(spec.stdout ?? "");',
        'process.stderr.write(spec.stderr ?? "");',
        "if (spec.signal) process.kill(process.pid, spec.signal);",
        "process.exitCode = spec.exit ?? 0;",
        "",
      ].join("\n")
    : [
        `process.stdout.write(${JSON.stringify(behaviour.stdout ?? "")});`,
        `process.stderr.write(${JSON.stringify(behaviour.stderr ?? "")});`,
        behaviour.signal
          ? `process.kill(process.pid, ${JSON.stringify(behaviour.signal)});`
          : `process.exitCode = ${behaviour.exit ?? 0};`,
        "",
      ].join("\n");
  await writeFile(path.join(pkgDir, "bin", bin), body);
  return pkgDir;
}

function runGate(cwd, args, env = process.env, engine = ENGINE) {
  const result = spawnSync(process.execPath, [engine, ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.error, undefined, `无法启动 gate: ${result.error?.message}`);
  return result;
}

async function readBaselineFile(dir, gate) {
  try {
    return await readFile(path.join(dir, BASELINE_DIR, `${gate}.json`), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function baselineEntries(text) {
  return JSON.parse(text).entries;
}

const lintReport = (diagnostics, numberOfFiles = 1) =>
  JSON.stringify({ diagnostics, number_of_files: numberOfFiles });
const knipReport = (issues) => JSON.stringify({ issues });
const diagnostic = (severity, code, filename) => ({ severity, code, filename });

test("工具退出码或信号异常时 gate 以 2 失败且不写基线", async (t) => {
  const dir = await fixture(t);
  await installFakeTool(dir, "format", { stdout: "", stderr: "fake oxfmt exploded", exit: 3 });
  const failed = runGate(dir, ["format", "check"]);
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /oxfmt/);
  assert.match(failed.stderr, /3/);
  assert.equal(await readBaselineFile(dir, "format"), null);
  const failedUpdate = runGate(dir, ["format", "baseline:update"]);
  assert.equal(failedUpdate.status, 2, failedUpdate.stdout + failedUpdate.stderr);
  assert.equal(await readBaselineFile(dir, "format"), null);

  await installFakeTool(dir, "format", { signal: "SIGKILL" });
  const signaled = runGate(dir, ["format", "check"]);
  assert.equal(signaled.status, 2, signaled.stdout + signaled.stderr);
  assert.match(signaled.stderr, /oxfmt/);
  assert.match(signaled.stderr, /SIGKILL/);
});

test("lint 扫描 0 文件或缺少 number_of_files 时拒绝判定为干净", async (t) => {
  const dir = await fixture(t);
  const specFile = path.join(dir, "lint-spec.json");
  await installFakeTool(dir, "lint", { specFile });
  const run = async (stdout, exit = 1) => {
    await writeFile(specFile, JSON.stringify({ stdout, exit }));
    return runGate(dir, ["lint", "check"]);
  };

  const noFiles = `${lintReport([], 0)}\n`;
  const zero = await run(
    `No files found to lint. Please check your paths and ignore patterns.\n${noFiles}`,
  );
  assert.equal(zero.status, 2, zero.stdout + zero.stderr);
  assert.match(zero.stderr, /number_of_files/);

  const missing = await run('{"diagnostics":[]}');
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /number_of_files/);

  const fractional = await run(lintReport([], 1.5));
  assert.equal(fractional.status, 2, fractional.stdout + fractional.stderr);
});

test("输出无法理解时三个 gate 都 exit 2，而不是当成空集合放行", async (t) => {
  const dir = await fixture(t);
  const cases = [
    ["knip", "", 0],
    ["knip", "not json", 0],
    ["knip", '{"issues":{}}', 0],
    ["lint", "", 0],
    ["lint", "not json", 0],
    ["lint", '{"number_of_files":1}', 0],
    ["format", "", 1],
  ];
  for (const [gate, stdout, exit] of cases) {
    await installFakeTool(dir, gate, { stdout, exit });
    const result = runGate(dir, [gate, "check"]);
    assert.equal(result.status, 2, `${gate} ${JSON.stringify(stdout)} -> ${result.status}`);
    assert.notEqual(result.stdout.trim(), `${gate}: OK`, `${gate} 不应输出 OK`);
  }
});

test("基线生命周期：缺失回归 -> 更新 -> 新增/上升 -> 改进 -> 清零 -> 允许收紧到 0", async (t) => {
  const dir = await fixture(t);
  const specFile = path.join(dir, "lint-spec.json");
  await installFakeTool(dir, "lint", { specFile });
  const setReport = (diagnostics) =>
    writeFile(
      specFile,
      JSON.stringify({
        stdout: lintReport(diagnostics, 1),
        exit: diagnostics.length > 0 ? 1 : 0,
      }),
    );
  const one = [diagnostic("error", "eslint(max-lines)", "src/a.ts")];

  await setReport(one);
  const missing = runGate(dir, ["lint", "check"]);
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /^\+ 1 error eslint\(max-lines\) src\/a\.ts$/m);
  assert.equal(await readBaselineFile(dir, "lint"), null);

  const created = runGate(dir, ["lint", "baseline:update"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.equal(baselineEntries(await readBaselineFile(dir, "lint")).length, 1);

  const clean = runGate(dir, ["lint", "check"]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^lint: OK$/m);

  await setReport([one[0], one[0]]);
  const increased = runGate(dir, ["lint", "check"]);
  assert.equal(increased.status, 1, increased.stdout + increased.stderr);
  assert.match(increased.stdout, /^\+ 1 error eslint\(max-lines\) src\/a\.ts$/m);

  const raised = runGate(dir, ["lint", "baseline:update"]);
  assert.equal(raised.status, 0, raised.stdout + raised.stderr);
  assert.equal(baselineEntries(await readBaselineFile(dir, "lint"))[0].count, 2);

  await setReport(one);
  const improved = runGate(dir, ["lint", "check"]);
  assert.equal(improved.status, 0, improved.stdout + improved.stderr);
  assert.match(improved.stdout, /已消除 1 条，可运行 pnpm gate:baseline 收紧基线。/);

  await setReport([diagnostic("warning", "eslint(no-unused-vars)", "src/b.ts")]);
  const fresh = runGate(dir, ["lint", "check"]);
  assert.equal(fresh.status, 1, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /^\+ 1 warning eslint\(no-unused-vars\) src\/b\.ts$/m);

  await setReport([]);
  const cleared = runGate(dir, ["lint", "check"]);
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  assert.match(cleared.stdout, /^entries: 0$/m);

  // 清零后的空基线是合法终态：update 必须允许写入 entries: []，随后的 check 仍是 0。
  const tightened = runGate(dir, ["lint", "baseline:update"]);
  assert.equal(tightened.status, 0, tightened.stdout + tightened.stderr);
  assert.deepEqual(baselineEntries(await readBaselineFile(dir, "lint")), []);
  const afterTighten = runGate(dir, ["lint", "check"]);
  assert.equal(afterTighten.status, 0, afterTighten.stdout + afterTighten.stderr);
});

test("损坏基线：check 与 baseline:update 都 exit 2，且 update 不覆盖原文件", async (t) => {
  const dir = await fixture(t);
  const specFile = path.join(dir, "lint-spec.json");
  await installFakeTool(dir, "lint", { specFile });
  await writeFile(
    specFile,
    JSON.stringify({
      stdout: lintReport([diagnostic("error", "eslint(max-lines)", "src/a.ts")], 1),
      exit: 1,
    }),
  );
  const baselineFile = path.join(dir, BASELINE_DIR, "lint.json");
  await mkdir(path.dirname(baselineFile), { recursive: true });

  const key = (fields, gate = "lint") => [gate, ...fields].join("\u0000");
  const goodKey = key(["error", "eslint(max-lines)", "src/a.ts"]);
  const cases = [
    ["非法 JSON", "{oops"],
    ["version 非 1", JSON.stringify({ version: 2, entries: [] })],
    ["缺 version", JSON.stringify({ entries: [] })],
    ["entries 非数组", JSON.stringify({ version: 1, entries: {} })],
    ["未知顶层字段", JSON.stringify({ version: 1, entries: [], extra: 1 })],
    [
      "key 段数错误",
      JSON.stringify({ version: 1, entries: [{ key: key(["error", "rule"]), count: 1 }] }),
    ],
    [
      "首段 gate 错误",
      JSON.stringify({
        version: 1,
        entries: [{ key: key(["error", "rule", "src/a.ts"], "format"), count: 1 }],
      }),
    ],
    [
      "未知 severity",
      JSON.stringify({
        version: 1,
        entries: [{ key: key(["hint", "rule", "src/a.ts"]), count: 1 }],
      }),
    ],
    ["key 为空", JSON.stringify({ version: 1, entries: [{ key: "", count: 1 }] })],
    ["count 为 0", JSON.stringify({ version: 1, entries: [{ key: goodKey, count: 0 }] })],
    ["count 为负", JSON.stringify({ version: 1, entries: [{ key: goodKey, count: -1 }] })],
    ["count 非整数", JSON.stringify({ version: 1, entries: [{ key: goodKey, count: 1.5 }] })],
    [
      "重复 key",
      JSON.stringify({
        version: 1,
        entries: [
          { key: goodKey, count: 1 },
          { key: goodKey, count: 1 },
        ],
      }),
    ],
    [
      "反斜杠路径",
      JSON.stringify({
        version: 1,
        entries: [{ key: key(["error", "rule", "src\\a.ts"]), count: 1 }],
      }),
    ],
    [
      "绝对路径",
      JSON.stringify({
        version: 1,
        entries: [{ key: key(["error", "rule", "/src/a.ts"]), count: 1 }],
      }),
    ],
    [
      ".. 逃逸",
      JSON.stringify({
        version: 1,
        entries: [{ key: key(["error", "rule", "../a.ts"]), count: 1 }],
      }),
    ],
    [
      "条目未知字段",
      JSON.stringify({ version: 1, entries: [{ key: goodKey, count: 1, extra: 1 }] }),
    ],
  ];

  for (const [label, text] of cases) {
    await writeFile(baselineFile, text);
    const checked = runGate(dir, ["lint", "check"]);
    assert.equal(
      checked.status,
      2,
      `${label}: check -> ${checked.status}\n${checked.stdout}${checked.stderr}`,
    );
    assert.equal(await readFile(baselineFile, "utf8"), text, `${label}: check 不应改写基线`);
    const updated = runGate(dir, ["lint", "baseline:update"]);
    assert.equal(
      updated.status,
      2,
      `${label}: update -> ${updated.status}\n${updated.stdout}${updated.stderr}`,
    );
    assert.equal(
      await readFile(baselineFile, "utf8"),
      text,
      `${label}: 损坏基线不能被 update 覆盖`,
    );
  }
});

test("基线排序按 UTF-16 码元字典序确定，不受 LC_ALL/locale 影响", async (t) => {
  const dir = await fixture(t);
  await installFakeTool(dir, "format", { stdout: "z.ts\nä.ts\npackages\\win\\a.ts\n", exit: 1 });
  const cLocale = runGate(dir, ["format", "baseline:update"], { ...process.env, LC_ALL: "C" });
  assert.equal(cLocale.status, 0, cLocale.stdout + cLocale.stderr);
  const first = await readBaselineFile(dir, "format");
  const seLocale = runGate(dir, ["format", "baseline:update"], {
    ...process.env,
    LC_ALL: "sv_SE.UTF-8",
  });
  assert.equal(seLocale.status, 0, seLocale.stdout + seLocale.stderr);
  const second = await readBaselineFile(dir, "format");
  assert.equal(second, first, "同一 entries 在不同 locale 下必须字节相同");
  assert.deepEqual(
    baselineEntries(first).map((entry) => entry.key),
    ["format\u0000packages/win/a.ts", "format\u0000z.ts", "format\u0000ä.ts"],
  );
});

test("真实 oxfmt 隔离 smoke：update 后 check 通过", async (t) => {
  const dir = await fixture(t);
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(
    path.join(REPO_ROOT, "node_modules", "oxfmt"),
    path.join(dir, "node_modules", "oxfmt"),
    "junction",
  );
  await writeFile(path.join(dir, "bad.ts"), "const  x=1\n");
  const updated = runGate(dir, ["format", "baseline:update"]);
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  const text = await readBaselineFile(dir, "format");
  assert.ok(baselineEntries(text).some((entry) => entry.key === "format\u0000bad.ts"));
  const checked = runGate(dir, ["format", "check"]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /^format: OK$/m);
});

test("CLI 入口在含空格、中文与百分号的路径下仍执行 main", async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, "入口 空格 100% 中文");
  await mkdir(dir, { recursive: true });
  const engineCopy = path.join(dir, "gate-ratchet.mjs");
  await copyFile(ENGINE, engineCopy);
  // 入口依赖同目录的纯解析层；复制整个最小运行单元，而不是依赖仓库内的相对路径。
  await copyFile(
    path.join(REPO_ROOT, "scripts", "ci", "gate-ratchet-core.mjs"),
    path.join(dir, "gate-ratchet-core.mjs"),
  );
  await installFakeTool(dir, "format", { stdout: "src/a.ts\n", exit: 1 });
  const result = runGate(dir, ["format", "baseline:update"], process.env, engineCopy);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /baseline updated: 1 entries/);
  assert.ok(await readBaselineFile(dir, "format"));
});

test("import 模块不执行 main", async (t) => {
  const dir = await fixture(t);
  const script =
    `const mod = await import(${JSON.stringify(pathToFileURL(ENGINE).href)});` +
    'if (typeof mod.isMainModule !== "function") throw new Error("isMainModule 未导出");' +
    'console.log("imported-only");';
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /imported-only/);
  assert.doesNotMatch(result.stdout, /baseline|entries:/);
});

test("knip 未知分类、缺 file、条目形状坏都 exit 2；合法元字段不被误拒", async (t) => {
  const dir = await fixture(t);
  const specFile = path.join(dir, "knip-spec.json");
  await installFakeTool(dir, "knip", { specFile });
  const run = async (issues) => {
    await writeFile(specFile, JSON.stringify({ stdout: knipReport(issues), exit: 0 }));
    return runGate(dir, ["knip", "check"]);
  };

  const unknown = await run([{ file: "src/a.ts", brandNewKind: [] }]);
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stderr, /brandNewKind/);

  const noFile = await run([{ exports: [{ name: "x" }] }]);
  assert.equal(noFile.status, 2, noFile.stdout + noFile.stderr);

  const badItem = await run([{ file: "src/a.ts", exports: [{ nope: "x" }] }]);
  assert.equal(badItem.status, 2, badItem.stdout + badItem.stderr);

  const badDuplicates = await run([{ file: "src/a.ts", duplicates: [{ name: "A" }] }]);
  assert.equal(badDuplicates.status, 2, badDuplicates.stdout + badDuplicates.stderr);

  // knip 的 json reporter 在有 CODEOWNERS 时会输出 owners 元数据；它不是分类，不能被当成未知分类拒绝。
  const owners = await run([{ file: "src/a.ts", owners: [{ name: "@team" }], exports: [] }]);
  assert.equal(owners.status, 0, owners.stdout + owners.stderr);

  const nsExports = await run([{ file: "src/a.ts", nsExports: [{ name: "X" }] }]);
  assert.equal(nsExports.status, 1, nsExports.stdout + nsExports.stderr);
  assert.match(nsExports.stdout, /^\+ 1 nsExports src\/a\.ts :: X$/m);
});

test("不合法 lint 诊断字段 exit 2，不产生幽灵 key", async (t) => {
  const dir = await fixture(t);
  const specFile = path.join(dir, "lint-spec.json");
  await installFakeTool(dir, "lint", { specFile });
  const run = async (diagnostics) => {
    await writeFile(specFile, JSON.stringify({ stdout: lintReport(diagnostics, 1), exit: 1 }));
    return runGate(dir, ["lint", "check"]);
  };
  for (const [label, value] of [
    ["缺字段", { message: "x" }],
    ["severity 未知", { severity: "hint", code: "rule", filename: "src/a.ts" }],
    ["code 为空", { severity: "error", code: "", filename: "src/a.ts" }],
    ["filename 为空", { severity: "error", code: "rule", filename: "" }],
  ]) {
    const result = await run([value]);
    assert.equal(result.status, 2, `${label}: ${result.status}\n${result.stdout}${result.stderr}`);
    assert.equal(await readBaselineFile(dir, "lint"), null);
  }
});

test("Windows 风格路径在采集时归一为仓库相对正斜杠，不折叠大小写", async (t) => {
  const dir = await fixture(t);
  await installFakeTool(dir, "format", {
    stdout: "packages\\win\\A.ts\n.\\src\\b.ts\n",
    exit: 1,
  });
  const updated = runGate(dir, ["format", "baseline:update"]);
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  assert.deepEqual(
    baselineEntries(await readBaselineFile(dir, "format")).map((entry) => entry.key),
    ["format\u0000packages/win/A.ts", "format\u0000src/b.ts"],
  );
  const checked = runGate(dir, ["format", "check"]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test("knip 零扫描是已知残留：exit 0，不能解读为已检测零文件", async (t) => {
  const dir = await fixture(t);
  await installFakeTool(dir, "knip", { stdout: knipReport([]), exit: 0 });
  const result = runGate(dir, ["knip", "check"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^entries: 0$/m);
  // 这里刻意锁死当前行为：knip 的 JSON 只有 issues，空项目与真正干净无法区分。
});

test("未知 gate、未知命令与缺参数都 exit 2", async (t) => {
  const dir = await fixture(t);
  for (const args of [["bogus", "check"], ["knip", "bogus"], []]) {
    const result = runGate(dir, args);
    assert.equal(
      result.status,
      2,
      `${args.join(" ")} -> ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
});
