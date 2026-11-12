import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import path from "node:path";

export const runtimeFiles = [
  "extension.mjs", "folders.mjs", "server.mjs", "sketches.mjs", "runner.mjs", "runtime.mjs",
  "index.html", "app.js", "style.css", "vendor/editor.js", "vendor/editor-licenses.txt",
  "LICENSE", "copilot-extension.json",
];
const manifest = { name: "p5-canvas", version: 1, source: "copilot-p5-canvas" };

export async function assertOwnedInstallation(target) {
  let info;
  try { info = await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Extension destination must be a regular directory.");
  let existing;
  try { existing = JSON.parse(await readFile(path.join(target, "copilot-extension.json"), "utf8")); }
  catch (error) { throw new Error("Refusing to overwrite an unmarked or invalid p5-canvas extension.", { cause: error }); }
  if (existing?.name !== manifest.name || existing.version !== manifest.version || existing.source !== manifest.source) {
    throw new Error("Existing extension belongs to another installation.");
  }
}

export async function writeRuntimePayload(root, target) {
  try {
    if (!(await lstat(path.join(target, "vendor"))).isDirectory()) {
      throw new Error("Runtime vendor destination must be a regular directory.");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(path.join(target, "vendor"), { recursive: true });
  for (const file of runtimeFiles) {
    const destination = path.join(target, file);
    try {
      if (!(await lstat(destination)).isFile()) throw new Error(`Refusing to overwrite a non-regular runtime file: ${file}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const file of runtimeFiles) {
    const destination = path.join(target, file);
    if (file === "copilot-extension.json") {
      await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
    } else {
      await copyFile(path.join(root, file === "LICENSE" ? file : `extension/${file}`), destination);
    }
  }
}

const shareableHidden = new Set([".gitignore", ".npmrc", ".nvmrc", ".node-version"]);
const skippedShareDirs = new Set(["node_modules", "dist", "build", ".git"]);
export const shareFileLimit = 1_000_000;
export const shareTotalLimit = 5_000_000;

// Mirrors the app's gist share selection to report files an upgrade left behind; it never changes them.
export async function shareRisks(target) {
  const risks = [];
  let total = 0;
  const walk = async prefix => {
    for (const item of await readdir(path.join(target, prefix), { withFileTypes: true })) {
      const file = prefix + item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (!skippedShareDirs.has(item.name) && (!item.name.startsWith(".") || item.name === ".github")) await walk(`${file}/`);
        continue;
      }
      if (!item.isFile() || (item.name.startsWith(".") && !shareableHidden.has(item.name))) continue;
      const data = await readFile(path.join(target, file));
      total += data.length;
      const reasons = [];
      if (!runtimeFiles.includes(file)) reasons.push(file.startsWith("artifacts/") ? "private extension data" : "not part of this version");
      if (data.length > shareFileLimit) reasons.push("larger than the gist file limit");
      if (!isUtf8(data)) reasons.push("binary");
      if (reasons.length) risks.push({ file, reasons });
    }
  };
  await walk("");
  if (total > shareTotalLimit) risks.push({ file: ".", reasons: ["larger than the gist total limit"] });
  return risks;
}

export async function assertCleanPayload(target, prefix = "") {
  for (const item of await readdir(path.join(target, prefix), { withFileTypes: true })) {
    const file = prefix + item.name;
    if (item.isDirectory() && file === "vendor") await assertCleanPayload(target, "vendor/");
    else if (!item.isFile() || !runtimeFiles.includes(file)) {
      throw new Error(`Distribution contains an unexpected file; preserve it elsewhere before rebuilding: ${file}`);
    }
  }
}
