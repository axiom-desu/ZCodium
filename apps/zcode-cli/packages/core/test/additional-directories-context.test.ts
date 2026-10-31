// S8-C：模型请求环境必须显示本次运行冻结的附加目录，且空集不制造字段。
import assert from "node:assert/strict";
import test from "node:test";

import { buildEnvInfoSection } from "../src/context/sections/env-info.js";
import type { EnvInfo } from "../src/context/types.js";

const envInfo: EnvInfo = {
  cwd: "/work/main",
  platform: "linux",
  shell: "bash",
  osVersion: "linux",
  isGitRepository: false,
  gitStatus: "not_repo",
};

test("environment section lists the frozen additional directories", () => {
  const section = buildEnvInfoSection(envInfo, undefined, ["/work/shared", "/work/other"]);
  assert.match(section.content, /- Primary working directory: \/work\/main/u);
  assert.match(section.content, /- Additional directories:/u);
  assert.match(section.content, / {2}- \/work\/shared/u);
  assert.match(section.content, / {2}- \/work\/other/u);
});

test("environment section omits additional directories when none are frozen", () => {
  const section = buildEnvInfoSection(envInfo, undefined, []);
  assert.doesNotMatch(section.content, /Additional directories/u);
});
