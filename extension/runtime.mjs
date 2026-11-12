import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

export const P5_VERSION = "1.11.11";
export const P5_INTEGRITY = "sha512-k58mfexvavFb+KNRpi70PbkKE2gCNiWQkzS4kVOyC2F9SKGgYy1jSO+JXZ24ikXV9OvZIAxGusiSVWEijYrmNg==";
const archiveName = `p5-${P5_VERSION}.tgz`;
const exec = promisify(execFile);

export function registryUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter an absolute HTTPS npm registry URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS registry URL without credentials, query parameters or fragments. Configure authentication in npm.");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

// Only read the two regular files we need; never extract package paths onto disk.
export function readRuntimeArchive(archive) {
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== P5_INTEGRITY) {
    throw new Error("p5.js package integrity verification failed. Retry with a trusted registry.");
  }
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(text(124, 136).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new Error("Invalid p5.js package archive.");
    }
    const name = text(0, 100);
    if (name === "package/lib/p5.min.js" || name === "package/license.txt") {
      if (!["0", ""].includes(text(156, 157)) || files.has(name)) throw new Error("Invalid p5.js package entry.");
      files.set(name, tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.get("package/lib/p5.min.js") || !files.get("package/license.txt")) {
    throw new Error("p5.js package is missing its runtime or license.");
  }
  return { source: files.get("package/lib/p5.min.js"), license: files.get("package/license.txt") };
}

export const runtimeStorage = home => path.join(home, "extension-data", "p5-canvas", "runtime");

async function exists(file) {
  try { await stat(file); return true; }
  catch (failure) { if (failure.code === "ENOENT") return false; throw failure; }
}

export function createRuntime({
  cwd = homedir(),
  home = process.env.COPILOT_HOME || path.join(homedir(), ".copilot"),
  runNpm = (args, options) => exec("npm", args, options),
  unpack = readRuntimeArchive,
} = {}) {
  // Kept outside extensions/ so gist sharing never walks downloaded binaries, npm logs or settings.
  const storage = runtimeStorage(home);
  const legacy = path.join(home, "extensions", "p5-canvas", "artifacts", "runtime");
  const archivePath = path.join(storage, archiveName);
  const settingsPath = path.join(storage, "registry.json");
  let registry = null;
  let runtime;
  let error = null;
  let task;
  let initialized;
  // Copy (never move) data written by earlier builds inside the shareable extension folder.
  const importLegacy = async () => {
    for (const [name, check] of [[archiveName, unpack], ["registry.json", data => {
      const { registry: value } = JSON.parse(data.toString("utf8"));
      if (value !== null) registryUrl(value);
    }]]) {
      const destination = path.join(storage, name);
      if (await exists(destination)) continue;
      let data;
      try { data = await readFile(path.join(legacy, name)); }
      catch (failure) { if (failure.code === "ENOENT") continue; throw failure; }
      try { check(data); } catch (failure) {
        if (name === archiveName) continue;
        throw new Error("Could not read the legacy extension registry setting. Save a registry setting to repair it.", { cause: failure });
      }
      await mkdir(storage, { recursive: true, mode: 0o700 });
      try { await writeFile(destination, data, { flag: "wx", mode: 0o600 }); }
      catch (failure) { if (failure.code !== "EEXIST") throw failure; }
    }
  };
  const npm = args => runNpm(args, { cwd, timeout: 90000, maxBuffer: 1024 * 1024, windowsHide: true });
  const initialize = () => initialized ??= (async () => {
    await importLegacy();
    try {
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      registry = settings.registry === null ? null : registryUrl(settings.registry);
    } catch (failure) {
      if (failure.code !== "ENOENT") throw new Error("Could not read the extension registry setting. Save a registry setting to repair it.", { cause: failure });
    }
    try { runtime = unpack(await readFile(archivePath)); }
    catch (failure) {
      if (failure.code !== "ENOENT") error = `Cached runtime is unavailable: ${failure.message}`;
    }
  })();
  const state = () => ({
    version: P5_VERSION, status: task ? "loading" : runtime ? "ready" : error ? "error" : "missing",
    registry, error, cache: archivePath,
  });
  const status = async () => {
    try { await initialize(); } catch (failure) { error = failure.message; }
    return state();
  };
  const acquire = async () => {
    if (task) { await task; return state(); }
    task = (async () => {
      let stage;
      try {
        await initialize();
        if (runtime) return;
        error = null;
        let selectedRegistry = registry;
        if (!selectedRegistry) {
          let result;
          try { result = await npm(["config", "get", "registry"]); }
          catch { throw new Error("Could not read npm configuration. Ensure npm is on PATH, then retry or set a registry URL."); }
          selectedRegistry = registryUrl(result.stdout.trim());
        }
        await mkdir(storage, { recursive: true, mode: 0o700 });
        stage = await mkdtemp(path.join(storage, "download-"));
        try {
          // A direct registry tarball URL avoids metadata pointing back to public npm.
          await npm(["pack", `${selectedRegistry}p5/-/${archiveName}`, "--ignore-scripts", "--json",
            `--registry=${selectedRegistry}`, `--pack-destination=${stage}`, `--cache=${path.join(storage, "npm-cache")}`,
            "--fetch-retries=0", "--fetch-timeout=20000", "--no-audit", "--no-fund"]);
        } catch {
          throw new Error(`Could not download p5.js ${P5_VERSION} from ${selectedRegistry}. Check connectivity and npm authentication, retry, or configure a registry proxy. No other registry was tried.`);
        }
        const downloaded = path.join(stage, archiveName);
        const verified = unpack(await readFile(downloaded));
        await rename(downloaded, archivePath);
        runtime = verified;
      } catch (failure) {
        error = failure.message;
        throw failure;
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true });
      }
    })();
    try { await task; } finally { task = null; }
    return state();
  };
  return {
    status, acquire,
    get source() { return runtime?.source; },
    get license() { return runtime?.license; },
    async configure(value) {
      if (task) throw new Error("Wait for the runtime download to finish before changing registries.");
      const next = value === "" ? null : registryUrl(value);
      await mkdir(storage, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(path.join(storage, "settings-"));
      try {
        await writeFile(path.join(stage, "registry.json"), JSON.stringify({ registry: next }) + "\n", { mode: 0o600 });
        await rename(path.join(stage, "registry.json"), settingsPath);
      } finally { await rm(stage, { recursive: true, force: true }); }
      registry = next;
      error = null;
      initialized = undefined;
      return status();
    },
  };
}
