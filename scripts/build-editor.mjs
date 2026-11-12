import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "extension", "vendor");
await mkdir(vendor, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["extension/editor-entry.js"],
  outfile: "extension/vendor/editor.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
});
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index < 0) continue;
  const end = index + (parts[index + 1].startsWith("@") ? 3 : 2);
  packages.add(path.resolve(root, ...parts.slice(0, end)));
}
const licenses = [];
for (const folder of [...packages].sort()) {
  const manifest = JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"));
  const name = (await readdir(folder)).find(file => /^licen[cs]e(?:\..*)?$/i.test(file));
  if (!name) throw new Error(`Missing license for ${manifest.name}`);
  const license = await readFile(path.join(folder, name), "utf8");
  licenses.push(`${manifest.name}@${manifest.version}\n\n${license.trim()}`);
}
await writeFile(path.join(vendor, "editor-licenses.txt"), licenses.join("\n\n---\n\n") + "\n");
