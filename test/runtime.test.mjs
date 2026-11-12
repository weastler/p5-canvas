import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime, P5_INTEGRITY, readRuntimeArchive, registryUrl, runtimeStorage } from "../extension/runtime.mjs";
import { startServer } from "../extension/server.mjs";

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "p5-runtime-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, "sketches");
  await mkdir(cwd);
  const calls = [];
  const runNpm = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "config") return { stdout: "https://configured.example/npm/\n" };
    const destination = args.find(arg => arg.startsWith("--pack-destination=")).slice("--pack-destination=".length);
    await writeFile(path.join(destination, "p5-1.11.11.tgz"), "verified fixture");
    return { stdout: "[]" };
  };
  const unpack = bytes => {
    assert.equal(bytes.toString(), "verified fixture");
    return { source: "window.p5 = function() {};", license: "fixture license" };
  };
  return { home, cwd, runNpm, unpack, calls };
}

test("runtime honors npm configuration, verifies before caching, and reopens offline", async t => {
  const options = await fixture(t);
  let verified = 0;
  const runtime = createRuntime({ ...options, unpack: bytes => { verified++; return options.unpack(bytes); } });
  assert.equal((await runtime.status()).status, "missing");
  const results = await Promise.all([runtime.acquire(), runtime.acquire()]);
  assert.ok(results.every(result => result.status === "ready"));
  assert.equal(verified, 1);
  const pack = options.calls.find(call => call.args[0] === "pack");
  assert.equal(pack.args[1], "https://configured.example/npm/p5/-/p5-1.11.11.tgz");
  assert.ok(pack.args.includes("--ignore-scripts"));
  assert.ok(pack.args.includes("--registry=https://configured.example/npm/"));
  assert.equal(pack.options.cwd, options.cwd, "npm reads the active workspace's configuration");
  assert.deepEqual(await readdir(options.cwd), [], "no files are written in the sketches/workspace");
  assert.equal(path.dirname(results[0].cache), runtimeStorage(options.home));
  assert.ok(path.relative(path.join(options.home, "extensions"), results[0].cache).startsWith(".."),
    "runtime data stays outside every shareable extension folder");
  const offline = createRuntime({ ...options, runNpm: () => { throw new Error("npm must not run offline"); } });
  assert.equal((await offline.acquire()).status, "ready");
  assert.equal(offline.source, runtime.source);
  assert.equal(offline.license, "fixture license");
});

test("registry override persists, resets to npm config, and never falls back on download failure", async t => {
  const options = await fixture(t);
  const runtime = createRuntime({ ...options, runNpm: async args => { options.calls.push(args); throw new Error("secret npm stderr"); } });
  await runtime.configure("https://proxy.example/npm");
  await assert.rejects(runtime.acquire(), /proxy\.example.*No other registry was tried/);
  assert.equal(options.calls.length, 1);
  assert.equal(options.calls[0][0], "pack");
  const failed = await runtime.status();
  assert.equal(failed.status, "error");
  assert.ok(!failed.error.includes("secret"));
  assert.deepEqual((await readdir(path.dirname(failed.cache))).sort(), ["registry.json"], "failed staging data is removed");
  const reopened = createRuntime(options);
  assert.equal((await reopened.status()).registry, "https://proxy.example/npm/");
  await reopened.configure("");
  await reopened.acquire();
  assert.equal(options.calls.at(-1).args[1], "https://configured.example/npm/p5/-/p5-1.11.11.tgz");
});

test("unconfigured npm uses its public default; invalid configuration does not fall back", async t => {
  const options = await fixture(t);
  const runtime = createRuntime({ ...options, runNpm: (args, opts) => args[0] === "config"
    ? Promise.resolve({ stdout: "https://registry.npmjs.org/\n" }) : options.runNpm(args, opts) });
  await runtime.acquire();
  assert.equal(options.calls[0].args[1], "https://registry.npmjs.org/p5/-/p5-1.11.11.tgz");
  await rm((await runtime.status()).cache);
  const invalid = createRuntime({ ...options, runNpm: async args => {
    assert.equal(args[0], "config");
    return { stdout: "not a URL" };
  } });
  await assert.rejects(invalid.acquire(), /HTTPS npm registry URL/);
});

test("production verifier rejects altered downloads and cache entries", async t => {
  const options = await fixture(t);
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(P5_INTEGRITY, lock.packages["node_modules/p5"].integrity);
  assert.throws(() => readRuntimeArchive(Buffer.from("untrusted package")), /integrity verification failed/);
  const runtime = createRuntime({ ...options, unpack: readRuntimeArchive });
  await assert.rejects(runtime.acquire(), /integrity verification failed/);
  const state = await runtime.status();
  await assert.rejects(readFile(state.cache), { code: "ENOENT" });
  await writeFile(state.cache, "corrupted cache");
  const reopened = createRuntime({ ...options, unpack: readRuntimeArchive });
  assert.equal((await reopened.status()).status, "error");
  assert.equal(reopened.source, undefined);
  await assert.rejects(reopened.acquire(), /integrity verification failed/);
});

test("registry settings validate URLs and can repair malformed saved settings", async t => {
  for (const value of ["http://proxy.example", "https://user:pass@proxy.example", "https://proxy.example?token=secret", "file:///tmp", ""]) {
    assert.throws(() => registryUrl(value));
  }
  const options = await fixture(t);
  const runtime = createRuntime(options);
  await runtime.configure("https://proxy.example/npm");
  const settings = path.join(path.dirname((await runtime.status()).cache), "registry.json");
  await writeFile(settings, "{");
  const broken = createRuntime(options);
  await assert.rejects(broken.acquire(), /registry setting/);
  await broken.configure("");
  assert.equal((await broken.acquire()).status, "ready");
});

test("runtime API is capability/origin protected and failed acquisition preserves sketches", async t => {
  const options = await fixture(t);
  const runtime = createRuntime({ ...options, runNpm: async () => { throw new Error("offline"); } });
  const entry = await startServer({ base: options.cwd }, { runtime });
  t.after(() => entry.close());
  const url = new URL(entry.url);
  const token = url.pathname.split("/")[1];
  const post = (body, headers = {}) => fetch(entry.url + "runtime", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin, "X-P5-Token": token, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post({}, { Origin: "https://untrusted.example" })).status, 403);
  assert.equal((await post({ registry: 12 })).status, 400);
  const failure = await post({ registry: "https://proxy.example" });
  assert.equal(failure.status, 503);
  assert.match((await failure.json()).error, /No other registry/);
  assert.deepEqual(await readdir(options.cwd), []);
  const preview = await fetch((await entry.state()).previewUrl);
  assert.equal(preview.status, 503);
  assert.match(preview.headers.get("content-security-policy"), /connect-src 'none'/);
});

test("runtime copies verified legacy data out of the extension folder without removing it", async t => {
  const options = await fixture(t);
  const legacy = path.join(options.home, "extensions/p5-canvas/artifacts/runtime");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "p5-1.11.11.tgz"), "verified fixture");
  await writeFile(path.join(legacy, "registry.json"), '{"registry":"https://proxy.example/npm/"}');
  const runtime = createRuntime({ ...options, runNpm: () => { throw new Error("npm must not run"); } });
  const state = await runtime.acquire();
  assert.equal(state.status, "ready");
  assert.equal(state.registry, "https://proxy.example/npm/");
  assert.equal(path.dirname(state.cache), runtimeStorage(options.home));
  assert.equal(await readFile(state.cache, "utf8"), "verified fixture");
  assert.deepEqual((await readdir(legacy)).sort(), ["p5-1.11.11.tgz", "registry.json"], "legacy data is preserved");
});

test("runtime ignores an unverified legacy archive", async t => {
  const options = await fixture(t);
  const legacy = path.join(options.home, "extensions/p5-canvas/artifacts/runtime");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "p5-1.11.11.tgz"), "tampered");
  const runtime = createRuntime(options);
  assert.equal((await runtime.status()).status, "missing");
  assert.equal(await readFile(path.join(legacy, "p5-1.11.11.tgz"), "utf8"), "tampered");
});

test("invalid legacy registry settings fail closed and can be repaired without changing the original", async t => {
  const options = await fixture(t);
  const legacy = path.join(options.home, "extensions/p5-canvas/artifacts/runtime");
  await mkdir(legacy, { recursive: true });
  const settings = path.join(legacy, "registry.json");
  await writeFile(settings, "{");
  const runtime = createRuntime(options);
  assert.match((await runtime.status()).error, /legacy extension registry setting/);
  await assert.rejects(runtime.acquire(), /legacy extension registry setting/);
  assert.equal(options.calls.length, 0, "an invalid setting must not fall back to npm's default");
  await runtime.configure("https://proxy.example/npm/");
  assert.equal((await runtime.acquire()).status, "ready");
  assert.equal(options.calls[0].args[1], "https://proxy.example/npm/p5/-/p5-1.11.11.tgz");
  assert.equal(await readFile(settings, "utf8"), "{", "the legacy setting is preserved");
});
