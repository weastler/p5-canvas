import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanPayload, assertOwnedInstallation, shareRisks, writeRuntimePayload } from "./runtime-payload.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--project")) {
  throw new Error("Usage: node scripts/prepare-extension.mjs [--project]");
}
const project = args[0] === "--project";
const parents = project ? [".github", "extensions"] : ["dist"];
let parent = root;
for (const name of parents) {
  parent = path.join(parent, name);
  try {
    if (!(await lstat(parent)).isDirectory()) throw new Error(`Extension parent must be a regular directory: ${parent}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(parent);
  }
}
const target = path.join(parent, "p5-canvas");
await assertOwnedInstallation(target);
await mkdir(target, { recursive: true });
await assertCleanPayload(target);
await writeRuntimePayload(root, target);
const risks = await shareRisks(target);
if (risks.length) {
  throw new Error(`Prepared extension is not shareable:\n${risks.map(({ file, reasons }) => `  ${file}: ${reasons.join(", ")}`).join("\n")}`);
}
console.log(`Prepared ${project ? "project-scoped" : "runtime-only"} extension: ${target}\nNo user state was included. Nothing has been uploaded.`);
