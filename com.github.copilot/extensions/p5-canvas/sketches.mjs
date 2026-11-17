import { constants } from "node:fs";
import { lstat, mkdir, readdir, realpath, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const locks = new Map();
export class SketchError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new SketchError(400, `${label} must be an absolute folder path.`);
  }
  return value;
}
async function directory(value, label) {
  try {
    const canonical = await realpath(absolute(value, label));
    if ((await lstat(canonical)).isDirectory()) return canonical;
  } catch (error) {
    if (error.status || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
  }
  throw new SketchError(400, `${label} does not point to an existing folder: ${value}`);
}
export async function workingFolder(value) {
  const canonical = await directory(value, "Working folder");
  if (canonical === path.parse(canonical).root) throw new SketchError(400, "Choose a specific working folder, not the filesystem root.");
  return canonical;
}
// The conventional sketches folder under a working folder; null while it does not exist yet.
export async function findSketchesFolder(base) {
  let info;
  try { info = await lstat(path.join(await directory(base, "Working folder"), "sketches")); }
  catch (error) { if (error.code === "ENOENT" || error.status === 400) return null; throw error; }
  if (info.isSymbolicLink()) throw new SketchError(403, "The sketches folder must not be a symbolic link.");
  if (!info.isDirectory()) throw new SketchError(400, "The sketches path exists but is not a folder.");
  return realpath(path.join(base, "sketches"));
}
// A user-chosen folder: its `sketches` subfolder when present, otherwise the folder itself.
export async function chooseSketchesFolder(folder) {
  const canonical = await directory(folder, "Folder");
  if (canonical === path.parse(canonical).root) throw new SketchError(400, "Choose a specific folder, not the filesystem root.");
  return (await findSketchesFolder(canonical)) ?? canonical;
}
export async function isAvailableSketchesFolder(folder) {
  if (typeof folder !== "string" || !path.isAbsolute(folder) || folder.includes("\0") ||
      path.normalize(folder) === path.parse(folder).root) return false;
  try {
    const info = await lstat(folder);
    return info.isDirectory() && await realpath(folder) === folder;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}
export async function createSketchesFolder(base) {
  const canonical = await directory(base, "Working folder");
  const folder = path.join(canonical, "sketches");
  try { await mkdir(folder); }
  catch (error) {
    if (error.code === "EEXIST") throw new SketchError(409, "A sketches folder already exists.");
    throw error;
  }
  return realpath(folder);
}
function validateRelativePath(name) {
  if (typeof name !== "string" || name.includes("\\") || name.includes("\0") ||
      path.isAbsolute(name) || name.split("/").some(part => part === ".." || part === ".")) {
    throw new SketchError(400, "Invalid sketch path.");
  }
}
export function sketchFilePath(folder, name) {
  if (typeof name !== "string" || !name.endsWith(".js")) throw new SketchError(400, "Select a .js sketch.");
  validateRelativePath(name);
  return path.join(folder, ...name.split("/").filter(Boolean));
}
async function safePath(folder, name = "") {
  validateRelativePath(name);
  let current = folder;
  for (const part of name.split("/").filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new SketchError(403, "Symbolic links are not supported in sketches.");
  }
  const resolved = await realpath(current);
  if (resolved !== folder && !resolved.startsWith(folder + path.sep)) throw new SketchError(403, "Sketch is outside the sketches folder.");
  return resolved;
}
export async function listSketches(root) {
  let directory;
  try { directory = await safePath(root); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  let seen = 0;
  async function visit(dir, prefix = "") {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++seen > MAX_ENTRIES) throw new SketchError(400, "This folder has too many files. Choose a dedicated sketches folder.");
      const name = prefix + item.name;
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      if (item.isDirectory()) await visit(await safePath(root, name), name + "/");
      else if (item.isFile() && name.endsWith(".js")) result.push(name);
    }
  }
  await visit(directory);
  return result.sort();
}
const version = (content) => createHash("sha256").update(content).digest("hex");
const STARTER = "function setup() {\n  createCanvas(640, 480);\n}\n\nfunction draw() {\n  background(240);\n  circle(width / 2, height / 2, 100);\n}\n";
// Creates exclusively so an existing file is never overwritten; returns null if the name is taken.
async function writeNewSketch(root, name, content) {
  if (!await isAvailableSketchesFolder(root)) throw new SketchError(409, "The sketches folder is no longer available.");
  const filename = sketchFilePath(root, name);
  await safePath(root, path.posix.dirname(name) === "." ? "" : path.posix.dirname(name));
  let handle;
  try { handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666); }
  catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    const current = await lstat(await safePath(root, name));
    if (current.ino !== info.ino || current.dev !== info.dev || !await isAvailableSketchesFolder(root)) {
      throw new SketchError(409, "Sketch path changed while creating.");
    }
    await handle.writeFile(content);
    await handle.sync();
    return { name, content, version: version(content) };
  } finally { await handle.close(); }
}
export function newSketchName(input) {
  const stem = typeof input === "string" ? input.trim().replace(/\.js$/i, "") : "";
  const name = stem + ".js";
  if (!/^[A-Za-z0-9_-][A-Za-z0-9 _-]*$/.test(stem) || name.length > 128) {
    throw new SketchError(400, "Use a sketch name of up to 128 characters with letters, numbers, spaces, hyphens or underscores, optionally ending in .js.");
  }
  return name;
}
export async function createSketch(root, input) {
  const name = newSketchName(input);
  const created = await writeNewSketch(root, name, STARTER);
  if (!created) throw new SketchError(409, `A file named "${name}" already exists. Choose another name.`);
  return created;
}
export async function createVariation(root, source, content) {
  sketchFilePath(root, source);
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) {
    throw new SketchError(400, "Sketch must be text of at most 1 MiB.");
  }
  const base = source.slice(0, -".js".length).replace(/-v\d+$/, "");
  // A discoverable folder holds at most MAX_ENTRIES files, so a free number exists within this range.
  for (let n = 2; n <= MAX_ENTRIES + 2; n++) {
    const created = await writeNewSketch(root, `${base}-v${n}.js`, content);
    if (created) return created;
  }
  throw new SketchError(409, `Too many variations of ${base}.js. Rename or remove some first.`);
}
async function fileHandle(root, name, writable = false) {
  if (typeof name !== "string" || !name.endsWith(".js")) throw new SketchError(400, "Select a .js sketch.");
  const filename = await safePath(root, name);
  const handle = await open(filename, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new SketchError(400, "Sketch must be a regular JavaScript file of at most 1 MiB.");
    const current = await lstat(await safePath(root, name));
    if (current.ino !== info.ino || current.dev !== info.dev) throw new SketchError(409, "Sketch path changed while opening.");
    return { handle, filename, info };
  } catch (error) { await handle.close(); throw error; }
}
export async function readSketch(root, name) {
  const { handle } = await fileHandle(root, name);
  try {
    const content = await handle.readFile("utf8");
    return { name, content, version: version(content) };
  } finally { await handle.close(); }
}
export async function saveSketch(root, name, content, expectedVersion) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES || typeof expectedVersion !== "string") {
    throw new SketchError(400, "A version and script of at most 1 MiB are required.");
  }
  const key = root + "/" + name;
  const previous = locks.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const { handle, info } = await fileHandle(root, name, true);
    try {
      const before = await handle.readFile("utf8");
      if (version(before) !== expectedVersion) throw new SketchError(409, "File changed on disk. Choose which version to keep.");
      const current = await lstat(await safePath(root, name));
      const latest = await handle.stat();
      if (current.ino !== info.ino || current.dev !== info.dev || latest.mtimeMs !== info.mtimeMs || latest.size !== info.size) {
        throw new SketchError(409, "File changed while saving. Review the disk version.");
      }
      const bytes = Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!bytesWritten) throw new Error("Unable to write the sketch.");
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
      return { name, content, version: version(content) };
    } finally { await handle.close(); }
  });
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
}
