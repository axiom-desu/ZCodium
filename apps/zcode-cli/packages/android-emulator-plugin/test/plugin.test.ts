import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickApk } from "../src/providers/build.js";
import { androidSystemImagePackage } from "../src/providers/config.js";
import { adbShellCommand, parseAdbDevices } from "../src/providers/device.js";
import { parseAvds, startedEmulatorCandidates } from "../src/providers/avd.js";
import { create, discover } from "../src/providers/project.js";
import { preflightOk, type Check } from "../src/providers/preflight.js";
import { inputText, parseUiAutomator } from "../src/providers/ui.js";

test("create validates inputs and refuses accidental overwrites", async () => {
  await withCwd(async () => {
    const created = await create({
      name: "Counter App",
      packageName: "com.example.counterapp",
      minSdk: 24,
    });
    assert.equal(created.root, "CounterApp");
    assert.equal(created.applicationId, "com.example.counterapp");
    assert.equal(created.createdBy, "template");
    assert.ok(created.files.includes(path.join("CounterApp", "gradle.properties")));
    assert.ok(created.files.includes(path.join("CounterApp", "local.properties")));
    assert.ok((await readFile(path.join("CounterApp", "gradle.properties"), "utf8")).includes(
      "android.useAndroidX=true",
    ));
    assert.ok((await readFile(path.join("CounterApp", "local.properties"), "utf8")).includes(
      "sdk.dir=",
    ));

    await assert.rejects(create({ name: "Counter App" }), /Refusing to overwrite/);
    await assert.rejects(create({ name: "Escaped", dir: "../Escaped" }), /Path escapes project root/);
    await assert.rejects(
      create({ name: "Bad Package", packageName: "com.example.bad-package" }),
      /Invalid Android package name/,
    );
    await assert.rejects(create({ name: "Bad Sdk", minSdk: 1 }), /Invalid minSdk/);
  });
});

test("discover finds generated Gradle project metadata", async () => {
  await withCwd(async () => {
    await create({ name: "Demo", packageName: "com.example.demo" });
    await mkdir(path.join("Demo", "app", "build", "outputs", "apk", "debug"), { recursive: true });
    await writeFile(
      path.join("Demo", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
      "",
    );
    const found = await discover();
    assert.equal(found.root, "Demo");
    assert.deepEqual(found.modules, [":app"]);
    assert.ok(found.applicationIds.includes("com.example.demo"));
    assert.equal(found.manifests.some((item) => item.endsWith("AndroidManifest.xml")), true);
    assert.deepEqual(found.apks, [
      path.join("Demo", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    ]);
    assert.equal(found.hasGradleProperties, true);
    assert.equal(found.hasLocalProperties, true);
    assert.deepEqual(found.warnings, [
      "Missing Gradle wrapper. Install Gradle or generate ./gradlew before building.",
    ]);
  });
});

test("plugin config environment controls Android defaults", async () => {
  await withEnv(
    {
      ANDROID_PLUGIN_API_LEVEL: "36",
      ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT: "google_apis",
      ANDROID_PLUGIN_SYSTEM_IMAGE_ABI: "x86_64",
    },
    async () => {
      await withCwd(async () => {
        await create({ name: "Configured", packageName: "com.example.configured" });
        const build = await readFile(path.join("Configured", "app", "build.gradle.kts"), "utf8");
        assert.ok(build.includes("compileSdk = 36"));
        assert.equal(androidSystemImagePackage(), "system-images;android-36;google_apis;x86_64");
      });
    },
  );
});

test("adb devices parser keeps serial, state, and attributes", () => {
  assert.deepEqual(
    parseAdbDevices(`List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
R5CT12345 unauthorized usb:338690048X product:phone model:Pixel_8 device:husky
`), [
    {
      serial: "emulator-5554",
      state: "device",
      kind: "emulator",
      product: "sdk_gphone64_arm64",
      model: "sdk_gphone64_arm64",
      device: "emu64a",
      transportId: "1",
      raw: "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
    },
    {
      serial: "R5CT12345",
      state: "unauthorized",
      kind: "device",
      product: "phone",
      model: "Pixel_8",
      device: "husky",
      transportId: undefined,
      raw: "R5CT12345 unauthorized usb:338690048X product:phone model:Pixel_8 device:husky",
    },
  ]);
});

test("avd parser drops blank lines", () => {
  assert.deepEqual(parseAvds("\nPixel_8\nmedium_phone\n\n"), [
    { name: "Pixel_8" },
    { name: "medium_phone" },
  ]);
});

test("started emulator candidates exclude devices present before launch", () => {
  const existing = {
    serial: "emulator-5554",
    state: "device",
    kind: "emulator" as const,
    raw: "emulator-5554 device",
  };
  const fresh = {
    serial: "emulator-5556",
    state: "device",
    kind: "emulator" as const,
    raw: "emulator-5556 device",
  };
  const physical = {
    serial: "R5CT12345",
    state: "device",
    kind: "device" as const,
    raw: "R5CT12345 device",
  };

  assert.deepEqual(startedEmulatorCandidates([existing, fresh, physical], new Set([existing.serial])), [
    fresh,
  ]);
  assert.deepEqual(startedEmulatorCandidates([existing, physical], new Set([existing.serial])), []);
});

test("preflight accepts a ready device target without emulator-only setup", () => {
  const emulatorOnlyMissing = [
    check("emulator", false),
    check("avdmanager", false),
    check("Android Virtual Devices", false),
    check("Emulator acceleration", false),
  ];

  assert.equal(
    preflightOk([...readyRequiredChecks(), ...emulatorOnlyMissing, check("ADB devices", true)], {
      hasReadyTarget: true,
    }),
    true,
  );
  assert.equal(
    preflightOk([...readyRequiredChecks(), ...emulatorOnlyMissing, check("ADB devices", false)], {
      hasReadyTarget: false,
    }),
    false,
  );
});

test("preflight allows no adb target before starting a configured emulator", () => {
  assert.equal(
    preflightOk(
      [
        ...readyRequiredChecks(),
        check("emulator", true),
        check("avdmanager", true),
        check("Android Virtual Devices", true),
        check("ADB devices", false),
      ],
      { hasReadyTarget: false },
    ),
    true,
  );
});

test("apk selection prefers requested variant", () => {
  const debug = path.join("app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const release = path.join("app", "build", "outputs", "apk", "release", "app-release.apk");

  assert.equal(pickApk([debug, release], "release"), release);
  assert.equal(pickApk([debug], "release"), debug);
});

test("uiautomator parser returns compact elements with bounds centers", () => {
  const elements = parseUiAutomator(`<hierarchy>
  <node index="0" text="Increment" content-desc="incrementButton" resource-id="com.example:id/inc" class="android.widget.Button" clickable="true" enabled="true" bounds="[10,20][110,220]" />
</hierarchy>`);

  assert.deepEqual(elements, [
    {
      index: 0,
      text: "Increment",
      contentDescription: "incrementButton",
      resourceId: "com.example:id/inc",
      className: "android.widget.Button",
      bounds: { left: 10, top: 20, right: 110, bottom: 220, centerX: 60, centerY: 120 },
      clickable: true,
      enabled: true,
    },
  ]);
});

test("adb input text encodes spaces and percent before shell quoting", () => {
  assert.equal(inputText('100% ready & go; "ok" (now)'), 
    '100%25%sready%s&%sgo;%s"ok"%s(now)',
  );
});

test("adb shell command quotes device shell tokens", () => {
  assert.equal(
    adbShellCommand(["am", "start", "-d", "https://example.com/path?q=one&next='two'"]),
    "am start -d 'https://example.com/path?q=one&next='\\''two'\\'''",
  );
  assert.equal(adbShellCommand(["input", "text", "hello%sworld"]), 
    "input text hello%sworld",
  );
});

async function withCwd(work: () => Promise<void>) {
  const old = process.cwd();
  const sdkPath = process.env.ANDROID_PLUGIN_SDK_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), "android-plugin-test-"));
  process.chdir(dir);
  process.env.ANDROID_PLUGIN_SDK_PATH = path.join(dir, "sdk");
  try {
    await mkdir("fixtures", { recursive: true });
    await mkdir(process.env.ANDROID_PLUGIN_SDK_PATH, { recursive: true });
    await writeFile(path.join("fixtures", ".keep"), "");
    await work();
  } finally {
    process.chdir(old);
    if (sdkPath === undefined) delete process.env.ANDROID_PLUGIN_SDK_PATH;
    else process.env.ANDROID_PLUGIN_SDK_PATH = sdkPath;
    await rm(dir, { recursive: true, force: true });
  }
}

function readyRequiredChecks(): Check[] {
  return [
    check("Host OS", true),
    check("Android SDK root", true),
    check("Android plugin defaults", true),
    check("adb", true),
    check("sdkmanager", true),
    check("Java", true),
    check("Gradle", true),
  ];
}

function check(name: string, ok: boolean): Check {
  return { name, ok, detail: ok ? "available" : "missing" };
}

async function withEnv(values: Record<string, string>, work: () => Promise<void>) {
  const old = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    await work();
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
