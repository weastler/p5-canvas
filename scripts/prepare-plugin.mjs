import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOwnedInstallation, runtimeFiles, writeRuntimePayload } from "./runtime-payload.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(root, "dist", "plugin");
const runtimePath = "com.github.copilot/extensions/p5-canvas";
const directories = new Set([
  "assets", "com.github.copilot", "com.github.copilot/extensions", runtimePath, `${runtimePath}/vendor`,
]);
const files = new Set(["plugin.json", "LICENSE", "assets/preview.png",
  ...runtimeFiles.map(file => `${runtimePath}/${file}`)]);
const sourceManifest = path.join(root, "packaging", "plugin.json");
const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    || manifest.name !== "p5-canvas" || manifest.version !== packageInfo.version
    || manifest.repository !== "https://github.com/weastler/p5-canvas"
    || manifest.extensions?.["com.github.copilot"]?.logo !== "assets/preview.png") {
  throw new Error("Plugin metadata is invalid or its version does not match package.json.");
}

async function ensureDirectory(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Plugin destination must be a regular directory: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory);
  }
}

async function assertCleanPlugin(directory, prefix = "") {
  for (const item of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = prefix + item.name;
    if (item.isDirectory() && directories.has(file)) await assertCleanPlugin(directory, `${file}/`);
    else if (!item.isFile() || !files.has(file)) {
      throw new Error(`Plugin distribution contains an unexpected file; preserve it elsewhere before rebuilding: ${file}`);
    }
  }
}

await ensureDirectory(path.join(root, "dist"));
let exists = true;
try {
  if (!(await lstat(target)).isDirectory()) throw new Error("Plugin destination must be a regular directory.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  exists = false;
}
if (exists) {
  let existing;
  try { existing = JSON.parse(await readFile(path.join(target, "plugin.json"), "utf8")); }
  catch (error) { throw new Error("Refusing to overwrite an unmarked or invalid plugin distribution.", { cause: error }); }
  if (existing?.$schema !== manifest.$schema || existing.name !== manifest.name || existing.repository !== manifest.repository) {
    throw new Error("Existing plugin distribution belongs to another installation.");
  }
  await assertCleanPlugin(target);
  await assertOwnedInstallation(path.join(target, runtimePath));
} else {
  await mkdir(target);
}

await copyFile(sourceManifest, path.join(target, "plugin.json"));
for (const directory of directories) await ensureDirectory(path.join(target, directory));
await copyFile(path.join(root, "LICENSE"), path.join(target, "LICENSE"));
await copyFile(path.join(root, "assets", "preview.png"), path.join(target, "assets", "preview.png"));
await writeRuntimePayload(root, path.join(target, runtimePath));
console.log(`Prepared Agent Plugins 1.0 package: ${target}\nNo user state was included. Nothing has been uploaded.`);
