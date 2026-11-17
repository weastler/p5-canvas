import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { startServer } from "./server.mjs";
import { resolveLocation } from "./folders.mjs";

const servers = new Map();
const folderInput = description => ({ type: "string", minLength: 1, description });

await joinSession({
  canvases: [createCanvas({
    id: "p5-sketches",
    displayName: "P5.js sketches",
    description: "Run sketches from the current folder's sketches directory live beside an autosaving JavaScript editor.",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: folderInput("Absolute path to a folder of sketches, or a folder containing a `sketches` folder. Defaults to the session's working folder."),
        repositoryPath: folderInput("Deprecated alias for folderPath."),
      },
      additionalProperties: false,
    },
    actions: [{
      name: "get_state",
      description: "List available sketches and the active sketches folder.",
      handler: async ({ instanceId }) => {
        const entry = servers.get(instanceId);
        if (!entry) throw new CanvasError("not_open", "Open the viewer first.");
        return entry.state();
      },
    }, {
      name: "get_current_sketch",
      description: "Read this canvas's selected sketch path, live editor text, and save/conflict status.",
      handler: async ({ instanceId }) => {
        const entry = servers.get(instanceId);
        if (!entry) throw new CanvasError("not_open", "Open the viewer first.");
        return entry.currentSketch();
      },
    }],
    open: async (ctx) => {
      try {
        const location = await resolveLocation(ctx);
        let entry = servers.get(ctx.instanceId);
        if (entry) entry.configure(location);
        else {
          entry = await startServer(location);
          servers.set(ctx.instanceId, entry);
        }
        return { title: "P5.js sketches", url: entry.url };
      } catch (error) {
        throw new CanvasError("p5_open_failed", error.message);
      }
    },
    onClose: async ({ instanceId }) => {
      const entry = servers.get(instanceId);
      if (entry) {
        servers.delete(instanceId);
        await entry.close();
      }
    },
  })],
});
