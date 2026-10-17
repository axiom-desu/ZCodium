export const rustTuiLockFile = "apps/zcode-cli-rust/Cargo.lock";

/** Parse Cargo.lock package records and return the conservative registry closure for the TUI. */
export function readRustTuiRegistryClosure(lockText) {
  const blocks = lockText.split(/^\[\[package\]\]\s*$/m).slice(1);
  const packages = blocks.map((block) => {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]+)"`, "m"))?.[1];
    const depsBlock = block.match(/^dependencies = \[([\s\S]*?)^\]/m)?.[1] ?? "";
    return {
      name: field("name"),
      version: field("version"),
      source: field("source"),
      checksum: field("checksum"),
      dependencies: [...depsBlock.matchAll(/^\s+"([^" ]+)(?: [^"]*)?",?\s*$/gm)].map(
        (match) => match[1],
      ),
    };
  });
  const tui = packages.find((item) => item.name === "zcode-cli-tui" && !item.source);
  if (!tui) throw new Error("zcode-cli-tui missing from Cargo.lock");

  const byName = new Map();
  for (const item of packages) {
    const matches = byName.get(item.name) ?? [];
    matches.push(item);
    byName.set(item.name, matches);
  }
  const visited = new Set();
  const registry = new Map();
  const visit = (item) => {
    const key = `${item.name}\0${item.version}\0${item.source ?? ""}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (item.source?.startsWith("registry+")) registry.set(key, item);
    for (const dependency of item.dependencies) {
      // Cargo.lock dependency edges can omit the resolved version; include every same-name
      // record conservatively so target-specific and multi-version dependencies are covered.
      for (const candidate of byName.get(dependency) ?? []) visit(candidate);
    }
  };
  visit(tui);
  return [...registry.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      a.source.localeCompare(b.source),
  );
}
