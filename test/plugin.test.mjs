import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeFiles, writeRuntimePayload } from "../scripts/runtime-payload.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const runtimePath = "com.github.copilot/extensions/p5-canvas";

async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-plugin-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceFiles = [
    "package.json", "LICENSE", "assets/preview.png", "packaging/plugin.json",
    "scripts/prepare-plugin.mjs", "scripts/runtime-payload.mjs",
    ...runtimeFiles.filter(file => file !== "copilot-extension.json" && file !== "LICENSE").map(file => `extension/${file}`),
  ];
  for (const file of sourceFiles) {
    await mkdir(path.dirname(path.join(temp, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(temp, file));
  }
  return {
    temp,
    target: path.join(temp, "dist", "plugin"),
    prepare: () => exec(process.execPath, [path.join(temp, "scripts", "prepare-plugin.mjs")]),
  };
}

async function listFiles(directory, prefix = "") {
  const result = [];
  for (const item of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = prefix + item.name;
    if (item.isDirectory()) result.push(...await listFiles(directory, `${file}/`));
    else result.push(file);
  }
  return result.sort();
}

test("the repository marketplace points to the built plugin on dist", async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, ".github/plugin/marketplace.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(root, "packaging/plugin.json"), "utf8"));
  const entry = marketplace.plugins.find(plugin => plugin.name === manifest.name);
  assert.ok(entry, "the marketplace must include the plugin");
  assert.deepEqual(entry.source, {
    source: "github",
    repo: new URL(manifest.repository).pathname.slice(1),
    ref: "dist",
  });
});

test("plugin package contains the complete direct-install payload and safe preview", async t => {
  const { temp, target, prepare } = await fixture(t);
  assert.match((await prepare()).stdout, /Prepared Agent Plugins 1.0 package/);

  const manifest = JSON.parse(await readFile(path.join(target, "plugin.json"), "utf8"));
  const packageInfo = JSON.parse(await readFile(path.join(temp, "package.json"), "utf8"));
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.version, packageInfo.version);
  assert.ok(manifest.keywords.includes("canvas"));
  assert.equal(manifest.extensions["com.github.copilot"].logo, "assets/preview.png");
  assert.deepEqual((await readFile(path.join(target, "assets/preview.png"))).subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.deepEqual(await listFiles(target), ["plugin.json", "LICENSE", "assets/preview.png",
    ...runtimeFiles.map(file => `${runtimePath}/${file}`)].sort());

  const direct = path.join(temp, "direct");
  await mkdir(direct);
  await writeRuntimePayload(temp, direct);
  for (const file of runtimeFiles) {
    assert.deepEqual(await readFile(path.join(target, runtimePath, file)), await readFile(path.join(direct, file)), file);
  }
  assert.ok(!runtimeFiles.includes("vendor/p5.min.js"));

  await writeFile(path.join(temp, "extension/app.js"), "\n// updated fixture\n", { flag: "a" });
  await prepare();
  assert.deepEqual(await readFile(path.join(target, runtimePath, "app.js")), await readFile(path.join(temp, "extension/app.js")));
});

test("plugin preparation refuses unknown files, symlinks, and mismatched versions", async t => {
  const { temp, target, prepare } = await fixture(t);
  await prepare();
  const privateFile = path.join(target, "private-settings.json");
  await writeFile(privateFile, '{"private":true}');
  await assert.rejects(prepare(), error => {
    assert.match(error.stderr, /unexpected file.*private-settings\.json/);
    return true;
  });
  assert.equal(await readFile(privateFile, "utf8"), '{"private":true}');
  await rm(privateFile);

  const outside = path.join(temp, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(target, "linked"));
  await assert.rejects(prepare(), error => {
    assert.match(error.stderr, /unexpected file.*linked/);
    return true;
  });
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(target, "linked"));

  const packageFile = path.join(temp, "package.json");
  const packageInfo = JSON.parse(await readFile(packageFile, "utf8"));
  packageInfo.version = "999.0.0";
  await writeFile(packageFile, JSON.stringify(packageInfo));
  await assert.rejects(prepare(), error => {
    assert.match(error.stderr, /version does not match package\.json/);
    return true;
  });
});
