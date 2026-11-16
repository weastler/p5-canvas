import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { listSketches, readSketch, saveSketch, createSketch, newSketchName, createVariation, sketchFilePath, findSketchesFolder, chooseSketchesFolder, isAvailableSketchesFolder, createSketchesFolder, MAX_BYTES, SketchError } from "./sketches.mjs";
import { startRunner } from "./runner.mjs";
import { createRuntime } from "./runtime.mjs";

export const MAX_EDITOR_SNAPSHOT_BYTES = 128 * 1024;
const SNAPSHOT_TIMEOUT_MS = 5000;
const unavailable = message => ({ status: "unavailable", message });
const assets = new Map([
  ["", ["index.html", "text/html; charset=utf-8"]],
  ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["vendor/editor.js", ["vendor/editor.js", "text/javascript; charset=utf-8"]],
  ["style.css", ["style.css", "text/css; charset=utf-8"]],
]);
// location: { base } is the session's working folder; { folder } is a chosen sketches folder that wins.
export async function startServer(initial, { runtime = createRuntime({ cwd: initial.base }) } = {}) {
  let location = { ...initial };
  const runner = await startRunner(runtime);
  const previewOrigin = new URL(runner.url).origin;
  const token = randomBytes(32).toString("hex");
  let origin;
  const editorClients = new Map();
  const snapshotRequests = new Map();
  const finishSnapshot = (id, result) => {
    const request = snapshotRequests.get(id);
    if (!request) return false;
    snapshotRequests.delete(id);
    clearTimeout(request.timer);
    request.resolve(result);
    return true;
  };
  const cancelSnapshots = (clientId, message) => {
    for (const [id, request] of snapshotRequests) {
      if (request.clientId === clientId) finishSnapshot(id, unavailable(message));
    }
  };
  const currentSketch = () => {
    const client = [...editorClients.entries()].at(-1);
    if (!client) return Promise.resolve(unavailable("The canvas editor is not connected. Open the panel and retry."));
    const [clientId, response] = client;
    return new Promise(resolve => {
      const requestId = randomBytes(16).toString("hex");
      const timer = setTimeout(() => finishSnapshot(requestId, unavailable("The canvas editor did not respond. Retry after it is ready.")), SNAPSHOT_TIMEOUT_MS);
      snapshotRequests.set(requestId, { clientId, resolve, timer });
      try {
        response.write(`event: snapshot\ndata: ${JSON.stringify({ requestId, clientId, maxBytes: MAX_EDITOR_SNAPSHOT_BYTES })}\n\n`);
      } catch (error) {
        finishSnapshot(requestId, unavailable(`Could not contact the canvas editor: ${error.message}`));
      }
    });
  };
  // Resolved on every request so a sketches folder created after opening is picked up.
  const hasChosenFolder = () => Object.hasOwn(location, "folder");
  const folder = async () => hasChosenFolder()
    ? (await isAvailableSketchesFolder(location.folder) ? location.folder : null)
    : (location.base ? await findSketchesFolder(location.base) : null);
  const state = async () => {
    const current = await folder();
    if (!current && !hasChosenFolder() && location.base) {
      return {
        status: "ready", base: location.base, folder: path.join(location.base, "sketches"),
        sketches: [], previewUrl: runner.url, pendingFolder: true,
      };
    }
    if (!current) {
      const defaultFolder = hasChosenFolder() && location.base ? await findSketchesFolder(location.base) : null;
      const canCreate = Boolean(location.base && !defaultFolder);
      let message;
      if (hasChosenFolder()) {
        const next = canCreate
          ? `Create a sketches folder in ${location.base}, restore the selected folder, or open another folder.`
          : `Restore it or open an existing folder${defaultFolder ? `, such as ${defaultFolder}` : ""}.`;
        const selected = typeof location.folder === "string" && location.folder ? `: ${location.folder}` : "";
        message = `The selected sketches folder is invalid or no longer available${selected}. ${next}`;
      } else {
        message = location.base
          ? `No sketches folder found in ${location.base}. Create one there, or open an existing folder with your sketches.`
          : "No working folder is known for this session. Open an existing folder with your sketches.";
      }
      return {
        status: "missing_folder", base: location.base ?? null, folder: null, sketches: [], previewUrl: null, canCreate, message,
      };
    }
    return { status: "ready", base: location.base ?? null, folder: current, sketches: await listSketches(current), previewUrl: runner.url };
  };
  const readJson = async req => {
    if (req.headers.origin !== origin || req.headers["x-p5-token"] !== token ||
        req.headers["content-type"] !== "application/json") throw new SketchError(403, "Request was not authorized.");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BYTES * 6 + 4096) throw new SketchError(413, "Request too large.");
    }
    let input;
    try { input = JSON.parse(body); } catch { throw new SketchError(400, "Invalid JSON."); }
    if (!input || typeof input !== "object") throw new SketchError(400, "Expected a JSON object.");
    return input;
  };
  const required = async () => {
    const current = await folder();
    if (!current) throw new SketchError(409, "Create or open a sketches folder first.");
    return current;
  };
  const receiveSnapshot = async input => {
    const { requestId, clientId } = input;
    const pending = snapshotRequests.get(requestId);
    if (!pending || pending.clientId !== clientId || !editorClients.has(clientId)) {
      throw new SketchError(409, "The editor snapshot request has expired.");
    }
    let result;
    if (input.status === "no_sketch") {
      result = { status: "no_sketch", message: "No sketch is selected." };
    } else if (input.status === "unavailable") {
      result = unavailable("The sketch selection is changing. Retry when the editor is ready.");
    } else {
      if (input.status !== "ready" && input.status !== "too_large") throw new SketchError(400, "Invalid editor snapshot status.");
      const saveStatus = input.saveStatus;
      if (!saveStatus || typeof saveStatus.dirty !== "boolean" || typeof saveStatus.saving !== "boolean" ||
          typeof saveStatus.conflict !== "boolean" || (saveStatus.error !== null && typeof saveStatus.error !== "string")) {
        throw new SketchError(400, "Invalid editor save status.");
      }
      let current;
      try { current = await folder(); }
      catch (error) { result = unavailable(`Could not verify the sketches folder: ${error.message}`); }
      if (!result && (!current || input.folder !== current)) {
        result = unavailable("The sketches folder changed or is unavailable. Retry after the viewer refreshes.");
      }
      if (!result) {
        const file = sketchFilePath(current, input.name);
        let sizeBytes;
        if (input.status === "too_large") {
          sizeBytes = input.sizeBytes;
          if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= MAX_EDITOR_SNAPSHOT_BYTES) {
            throw new SketchError(400, "Invalid editor snapshot size.");
          }
        } else {
          if (typeof input.content !== "string") throw new SketchError(400, "Invalid editor snapshot content.");
          sizeBytes = Buffer.byteLength(input.content);
        }
        const save = { dirty: saveStatus.dirty, saving: saveStatus.saving, conflict: saveStatus.conflict, error: saveStatus.error };
        result = sizeBytes > MAX_EDITOR_SNAPSHOT_BYTES
          ? { status: "too_large", path: file, sizeBytes, limitBytes: MAX_EDITOR_SNAPSHOT_BYTES, saveStatus: save,
              message: "The selected sketch exceeds the action's size limit; no code was returned." }
          : { status: "ready", path: file, content: input.content, saveStatus: save };
      }
    }
    if (snapshotRequests.get(requestId) !== pending || !editorClients.has(clientId)) {
      throw new SketchError(409, "The editor snapshot request has expired.");
    }
    finishSnapshot(requestId, result);
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // The host applies app theme tokens through managed inline <style> elements; scripts stay same-origin only.
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src about: ${previewOrigin}; base-uri 'none'; form-action 'none'`);
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.host !== new URL(origin).host) throw new SketchError(403, "Invalid host.");
      const url = new URL(req.url, origin);
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) throw new SketchError(404, "Not found.");
      const route = url.pathname.slice(prefix.length);
      if (req.method === "GET" && assets.has(route)) {
        const [file, type] = assets.get(route);
        const content = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, { "Content-Type": type });
        res.end(content);
      } else if (req.method === "GET" && route === "state") {
        json(200, await state());
      } else if (req.method === "GET" && route === "runtime") {
        json(200, await runtime.status());
      } else if (req.method === "POST" && route === "runtime") {
        const input = await readJson(req);
        if (Object.hasOwn(input, "registry")) {
          if (typeof input.registry !== "string") throw new SketchError(400, "Registry must be a URL or an empty string.");
          await runtime.configure(input.registry.trim());
        }
        try { json(200, await runtime.acquire()); }
        catch (error) { throw new SketchError(503, error.message); }
      } else if (req.method === "GET" && route === "sketch") {
        json(200, await readSketch(await required(), url.searchParams.get("name")));
      } else if (req.method === "GET" && route === "editor-events") {
        const previous = [...editorClients.keys()].at(-1);
        if (previous) cancelSnapshots(previous, "The canvas editor reconnected. Retry.");
        const clientId = randomBytes(16).toString("hex");
        editorClients.set(clientId, res);
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Connection": "keep-alive" });
        res.write(": connected\n\n");
        res.on("close", () => {
          editorClients.delete(clientId);
          cancelSnapshots(clientId, "The canvas editor disconnected. Open the panel and retry.");
        });
      } else if (req.method === "POST" && route === "editor-snapshot") {
        await receiveSnapshot(await readJson(req));
        json(200, { received: true });
      } else if (req.method === "POST" && route === "save") {
        const input = await readJson(req);
        json(200, await saveSketch(await required(), input.name, input.content, input.version));
      } else if (req.method === "POST" && route === "create-sketch") {
        const input = await readJson(req);
        const name = newSketchName(input.name);
        let current = await folder();
        if (!current && !hasChosenFolder() && location.base) {
          try { current = await createSketchesFolder(location.base); }
          catch (error) {
            if (error.status !== 409) throw error;
            current = await findSketchesFolder(location.base);
            if (!current) throw error;
          }
        }
        if (!current) throw new SketchError(409, "Open a sketches folder first.");
        json(201, await createSketch(current, name));
      } else if (req.method === "POST" && route === "create-variation") {
        const input = await readJson(req);
        json(201, await createVariation(await required(), input.name, input.content));
      } else if (req.method === "POST" && route === "create-folder") {
        await readJson(req);
        if (!location.base) throw new SketchError(409, "No working folder is known. Open an existing folder instead.");
        if (await folder()) throw new SketchError(409, "A sketches folder is already open.");
        const created = await createSketchesFolder(location.base);
        if (hasChosenFolder()) {
          location = { ...location, folder: created };
        }
        json(200, await state());
      } else if (req.method === "POST" && route === "choose-folder") {
        const chosen = await chooseSketchesFolder((await readJson(req)).path);
        location = { ...location, folder: chosen };
        json(200, await state());
      } else {
        throw new SketchError(404, "Not found.");
      }
    } catch (error) {
      const status = error.status ?? (error.code === "ENOENT" ? 404 : 500);
      json(status, { error: error.message });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) { await runner.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/${token}/`, state, currentSketch,
    configure: next => { location = { ...next }; },
    close: async () => {
      await Promise.all([runner.close(), new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })]);
    } };
}
