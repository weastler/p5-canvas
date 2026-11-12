import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertCleanPayload, assertOwnedInstallation, runtimeFiles, shareRisks, writeRuntimePayload } from "../scripts/runtime-payload.mjs";

test("runtime distribution is allowlisted, includes dependency notices and excludes user state", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-payload-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = path.join(temp, "extensions/p5-canvas");
  const install = () => promisify(execFile)(process.execPath, [path.join(root, "scripts/install.mjs")], {
    env: { ...process.env, COPILOT_HOME: temp },
  });
  await assertOwnedInstallation(target);
  assert.match((await install()).stdout, /Installed personal extension/);
  await assertOwnedInstallation(target);
  await assertCleanPayload(target);
  const files = async (dir, prefix = "") => {
    const result = [];
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.isDirectory()) result.push(...await files(path.join(dir, item.name), prefix + item.name + "/"));
      else result.push(prefix + item.name);
    }
    return result;
  };
  assert.deepEqual((await files(target)).sort(), [...runtimeFiles].sort());
  for (const file of ["LICENSE", "vendor/editor-licenses.txt"]) {
    assert.ok((await readFile(path.join(target, file), "utf8")).length > 100);
  }
  assert.ok(!runtimeFiles.includes("vendor/p5.min.js"), "p5 is acquired at runtime, not bundled");
  for (const file of await files(target)) {
    assert.ok((await readFile(path.join(target, file))).length <= 1024 * 1024, `${file} fits the gist per-file limit`);
  }
  const { startServer } = await import(pathToFileURL(path.join(target, "server.mjs")));
  const entry = await startServer({ base: temp });
  try {
    const state = await entry.state();
    assert.equal(state.pendingFolder, true);
    assert.equal((await fetch(entry.url + "vendor/editor.js")).status, 200);
    const preview = await fetch(state.previewUrl);
    assert.equal(preview.status, 503, "opening a panel does not download a runtime or run npm");
    assert.match(await preview.text(), /Runtime settings/);
  } finally { await entry.close(); }
  await mkdir(path.join(target, "artifacts"));
  const legacy = path.join(target, "artifacts/folders.json");
  await writeFile(legacy, '{"private":"/user/folder"}');
  await assert.rejects(assertCleanPayload(target), /unexpected file/);
  await install();
  assert.equal(await readFile(legacy, "utf8"), '{"private":"/user/folder"}', "installation preserves legacy data but never reads it");
});

test("upgraded installs report leftover files the gist share flow would select, without removing them", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-share-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = path.join(temp, "extensions/p5-canvas");
  const install = () => promisify(execFile)(process.execPath, [path.join(root, "scripts/install.mjs")], {
    env: { ...process.env, COPILOT_HOME: temp },
  });
  await install();
  assert.deepEqual(await shareRisks(target), [], "a clean installation is shareable");
  const leftovers = {
    "vendor/p5.min.js": Buffer.alloc(1_057_680, "a"),
    "vendor/p5-license.txt": Buffer.from("old license"),
    "artifacts/folders.json": Buffer.from('{"private":"/user/folder"}'),
    "artifacts/runtime/p5-1.11.11.tgz": Buffer.from([0x1f, 0x8b, 0xff, 0xfe]),
    "artifacts/runtime/registry.json": Buffer.from('{"registry":"https://private.example/npm/"}'),
    "node_modules/ignored/index.js": Buffer.alloc(2_000_000, "a"),
    ".cache/ignored": Buffer.from([0xff]),
  };
  for (const [file, data] of Object.entries(leftovers)) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await writeFile(path.join(target, file), data);
  }
  const { stderr } = await install();
  const risks = Object.fromEntries((await shareRisks(target)).map(({ file, reasons }) => [file, reasons]));
  assert.deepEqual(Object.keys(risks).sort(), ["artifacts/folders.json", "artifacts/runtime/p5-1.11.11.tgz",
    "artifacts/runtime/registry.json", "vendor/p5-license.txt", "vendor/p5.min.js"]);
  assert.ok(risks["vendor/p5.min.js"].includes("larger than the gist file limit"));
  assert.ok(risks["artifacts/runtime/p5-1.11.11.tgz"].includes("binary"));
  assert.ok(risks["artifacts/runtime/registry.json"].includes("private extension data"));
  assert.match(stderr, /Before sharing.*\n[\s\S]*vendor\/p5\.min\.js/);
  for (const [file, data] of Object.entries(leftovers)) {
    assert.deepEqual(await readFile(path.join(target, file)), data, `${file} is preserved`);
  }
});

test("project-scoped share preparation round-trips without user data", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-project-share-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, "scripts"));
  for (const file of ["prepare-extension.mjs", "runtime-payload.mjs"]) {
    await copyFile(path.join(root, "scripts", file), path.join(temp, "scripts", file));
  }
  for (const file of runtimeFiles.filter(file => file !== "copilot-extension.json")) {
    const sourcePath = file === "LICENSE" ? file : path.join("extension", file);
    const destination = path.join(temp, sourcePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, sourcePath), destination);
  }
  const prepare = () => promisify(execFile)(process.execPath, [path.join(temp, "scripts/prepare-extension.mjs"), "--project"]);
  assert.match((await prepare()).stdout, /Prepared project-scoped extension/);
  const target = path.join(temp, ".github/extensions/p5-canvas");
  await assertCleanPayload(target);
  assert.deepEqual(await shareRisks(target), []);

  const gistFiles = new Map();
  for (const file of runtimeFiles) {
    gistFiles.set(file.replaceAll("/", "\\"), await readFile(path.join(target, file), "utf8"));
  }
  assert.ok(gistFiles.has("LICENSE"));
  assert.ok(gistFiles.has("vendor\\editor-licenses.txt"));
  const restored = path.join(temp, "restored");
  for (const [name, content] of gistFiles) {
    const file = path.join(restored, ...name.split("\\"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await assertCleanPayload(restored);
  for (const file of runtimeFiles) {
    assert.deepEqual(await readFile(path.join(restored, file)), await readFile(path.join(target, file)));
  }
  const { startServer } = await import(pathToFileURL(path.join(restored, "server.mjs")));
  const entry = await startServer({ base: temp }, { runtime: { source: null } });
  try {
    const state = await entry.state();
    assert.equal(state.pendingFolder, true);
    assert.equal((await fetch(entry.url + "vendor/editor.js")).status, 200);
    assert.equal((await fetch(state.previewUrl)).status, 503);
  } finally { await entry.close(); }

  const privateFile = path.join(target, "artifacts/folders.json");
  await mkdir(path.dirname(privateFile));
  await writeFile(privateFile, '{"private":"/user/folder"}');
  await assert.rejects(prepare(), error => {
    assert.match(error.stderr, /unexpected file/);
    return true;
  });
  assert.equal(await readFile(privateFile, "utf8"), '{"private":"/user/folder"}');
});

test("project-scoped share preparation refuses symlinked parents", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-project-parent-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, "scripts"));
  for (const file of ["prepare-extension.mjs", "runtime-payload.mjs"]) {
    await copyFile(path.join(root, "scripts", file), path.join(temp, "scripts", file));
  }
  const outside = path.join(temp, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(temp, ".github"));
  await assert.rejects(
    promisify(execFile)(process.execPath, [path.join(temp, "scripts/prepare-extension.mjs"), "--project"]),
    error => {
      assert.match(error.stderr, /parent must be a regular directory/);
      return true;
    },
  );
  assert.deepEqual(await readdir(outside), []);
});

test("development lockfile leaves registry selection to npm", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const registryPackages = Object.entries(lock.packages).filter(([, entry]) => entry.integrity);
  assert.ok(registryPackages.length > 0);
  for (const [name, entry] of registryPackages) {
    assert.equal(entry.resolved, undefined, `${name} must resolve through the configured registry`);
  }
});

test("installer requires an ownership marker, not matching scaffold template text", async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-ownership-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = path.join(temp, "p5-canvas");
  await mkdir(target);
  const source = "// Extension: p5-canvas\n// Hello from a local canvas server.\n// unrelated user extension\n";
  await writeFile(path.join(target, "extension.mjs"), source);
  await assert.rejects(assertOwnedInstallation(target), /Refusing to overwrite an unmarked/);
  assert.equal(await readFile(path.join(target, "extension.mjs"), "utf8"), source);
  for (const marker of ["{", "null", '{"name":"p5-canvas","version":1,"source":"another-extension"}',
    '{"name":"another-extension","version":1,"source":"copilot-p5-canvas"}']) {
    await writeFile(path.join(target, "copilot-extension.json"), marker);
    await assert.rejects(assertOwnedInstallation(target));
  }
  await symlink(target, path.join(temp, "linked"));
  await assert.rejects(assertOwnedInstallation(path.join(temp, "linked")), /regular directory/);
  await mkdir(path.join(temp, "outside"));
  await symlink(path.join(temp, "outside"), path.join(target, "vendor"));
  await assert.rejects(writeRuntimePayload(fileURLToPath(new URL("../", import.meta.url)), target), /regular directory/);
  assert.deepEqual(await readdir(path.join(temp, "outside")), []);
});
