// S8-C：附加执行目录只扩大显式发现根（skills/commands），不改 cwd/身份/权限。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { NodeCustomCommandAdapter } from "../src/commands/index.js";
import { resolveDefaultCustomCommandRoots } from "../src/commands/roots.js";
import { NodeSkillAdapter } from "../src/skills/index.js";
import { resolveDefaultSkillRoots } from "../src/skills/roots.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "zcode-additional-dirs-"));
  roots.push(root);
  const main = join(root, "main");
  const home = join(root, "home");
  const shared = join(root, "shared");
  const unlisted = join(root, "unlisted");
  await Promise.all([main, home, shared, unlisted].map((dir) => mkdir(dir, { recursive: true })));
  return { root, main, home, shared, unlisted };
}

async function writeSkill(directory: string, name: string) {
  const dir = join(directory, ".zcodium", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`,
  );
}

async function writeCommand(directory: string, name: string) {
  const dir = join(directory, ".zcodium", "commands");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), `---\ndescription: ${name} command\n---\nbody\n`);
}

test("additional directories add skill and command roots once and skip cwd", async () => {
  const { main, home, shared } = await workspace();
  await writeSkill(main, "main-skill");
  await writeSkill(shared, "shared-skill");
  await writeCommand(main, "main-command");
  await writeCommand(shared, "shared-command");

  const skillRoots = await resolveDefaultSkillRoots(main, {
    homeDirectory: home,
    additionalDirectories: [shared, shared, main],
  });
  const sharedSkillRoots = skillRoots.filter((root) => root.path.startsWith(shared));
  assert.equal(sharedSkillRoots.length, 2);
  assert.ok(sharedSkillRoots.every((root) => root.scope === "project"));
  const mainProjectRoots = skillRoots.filter((root) => root.path.startsWith(main));
  assert.equal(mainProjectRoots.length, 2);

  const skills = await new NodeSkillAdapter({
    homeDirectory: home,
    additionalDirectories: [shared],
  }).discoverSkills({ workingDirectory: main });
  assert.deepEqual(
    skills.skills.map((skill) => skill.name),
    ["main-skill", "shared-skill"],
  );

  const commandRoots = await resolveDefaultCustomCommandRoots(main, {
    homeDirectory: home,
    additionalDirectories: [shared, shared, main],
  });
  assert.equal(commandRoots.filter((root) => root.path.startsWith(shared)).length, 2);
  assert.equal(commandRoots.filter((root) => root.path.startsWith(main)).length, 2);

  const commands = await new NodeCustomCommandAdapter({
    homeDirectory: home,
    additionalDirectories: [shared],
  }).discoverCommands({ workingDirectory: main });
  assert.deepEqual(
    commands.commands.map((command) => command.name),
    ["main-command", "shared-command"],
  );
});

test("a directory not passed as additional never becomes a discovery root", async () => {
  const { main, home, unlisted } = await workspace();
  await writeSkill(unlisted, "hidden-skill");
  await writeCommand(unlisted, "hidden-command");

  const skills = await new NodeSkillAdapter({
    homeDirectory: home,
    additionalDirectories: [],
  }).discoverSkills({ workingDirectory: main });
  assert.deepEqual(
    skills.skills.map((skill) => skill.name),
    [],
  );
  const commands = await new NodeCustomCommandAdapter({
    homeDirectory: home,
    additionalDirectories: [],
  }).discoverCommands({ workingDirectory: main });
  assert.deepEqual(
    commands.commands.map((command) => command.name),
    [],
  );
});
