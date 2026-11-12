import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assertOwnedInstallation, shareRisks, writeRuntimePayload } from "./runtime-payload.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "extensions", "p5-canvas");
await assertOwnedInstallation(target);
await writeRuntimePayload(root, target);
console.log(`Installed personal extension: ${target}\nReload extensions in Copilot to activate it.`);
const risks = await shareRisks(target);
if (risks.length) {
  console.warn(`\nBefore sharing this extension as a gist, move these files out of ${target} (they were left untouched):`);
  for (const { file, reasons } of risks) console.warn(`  ${file}: ${reasons.join(", ")}`);
}
