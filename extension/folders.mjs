import { chooseSketchesFolder, workingFolder } from "./sketches.mjs";

export async function resolveLocation(ctx) {
  const cwd = ctx.session?.workingDirectory;
  const base = cwd ? await workingFolder(cwd) : undefined;
  const explicit = ctx.input?.folderPath ?? ctx.input?.repositoryPath;
  if (explicit !== undefined) return { base, folder: await chooseSketchesFolder(explicit) };
  return { base };
}
