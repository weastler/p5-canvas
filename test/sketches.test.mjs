import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listSketches, readSketch, saveSketch, createSketch, createVariation, findSketchesFolder, chooseSketchesFolder, createSketchesFolder } from "../extension/sketches.mjs";
import { MAX_EDITOR_SNAPSHOT_BYTES, startServer } from "../extension/server.mjs";
import { resolveLocation } from "../extension/folders.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-canvas-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sketches/nested"), { recursive: true });
  await writeFile(path.join(root, "sketches/demo.js"), "function draw() {}");
  await writeFile(path.join(root, "sketches/nested/other.js"), "let x = 1;");
  await writeFile(path.join(root, "sketches/ignore.txt"), "not a sketch");
  return root;
}

test("discovers nested scripts, ignores symlinks, and handles a missing folder", async t => {
  const root = await fixture(t);
  const folder = path.join(root, "sketches");
  await symlink(path.join(folder, "demo.js"), path.join(folder, "link.js"));
  await mkdir(path.join(folder, "node_modules"));
  await writeFile(path.join(folder, "node_modules/dep.js"), "");
  assert.deepEqual(await listSketches(folder), ["demo.js", "nested/other.js"]);
  await rm(folder, { recursive: true });
  assert.deepEqual(await listSketches(folder), []);
});

test("finds a sketches folder without Git and accepts explicit folders", async t => {
  const root = await fixture(t);
  assert.equal(await findSketchesFolder(root), path.join(root, "sketches"));
  assert.equal(await findSketchesFolder(path.join(root, "missing")), null);
  assert.equal(await chooseSketchesFolder(root), path.join(root, "sketches"));
  assert.equal(await chooseSketchesFolder(path.join(root, "sketches/nested")), path.join(root, "sketches/nested"));
  for (const invalid of ["relative/path", "", 123, null, "/", path.join(root, "missing"), path.join(root, "sketches/demo.js")]) {
    await assert.rejects(chooseSketchesFolder(invalid), { status: 400 });
  }
  await rm(path.join(root, "sketches"), { recursive: true });
  await symlink(root, path.join(root, "sketches"));
  await assert.rejects(findSketchesFolder(root), { status: 403 });
});

test("creates only an empty sketches folder when it is missing", async t => {
  const root = await fixture(t);
  await assert.rejects(createSketchesFolder(root), { status: 409 });
  await rm(path.join(root, "sketches"), { recursive: true });
  const folder = await createSketchesFolder(root);
  assert.deepEqual(await listSketches(folder), []);
  assert.deepEqual(await readdir(folder), []);
});

test("creates a normalized starter sketch without overwriting existing files or symlinks", async t => {
  const base = await fixture(t);
  const folder = path.join(base, "sketches");
  const created = await createSketch(folder, "  New sketch.JS  ");
  assert.equal(created.name, "New sketch.js");
  assert.match(created.content, /function setup\(\)/);
  assert.match(created.content, /function draw\(\)/);
  assert.deepEqual(await readSketch(folder, created.name), created);
  const edited = await saveSketch(folder, created.name, "let fresh = true;\n", created.version);
  assert.equal(await readFile(path.join(folder, created.name), "utf8"), edited.content);
  await assert.rejects(createSketch(folder, "New sketch"), { status: 409 });
  assert.equal(await readFile(path.join(folder, created.name), "utf8"), edited.content);
  const outside = path.join(base, "outside.js");
  await writeFile(outside, "private");
  await symlink(outside, path.join(folder, "escape.js"));
  await assert.rejects(createSketch(folder, "escape"), { status: 409 });
  assert.equal(await readFile(outside, "utf8"), "private");
  await symlink(folder, path.join(base, "linked-folder"));
  await assert.rejects(createSketch(path.join(base, "linked-folder"), "fresh"), { status: 409 });
});

test("rejects invalid new sketch names and concurrent duplicate creation", async t => {
  const base = await fixture(t);
  const folder = path.join(base, "sketches");
  for (const name of [null, 123, "", " ", ".js", ".hidden", ".", "..", "../outside.js", "/outside.js",
    "nested/new.js", "nested\\new.js", "art.txt", "a\0b", "a\nb", "x".repeat(126)]) {
    await assert.rejects(createSketch(folder, name), { status: 400 }, JSON.stringify(name));
  }
  assert.deepEqual(await listSketches(folder), ["demo.js", "nested/other.js"]);
  const results = await Promise.allSettled([createSketch(folder, "fresh"), createSketch(folder, "fresh")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  assert.deepEqual(await readSketch(folder, "fresh.js"), results.find(result => result.status === "fulfilled").value);
});

test("creates numbered variations beside the source without overwriting", async t => {
  const folder = path.join(await fixture(t), "sketches");
  const first = await createVariation(folder, "demo.js", "// one\n");
  assert.equal(first.name, "demo-v2.js");
  assert.deepEqual(await readSketch(folder, "demo-v2.js"), first);
  await writeFile(path.join(folder, "demo-v3.js"), "// taken\n");
  assert.equal((await createVariation(folder, "demo-v2.js", "// two\n")).name, "demo-v4.js");
  assert.equal(await readFile(path.join(folder, "demo-v3.js"), "utf8"), "// taken\n");
  assert.equal((await createVariation(folder, "nested/other.js", "")).name, "nested/other-v2.js");
  const results = await Promise.all([createVariation(folder, "demo.js", "a"), createVariation(folder, "demo.js", "b")]);
  assert.deepEqual(results.map(result => result.name).sort(), ["demo-v5.js", "demo-v6.js"]);
  for (const [name, content] of [["../outside.js", ""], ["demo.txt", ""], ["demo.js", 1], ["demo.js", "x".repeat(1024 * 1024 + 1)]]) {
    await assert.rejects(createVariation(folder, name, content), { status: 400 }, name);
  }
  await Promise.all(Array.from({ length: 999 }, (_, i) => writeFile(path.join(folder, `many-v${i + 2}.js`), "")));
  assert.equal((await createVariation(folder, "many.js", "// next\n")).name, "many-v1001.js");
});

test("session CWD is authoritative, independent of Git, process CWD and legacy saved choices", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "artifacts"));
  const legacy = path.join(root, "artifacts/folders.json");
  await writeFile(legacy, JSON.stringify({ [root]: "/old/selected/folder" }));
  const ctx = { session: { workingDirectory: root } };
  assert.deepEqual(await resolveLocation(ctx), { base: root });
  const entry = await startServer(await resolveLocation(ctx));
  t.after(() => entry.close());
  assert.equal((await entry.state()).folder, path.join(root, "sketches"));
  await writeFile(legacy, "{");
  assert.deepEqual(await resolveLocation(ctx), { base: root }, "legacy preferences are never read");
  assert.equal(await readFile(legacy, "utf8"), "{", "legacy data is not deleted or rewritten");
  assert.deepEqual(await resolveLocation({}), { base: undefined }, "unknown session CWD must not use process.cwd()");
  for (const workingDirectory of ["relative", "/", path.join(root, "missing")]) {
    await assert.rejects(resolveLocation({ session: { workingDirectory } }), { status: 400 });
  }
});

test("explicit folder inputs win and optional switching lasts only for this open panel", async t => {
  const base = await fixture(t);
  const selected = path.join(base, "chosen");
  await mkdir(selected);
  const ctx = { session: { workingDirectory: base } };
  assert.deepEqual(await resolveLocation({ ...ctx, input: { folderPath: selected, repositoryPath: base } }), { base, folder: selected });
  assert.deepEqual(await resolveLocation({ ...ctx, input: { repositoryPath: base } }), { base, folder: path.join(base, "sketches") });
  assert.deepEqual(await resolveLocation({ input: { folderPath: selected } }), { base: undefined, folder: selected });
  await assert.rejects(resolveLocation({ ...ctx, input: { folderPath: "relative" } }), { status: 400 });
  const entry = await startServer(await resolveLocation(ctx));
  t.after(() => entry.close());
  assert.equal((await post(entry, "choose-folder", { path: selected })).status, 200);
  assert.equal((await entry.state()).folder, selected);
  assert.equal((await (await fetch(entry.url + "state")).json()).folder, selected, "iframe reload keeps the server's selection");
  const reopened = await startServer(await resolveLocation(ctx));
  t.after(() => reopened.close());
  assert.equal((await reopened.state()).folder, path.join(base, "sketches"), "fresh panels return to session CWD");
});

async function post(entry, route, body, headers = {}) {
  const url = new URL(entry.url);
  return fetch(entry.url + route, {
    method: "POST",
    headers: { Origin: url.origin, "X-P5-Token": url.pathname.split("/")[1], "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("new sketch requests require authorization and create only in the selected folder", async t => {
  const base = await fixture(t);
  const folder = path.join(base, "selected");
  await mkdir(folder);
  const entry = await startServer({ base, folder });
  t.after(() => entry.close());
  assert.equal((await post(entry, "create-sketch", { name: "fresh" }, { Origin: "null" })).status, 403);
  assert.equal((await post(entry, "create-sketch", { name: "fresh" }, { "X-P5-Token": "invalid" })).status, 403);
  assert.equal((await post(entry, "create-sketch", { name: "../outside" })).status, 400);
  assert.deepEqual(await readdir(folder), []);
  const response = await post(entry, "create-sketch", { name: "fresh" });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.deepEqual(await readSketch(folder, "fresh.js"), created);
  assert.deepEqual((await entry.state()).sketches, ["fresh.js"]);
  assert.equal((await post(entry, "create-sketch", { name: "fresh.js" })).status, 409);
  assert.deepEqual(await listSketches(path.join(base, "sketches")), ["demo.js", "nested/other.js"]);
  await rm(folder, { recursive: true });
  assert.equal((await post(entry, "create-sketch", { name: "missing" })).status, 409);
  assert.equal((await entry.state()).status, "missing_folder");
});

async function connectEditor(entry) {
  const response = await fetch(entry.url + "editor-events");
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event.split("\n").find(line => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Editor event stream closed.");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
    close: () => reader.cancel(),
  };
}

test("selected-sketch snapshots are fresh, bounded, and isolated per canvas", async t => {
  const base = await fixture(t);
  const folder = path.join(base, "sketches");
  const first = await startServer({ base });
  const second = await startServer({ base });
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.equal((await first.currentSketch()).status, "unavailable");
  const editorA = await connectEditor(first);
  const editorB = await connectEditor(second);
  t.after(() => Promise.all([editorA.close(), editorB.close()]));
  const saveStatus = { dirty: true, saving: false, conflict: false, error: null };
  let request = first.currentSketch();
  let event = await editorA.next();
  const snapshot = { ...event, status: "ready", folder, name: "demo.js", content: "unsaved draft A", saveStatus };
  assert.equal((await post(first, "editor-snapshot", snapshot, { Origin: "null" })).status, 403);
  assert.equal((await post(second, "editor-snapshot", snapshot)).status, 409);
  assert.equal((await post(first, "editor-snapshot", { ...snapshot, name: "../outside.js" })).status, 400);
  assert.equal((await post(first, "editor-snapshot", snapshot)).status, 200);
  assert.deepEqual(await request, {
    status: "ready", path: path.join(folder, "demo.js"), content: "unsaved draft A", saveStatus,
  });
  assert.equal(await readFile(path.join(folder, "demo.js"), "utf8"), "function draw() {}");

  request = second.currentSketch();
  event = await editorB.next();
  assert.equal((await post(second, "editor-snapshot", {
    ...event, status: "ready", folder, name: "nested/other.js", content: "draft B", saveStatus,
  })).status, 200);
  assert.deepEqual(await request, {
    status: "ready", path: path.join(folder, "nested/other.js"), content: "draft B", saveStatus,
  });

  request = first.currentSketch();
  event = await editorA.next();
  await post(first, "editor-snapshot", { ...event, status: "no_sketch" });
  assert.equal((await request).status, "no_sketch");

  request = first.currentSketch();
  event = await editorA.next();
  await post(first, "editor-snapshot", {
    ...event, status: "ready", folder, name: "demo.js", content: "x".repeat(MAX_EDITOR_SNAPSHOT_BYTES + 1), saveStatus,
  });
  const large = await request;
  assert.equal(large.status, "too_large");
  assert.equal(large.path, path.join(folder, "demo.js"));
  assert.equal(large.sizeBytes, MAX_EDITOR_SNAPSHOT_BYTES + 1);
  assert.equal(large.limitBytes, MAX_EDITOR_SNAPSHOT_BYTES);
  assert.equal(Object.hasOwn(large, "content"), false);

  request = first.currentSketch();
  event = await editorA.next();
  first.configure({ base, folder: path.join(folder, "nested") });
  await post(first, "editor-snapshot", { ...event, status: "ready", folder, name: "demo.js", content: "old folder", saveStatus });
  const changed = await request;
  assert.equal(changed.status, "unavailable");
  assert.equal(Object.hasOwn(changed, "content"), false);

  request = first.currentSketch();
  event = await editorA.next();
  const replacement = await connectEditor(first);
  t.after(() => replacement.close());
  assert.equal((await request).status, "unavailable");
  assert.equal((await post(first, "editor-snapshot", { ...event, status: "no_sketch" })).status, 409);
});

test("missing folder is detected live, created on request, or chosen", async t => {
  const base = await fixture(t);
  await rm(path.join(base, "sketches"), { recursive: true });
  const entry = await startServer({ base });
  t.after(() => entry.close());
  let state = await (await fetch(entry.url + "state")).json();
  assert.equal(state.status, "ready");
  assert.equal(state.base, base);
  assert.equal(state.pendingFolder, true);
  assert.equal(state.folder, path.join(base, "sketches"));
  assert.deepEqual(state.sketches, []);
  await assert.rejects(readdir(state.folder), { code: "ENOENT" });
  assert.equal((await fetch(entry.url + "sketch?name=sketch.js")).status, 409);
  assert.equal((await post(entry, "save", { name: "sketch.js", content: "", version: "v" })).status, 409);
  assert.equal((await post(entry, "create-folder", {}, { Origin: "null" })).status, 403);

  // A folder written by another tool after opening is picked up on the next poll.
  await mkdir(path.join(base, "sketches"));
  await writeFile(path.join(base, "sketches/late.js"), "function setup() {}");
  state = await entry.state();
  assert.equal(state.status, "ready");
  assert.deepEqual(state.sketches, ["late.js"]);
  assert.equal((await post(entry, "create-folder", {})).status, 409);

  await rm(path.join(base, "sketches"), { recursive: true });
  const created = await (await post(entry, "create-folder", {})).json();
  assert.equal(created.folder, path.join(base, "sketches"));
  assert.deepEqual(created.sketches, []);

  const other = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-canvas-other-")));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(path.join(other, "art.js"), "let a;");
  assert.equal((await post(entry, "choose-folder", { path: "relative" })).status, 400);
  const picked = await (await post(entry, "choose-folder", { path: other })).json();
  assert.equal(picked.folder, other);
  assert.deepEqual(picked.sketches, ["art.js"]);
});

test("first sketch lazily creates the default folder, but invalid or unauthorized requests do not", async t => {
  const base = await fixture(t);
  const folder = path.join(base, "sketches");
  await rm(folder, { recursive: true });
  const entry = await startServer(await resolveLocation({ session: { workingDirectory: base } }));
  t.after(() => entry.close());
  assert.equal((await post(entry, "create-sketch", { name: "fresh" }, { Origin: "null" })).status, 403);
  assert.equal((await post(entry, "create-sketch", { name: "../escape" })).status, 400);
  await assert.rejects(readdir(folder), { code: "ENOENT" });
  const results = await Promise.all([
    post(entry, "create-sketch", { name: "fresh" }),
    post(entry, "create-sketch", { name: "other" }),
  ]);
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.deepEqual((await entry.state()).sketches, ["fresh.js", "other.js"]);
  const fresh = await readSketch(folder, "fresh.js");
  await saveSketch(folder, "fresh.js", "// first autosave\n", fresh.version);
  assert.equal(await readFile(path.join(folder, "fresh.js"), "utf8"), "// first autosave\n");
  assert.equal((await post(entry, "create-sketch", { name: "fresh" })).status, 409);
  await rm(folder, { recursive: true });
  await symlink(base, folder);
  assert.equal((await post(entry, "create-sketch", { name: "escape" })).status, 403);
  await assert.rejects(readFile(path.join(base, "escape.js")), { code: "ENOENT" });
});

test("unknown working folder offers only opening an existing folder", async t => {
  const entry = await startServer(await resolveLocation({}));
  t.after(() => entry.close());
  const state = await entry.state();
  assert.equal(state.status, "missing_folder");
  assert.equal(state.base, null);
  assert.equal(state.canCreate, false);
  assert.equal((await post(entry, "create-folder", {})).status, 409);
  assert.equal((await post(entry, "create-sketch", { name: "fresh" })).status, 409);
});

test("a removed or replaced chosen folder returns to setup and can be restored or replaced", async t => {
  const base = await fixture(t);
  const selected = path.join(base, "chosen");
  await rm(path.join(base, "sketches"), { recursive: true });
  await mkdir(selected);
  await writeFile(path.join(selected, "art.js"), "let art;");
  const entry = await startServer({ base, folder: selected });
  t.after(() => entry.close());
  assert.equal((await entry.state()).status, "ready");

  await rm(selected, { recursive: true });
  let state = await entry.state();
  assert.equal(state.status, "missing_folder");
  assert.equal(state.canCreate, true);
  assert.match(state.message, /selected sketches folder is invalid or no longer available/);
  assert.equal((await fetch(entry.url + "sketch?name=art.js")).status, 409);

  await mkdir(selected);
  await writeFile(path.join(selected, "art.js"), "restored");
  assert.deepEqual((await entry.state()).sketches, ["art.js"]);
  await rm(selected, { recursive: true });
  await symlink(base, selected);
  assert.equal((await entry.state()).status, "missing_folder");

  const created = await (await post(entry, "create-folder", {})).json();
  assert.equal(created.folder, path.join(base, "sketches"));
  assert.deepEqual(created.sketches, []);
});

test("setup does not offer to create an existing default folder, and invalid switching keeps the current location", async t => {
  const base = await fixture(t);
  const missing = path.join(base, "removed");
  const entry = await startServer({ base, folder: missing });
  t.after(() => entry.close());
  const state = await entry.state();
  assert.equal(state.status, "missing_folder");
  assert.equal(state.canCreate, false);
  assert.match(state.message, /such as .*sketches/);
  assert.equal((await post(entry, "create-folder", {})).status, 409);

  const response = await post(entry, "choose-folder", { path: "relative" });
  assert.equal(response.status, 400);
  assert.equal((await entry.state()).status, "missing_folder");
});

test("saves real files, truncates, and rejects stale and concurrent writes", async t => {
  const parent = await fixture(t);
  const root = path.join(parent, "sketches");
  const before = await readSketch(root, "demo.js");
  const after = await saveSketch(root, "demo.js", "let x=2;", before.version);
  assert.equal(await readFile(path.join(root, "demo.js"), "utf8"), "let x=2;");
  assert.notEqual(after.version, before.version);
  await assert.rejects(saveSketch(root, "demo.js", "lost", before.version), { status: 409 });
  const results = await Promise.allSettled([
    saveSketch(root, "demo.js", "one", after.version),
    saveSketch(root, "demo.js", "two", after.version),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  const current = await readSketch(root, "demo.js");
  await writeFile(path.join(root, "demo.js"), "external");
  await assert.rejects(saveSketch(root, "demo.js", "mine", current.version), { status: 409 });
});

test("rejects traversal, symlink escapes, oversized and invalid inputs", async t => {
  const parent = await fixture(t);
  const root = path.join(parent, "sketches");
  await writeFile(path.join(parent, "outside.js"), "private");
  await symlink(path.join(parent, "outside.js"), path.join(root, "escape.js"));
  await symlink(parent, path.join(root, "escape-dir"));
  for (const name of ["../outside.js", "/outside.js", "nested/../../outside.js", "nested\\other.js", "escape.js", "escape-dir/outside.js"]) {
    await assert.rejects(readSketch(root, name));
  }
  await assert.rejects(saveSketch(root, "demo.js", "x".repeat(1024 * 1024 + 1), "v"), { status: 400 });
  await writeFile(path.join(root, "large.js"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(readSketch(root, "large.js"), { status: 400 });
  await assert.rejects(readSketch(root, 123), { status: 400 });
});

test("loopback server requires capability and authorized origin for writes", async t => {
  const base = await fixture(t);
  const root = path.join(base, "sketches");
  const entry = await startServer({ base });
  t.after(() => entry.close());
  const url = new URL(entry.url);
  const token = url.pathname.split("/")[1];
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal((await fetch(url.origin + "/state")).status, 404);
  const state = await (await fetch(entry.url + "state")).json();
  assert.equal(state.folder, root);
  assert.equal(state.sketches.length, 2);
  assert.notEqual(new URL(state.previewUrl).origin, url.origin);
  assert.equal(new URL(state.previewUrl).pathname, "/");
  const sketch = await (await fetch(entry.url + "sketch?name=demo.js")).json();
  const headers = { "Content-Type": "application/json", "X-P5-Token": token };
  const body = JSON.stringify({ ...sketch, content: "updated" });
  assert.equal((await fetch(entry.url + "save", { method: "POST", headers, body })).status, 403);
  headers.Origin = "null";
  assert.equal((await fetch(entry.url + "save", { method: "POST", headers, body })).status, 403);
  headers.Origin = url.origin;
  assert.equal((await fetch(entry.url + "save", { method: "POST", headers, body })).status, 200);
  assert.equal((await fetch(entry.url + "save", { method: "POST", headers, body })).status, 409);
  assert.equal((await fetch(entry.url + "save", { method: "POST", headers, body: "null" })).status, 400);
  const page = await fetch(entry.url);
  assert.match(await page.text(), /sandbox="allow-scripts"/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /style-src 'self' 'unsafe-inline'/, "host theme <style> injection must be allowed");
  assert.match(csp, /script-src 'self';/);
  const script = await fetch(entry.url + "vendor/editor.js");
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.match(await script.text(), /export\s*\{/);
});
