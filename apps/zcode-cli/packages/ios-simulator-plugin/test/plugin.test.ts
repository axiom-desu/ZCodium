import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { pickAppProduct } from "../src/providers/build.js"
import { create, source } from "../src/providers/project.js"
import { isIosRuntime, parseSimulators } from "../src/providers/sim.js"

const found = {
  projects: ["Explicit.xcodeproj"],
  workspaces: ["Auto.xcworkspace"],
  schemes: ["AutoScheme"],
  bundleIds: [],
}

test("source prefers explicit project over auto workspace", () => {
  assert.deepEqual(source({ project: "Explicit.xcodeproj" }, found), {
    flag: "-project",
    file: "Explicit.xcodeproj",
    scheme: "Explicit",
  })
})

test("create validates inputs and refuses accidental overwrites", async () => {
  await withCwd(async () => {
    const created = await create({ name: "Counter App", deployment: "17.0" })
    assert.equal(created.project, path.join("CounterApp", "CounterApp.xcodeproj"))
    assert.equal(created.bundle, "com.example.counterapp")
    await assert.rejects(create({ name: "Counter App" }), /Refusing to overwrite/)
    await assert.rejects(create({ name: "Escaped", dir: "../Escaped" }), /Path escapes project root/)
    await assert.rejects(create({ name: "BadDeploy", deployment: "17.0; BAD=1" }), /Invalid deployment/)
    await assert.rejects(create({ name: "BadBundle", bundleId: "com.example.bad_bundle" }), /Invalid bundle id/)
  })
})

test("build product selection prefers the requested configuration", () => {
  const debug = path.join("DerivedData", "Build", "Products", "Debug-iphonesimulator", "Demo.app")
  const release = path.join("DerivedData", "Build", "Products", "Release-iphonesimulator", "Demo.app")
  assert.equal(pickAppProduct([debug, release], "Release"), release)
  assert.equal(pickAppProduct([debug], "Release"), debug)
})

test("runtime filtering keeps only iOS simulator runtimes", () => {
  assert.equal(isIosRuntime("com.apple.CoreSimulator.SimRuntime.iOS-18-2"), true)
  assert.equal(isIosRuntime("com.apple.CoreSimulator.SimRuntime.iPadOS-18-2"), true)
  assert.equal(isIosRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-18-2"), false)
  assert.equal(isIosRuntime("com.apple.CoreSimulator.SimRuntime.watchOS-11-2"), false)
  assert.equal(isIosRuntime("com.apple.CoreSimulator.SimRuntime.visionOS-2-2"), false)
})

test("simulator parsing drops non-iOS runtimes and unavailable devices", () => {
  const sims = parseSimulators(JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [
        { name: "Apple TV", udid: "TV-1", state: "Shutdown", isAvailable: true },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { name: "iPhone 16", udid: "IOS-1", state: "Shutdown", isAvailable: true },
        { name: "iPhone 15", udid: "IOS-2", state: "Shutdown", availabilityError: "runtime unavailable" },
      ],
    },
  }))
  assert.deepEqual(sims, [
    {
      name: "iPhone 16",
      udid: "IOS-1",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      available: true,
    },
    {
      name: "iPhone 15",
      udid: "IOS-2",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      available: false,
    },
  ])
  assert.equal(sims.filter((item) => item.available).length, 1)
})

async function withCwd(work: () => Promise<void>) {
  const old = process.cwd()
  const dir = await mkdtemp(path.join(tmpdir(), "ios-plugin-test-"))
  process.chdir(dir)
  try {
    await work()
  } finally {
    process.chdir(old)
    await rm(dir, { recursive: true, force: true })
  }
}
