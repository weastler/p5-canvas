import { createEditor, createControlsPanel } from "./vendor/editor.js";

const $ = id => document.getElementById(id);
let active = null;
let root = "";
let dirty = false;
let saving = false;
let saveTask = null;
let conflict = false;
let saveError = null;
let timer;
let previewTimer;
let selecting = false;
let previewUrl;
let polling = false;
let choosing = false;
let creating = false;
let changingFolder = false;
let runtimeReady = false;
const token = location.pathname.split("/")[1];
const draftKey = name => `p5-draft:${root}:${name}`;
const drafts = new Map();
let lastBackground;
const editor = createEditor($("editor"), () => {
  refreshParameters();
  dirty = true;
  remember();
  status(conflict ? "Conflict - draft kept" : "Unsaved");
  clearTimeout(timer);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(run, 250);
  timer = setTimeout(() => save().catch(report), 600);
});
const parameters = createControlsPanel($("parameters"), $("parameters-help"), (source, control, value) => {
  if (!active || selecting || creating || changingFolder) throw new Error("Wait for the sketch to finish opening.");
  editor.changeControl(source, control, value);
});
function refreshParameters() {
  parameters.render(editor.getValue(), Boolean(active) && !selecting && !creating && !changingFolder);
}
function setEditor(content) { editor.setValue(content); refreshParameters(); }
function notice(text) { $("notice").textContent = text; }
function status(text) { $("save-status").textContent = text; }
async function api(route, input) {
  const response = await fetch(route, input && {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-P5-Token": token },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}
function remember() {
  const key = draftKey(active.name);
  const draft = { content: editor.getValue(), version: active.version };
  drafts.set(key, draft);
  try { localStorage.setItem(key, JSON.stringify(draft)); return true; }
  catch { notice("Draft recovery storage is unavailable. Keep this panel open until saved."); return false; }
}
function forget(name) {
  const key = draftKey(name);
  drafts.delete(key);
  try { localStorage.removeItem(key); }
  catch { notice("Could not clear the local recovery draft."); }
}
function run() {
  if (!active || !previewUrl || !runtimeReady) return;
  $("runtime-error").hidden = true;
  const colors = getComputedStyle(document.documentElement);
  const background = colors.getPropertyValue("--background-color-default").trim() || "#ffffff";
  lastBackground = background;
  const content = editor.getValue();
  $("preview").onload = () => $("preview").contentWindow.postMessage({ type: "p5-run", content, background }, "*");
  $("preview").removeAttribute("srcdoc");
  $("preview").src = previewUrl;
}
window.addEventListener("message", event => {
  if (event.source !== $("preview").contentWindow || event.data?.type !== "p5-error") return;
  $("runtime-error").textContent = String(event.data.message).slice(0, 4000);
  $("runtime-error").hidden = false;
});
function showConflict() {
  conflict = true;
  saveError = null;
  $("conflict").hidden = false;
  status("Conflict - draft kept");
}
async function select(name) {
  if (!name) return;
  selecting = true;
  refreshParameters();
  editor.setEnabled(false);
  let disk;
  try { disk = await api(`sketch?name=${encodeURIComponent(name)}`); }
  finally { selecting = false; editor.setEnabled(Boolean(active)); refreshParameters(); }
  active = disk;
  setEditor(disk.content);
  dirty = false;
  conflict = false;
  saveError = null;
  $("conflict").hidden = true;
  const key = draftKey(name);
  let draft = drafts.get(key);
  if (!draft) {
    try { draft = JSON.parse(localStorage.getItem(key) || "null"); }
    catch { notice("Could not restore a saved recovery draft."); }
  }
  if (draft && typeof draft.content === "string" && draft.content !== disk.content) {
    drafts.set(key, draft);
    setEditor(draft.content);
    dirty = true;
    if (draft.version !== disk.version) showConflict();
    else timer = setTimeout(() => save().catch(report), 600);
  }
  editor.setEnabled(true);
  $("sketches").value = name;
  refreshVariation();
  if (!conflict) status(dirty ? "Draft recovered" : "Saved");
  clearTimeout(previewTimer);
  run();
}
function save() {
  if (!saveTask) saveTask = saveCurrent().finally(() => { saveTask = null; });
  return saveTask;
}
async function saveCurrent() {
  if (!active || !dirty || saving || conflict) return;
  saving = true;
  saveError = null;
  const requested = active;
  const folder = root;
  const name = active.name;
  const content = editor.getValue();
  status("Saving...");
  try {
    const result = await api("save", { name, content, version: active.version });
    if (active !== requested || root !== folder) return;
    active = result;
    dirty = editor.getValue() !== content;
    if (dirty) remember(); else forget(name);
    status(dirty ? "Unsaved" : "Saved");
  } catch (error) {
    if (active !== requested || root !== folder) { report(error); return; }
    if (error.status === 409) showConflict();
    else { saveError = error.message; status("Save failed - draft kept"); throw error; }
  } finally {
    saving = false;
    if (root === folder && active?.name === name && dirty && !conflict) timer = setTimeout(() => save().catch(report), 1200);
  }
}
function report(error) { notice(error.message); }
function showRuntimeSettings(open) {
  $("runtime-settings-panel").hidden = !open;
  $("runtime-settings").setAttribute("aria-expanded", String(open));
}
$("runtime-settings").onclick = () => showRuntimeSettings($("runtime-settings-panel").hidden);
const downloadFailure = message => /^Could not (download|connect)/.test(message);
function runtimeHelp(failed) {
  const source = $("registry-url").value.trim() ? "the configured registry" : "your npm registry (the public npm registry unless npm is configured otherwise)";
  $("runtime-help").textContent = failed
    ? `We're having trouble downloading the p5.js runtime from ${source}. Your organization may require a proxy registry in place of the public npm registry. If so, add your proxy URL below and save.`
    : "p5.js is downloaded once from your npm registry and cached for offline use. If your organization requires a proxy registry in place of the public npm registry, add your proxy URL below.";
}
async function loadRuntime(input) {
  for (const control of $("registry-form").querySelectorAll("button, input")) control.disabled = true;
  $("runtime-settings-error").textContent = "";
  $("runtime-status").textContent = "Loading verified p5.js runtime...";
  try {
    const state = await api("runtime", input);
    runtimeReady = state.status === "ready";
    $("runtime-status").textContent = runtimeReady
      ? `p5.js ${state.version} is cached and ready for offline use.`
      : `p5.js ${state.version}: ${state.status}`;
    if (runtimeReady) {
      runtimeHelp(false);
      showRuntimeSettings(false);
      run();
    }
  } catch (error) {
    $("runtime-settings-error").textContent = error.message;
    runtimeHelp(downloadFailure(error.message));
    $("runtime-status").textContent = runtimeReady ? "The cached runtime remains available." : "p5.js could not be loaded. Editing and saving remain available.";
    showRuntimeSettings(true);
  } finally {
    $("runtime-retry").textContent = runtimeReady ? "Check cached runtime" : "Retry download";
    for (const control of $("registry-form").querySelectorAll("button, input")) control.disabled = false;
  }
}
$("runtime-retry").onclick = () => loadRuntime({});
$("registry-form").addEventListener("submit", event => {
  event.preventDefault();
  loadRuntime({ registry: $("registry-url").value.trim() });
});
async function initializeRuntime() {
  try {
    const state = await api("runtime");
    $("registry-url").value = state.registry || "";
    runtimeHelp(false);
    await loadRuntime({});
  } catch (error) {
    $("runtime-settings-error").textContent = error.message;
    showRuntimeSettings(true);
  }
}
const editorEvents = new EventSource("editor-events");
editorEvents.addEventListener("snapshot", event => {
  try {
    const { requestId, clientId, maxBytes } = JSON.parse(event.data);
    let snapshot = { requestId, clientId };
    if (selecting) snapshot.status = "unavailable";
    else if (!active) snapshot.status = "no_sketch";
    else {
      const content = editor.getValue();
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      snapshot = {
        ...snapshot, folder: root, name: active.name,
        saveStatus: { dirty, saving, conflict, error: saveError },
        ...(sizeBytes > maxBytes ? { status: "too_large", sizeBytes } : { status: "ready", content }),
      };
    }
    api("editor-snapshot", snapshot).catch(report);
  } catch (error) { report(error); }
});
$("editor").addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    clearTimeout(timer);
    save().catch(report);
  }
});
$("sketches").addEventListener("change", async () => {
  if (creating) return;
  const next = $("sketches").value;
  $("sketches").disabled = true;
  try {
    clearTimeout(timer);
    await save();
    if (dirty || saving) { $("sketches").value = active.name; notice("Resolve or save the current draft before switching sketches."); return; }
    await select(next);
  } catch (error) { $("sketches").value = active?.name || ""; report(error); }
  finally { $("sketches").disabled = false; }
});
$("load-disk").onclick = async () => {
  try { const name = active.name; forget(name); await select(name); notice("Loaded disk version."); }
  catch (error) { report(error); }
};
$("keep-draft").onclick = async () => {
  try {
    const disk = await api(`sketch?name=${encodeURIComponent(active.name)}`);
    active.version = disk.version;
    conflict = false;
    saveError = null;
    $("conflict").hidden = true;
    remember();
    await save();
  } catch (error) { report(error); }
};
$("restart").onclick = run;
$("parameters").addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) editor.redo(); else editor.undo();
  }
});
const controlsHelp = $("controls-help");
controlsHelp.addEventListener("beforetoggle", event => {
  if (event.newState !== "open") return;
  const button = $("controls-help-button").getBoundingClientRect();
  const pane = $("controls-pane").getBoundingClientRect();
  const width = Math.min(320, pane.width - 16, window.innerWidth - 16);
  const maxHeight = Math.min(420, window.innerHeight - 16);
  controlsHelp.style.width = `${width}px`;
  controlsHelp.style.left = `${Math.max(8, Math.min(pane.right - width - 8, window.innerWidth - width - 8))}px`;
  controlsHelp.style.top = `${Math.max(8, Math.min(button.bottom + 6, window.innerHeight - maxHeight - 8))}px`;
  controlsHelp.style.maxHeight = `${maxHeight}px`;
});
window.addEventListener("resize", () => controlsHelp.hidePopover());
$("toggle-controls").onclick = () => {
  controlsHelp.hidePopover();
  const hidden = !$("controls-pane").hidden;
  $("controls-pane").hidden = hidden;
  document.querySelector("main").classList.toggle("controls-open", !hidden);
  $("toggle-controls").setAttribute("aria-expanded", String(!hidden));
  $("toggle-controls").setAttribute("aria-pressed", String(!hidden));
  $("toggle-controls").setAttribute("aria-label", hidden ? "Show controls" : "Hide controls");
  refreshParameters();
};
$("toggle").onclick = () => {
  const hidden = !$("editor-pane").hidden;
  $("editor-pane").hidden = hidden;
  document.querySelector("main").classList.toggle("editor-hidden", hidden);
  $("toggle").setAttribute("aria-expanded", String(!hidden));
  $("toggle").setAttribute("aria-pressed", String(!hidden));
  $("toggle").setAttribute("aria-label", hidden ? "Show editor" : "Hide editor");
};
function closeNewSketch() {
  $("new-sketch-form").hidden = true;
  $("new-sketch").setAttribute("aria-expanded", "false");
}
$("new-sketch").onclick = () => {
  const opening = $("new-sketch-form").hidden;
  choosing = false;
  showSketches();
  $("new-sketch-form").hidden = !opening;
  $("new-sketch").setAttribute("aria-expanded", String(opening));
  $("create-error").textContent = "";
  if (opening) $("sketch-name").focus();
};
$("cancel-new-sketch").onclick = () => { closeNewSketch(); $("new-sketch").focus(); };
// Shared by New sketch and New variation: flush the draft, create via `request`, then open the result.
async function createAndOpen(request, showError) {
  if (creating) return;
  if (changingFolder) { showError("Wait for the folder change to finish."); return; }
  if (selecting) { showError("Wait for the current sketch to finish opening."); return; }
  creating = true;
  refreshParameters();
  showError("");
  setControls(false);
  $("change-folder").disabled = true;
  editor.setEnabled(false);
  setFormsEnabled(false);
  try {
    clearTimeout(timer);
    await save();
    if (dirty && !conflict) await save();
    if (dirty || saving) throw new Error("Resolve or save the current draft before creating a sketch.");
    const created = await request();
    try {
      const state = await api("state");
      if (state.status !== "ready" || state.folder !== root) {
        throw new Error("The sketches folder changed. Reopen its folder to edit it.");
      }
      $("sketches").replaceChildren(...state.sketches.map(name => new Option(name, name)));
      $("sketches").value = active?.name ?? "";
      await select(created.name);
    } catch (error) {
      throw new Error(`Created ${created.name}, but could not open it: ${error.message}`);
    }
    $("editor-pane").hidden = false;
    document.querySelector("main").classList.remove("editor-hidden");
    $("toggle").setAttribute("aria-expanded", "true");
    $("toggle").setAttribute("aria-pressed", "true");
    $("toggle").setAttribute("aria-label", "Hide editor");
    closeNewSketch();
    notice(`Created ${created.name}. Edits autosave.`);
    editor.focus();
    return created;
  } catch (error) { showError(error.message); }
  finally {
    creating = false;
    refreshParameters();
    editor.setEnabled(Boolean(active));
    setControls(Boolean(root));
    $("change-folder").disabled = false;
    setFormsEnabled(true);
  }
}
$("new-sketch-form").addEventListener("submit", async event => {
  event.preventDefault();
  const created = await createAndOpen(
    () => api("create-sketch", { name: $("sketch-name").value }),
    message => { $("create-error").textContent = message; });
  if (created) $("sketch-name").value = "";
});
$("new-variation").onclick = () => {
  if (!active) return;
  createAndOpen(
    () => api("create-variation", { name: active.name, content: editor.getValue() }),
    message => { if (message) notice(message); });
};
async function poll() {
  if (polling || selecting || creating) return;
  polling = true;
  try {
    const state = await api("state");
    if (selecting || creating) return;
    if (state.status === "missing_folder") { showSetup(state); return; }
    if (state.folder !== root) {
      if (dirty) remember();
      root = state.folder;
      active = null;
      dirty = false;
      conflict = false;
      saveError = null;
      $("conflict").hidden = true;
      $("sketches").replaceChildren();
    }
    previewUrl = state.previewUrl;
    showSketches();
    $("repository").textContent = root;
    const names = state.sketches;
    const oldNames = [...$("sketches").options].map(option => option.value);
    if (JSON.stringify(names) !== JSON.stringify(oldNames)) {
      $("sketches").replaceChildren(...names.map(name => new Option(name, name)));
      if (active && names.includes(active.name)) $("sketches").value = active.name;
    }
    if (!names.length) {
      notice(state.pendingFolder
        ? "No sketches yet. Use New sketch to create your first file and its sketches folder."
        : "No sketches yet. Use New sketch to start one, or add a .js file to this sketches folder.");
      if (!dirty) { active = null; if (editor.getValue()) setEditor(""); editor.setEnabled(false); $("preview").srcdoc = ""; refreshVariation(); status("No sketch"); }
    } else if (!active) {
      notice("Edits autosave. Sketches run isolated; network and local assets are disabled.");
      await select(names[0]);
    } else if (!names.includes(active.name)) {
      notice("The selected file was removed. Your draft is kept locally; restore the file to save it.");
      if (!dirty) await select(names[0]);
    } else if (!saving) {
      const requested = active;
      const disk = await api(`sketch?name=${encodeURIComponent(requested.name)}`);
      if (active !== requested || saving || selecting || creating) return;
      if (disk.version !== active.version) {
        if (dirty) showConflict();
        else { active = disk; setEditor(disk.content); run(); status("Updated from disk"); }
      }
    }
  } catch (error) { report(error); }
  finally { polling = false; }
}
// Creating a sketch and changing folders are serialized: neither starts while the other is in flight.
function setControls(enabled) {
  const on = enabled && !creating && !changingFolder;
  for (const id of ["sketches", "new-sketch", "restart", "toggle", "toggle-controls"]) $(id).disabled = !on;
  refreshParameters();
  refreshVariation();
}
function refreshVariation() { $("new-variation").disabled = $("new-sketch").disabled || !active; }
function setFormsEnabled(enabled) {
  for (const form of ["new-sketch-form", "setup"]) {
    for (const control of $(form).querySelectorAll("button, input")) control.disabled = !enabled;
  }
}
function showSetup(state) {
  closeNewSketch();
  const hadFolder = Boolean(root || active);
  if (dirty && remember()) notice("Your unsaved draft is kept. Reopen its sketches folder to recover it.");
  else if (hadFolder && !dirty) notice("");
  clearTimeout(timer);
  clearTimeout(previewTimer);
  root = "";
  active = null;
  dirty = false;
  conflict = false;
  saveError = null;
  choosing = false;
  previewUrl = undefined;
  $("conflict").hidden = true;
  editor.setEnabled(false);
  setEditor("");
  if (hadFolder) {
    $("preview").onload = null;
    $("preview").removeAttribute("src");
    $("preview").srcdoc = "";
  }
  document.querySelector("main").hidden = true;
  $("setup").hidden = false;
  $("change-folder").setAttribute("aria-expanded", "true");
  $("close-setup").hidden = true;
  $("repository").textContent = state.base ? `No sketches folder in ${state.base}` : "No sketches folder";
  $("setup-message").textContent = state.message;
  $("create-folder").hidden = !state.canCreate;
  setControls(false);
  status("No folder");
}
function showSketches() {
  document.querySelector("main").hidden = false;
  $("setup").hidden = !choosing;
  $("change-folder").setAttribute("aria-expanded", String(choosing));
  $("close-setup").hidden = !choosing;
  if (!choosing) $("create-folder").hidden = true;
  setControls(true);
}
async function setupAction(work) {
  if (changingFolder) return;
  if (creating) { $("setup-error").textContent = "Wait for the new sketch to finish."; return; }
  changingFolder = true;
  refreshParameters();
  $("setup-error").textContent = "";
  setControls(false);
  setFormsEnabled(false);
  try {
    clearTimeout(timer);
    await save();
    if (dirty || saving) throw new Error("Resolve or save the current draft before changing folders.");
    await work();
    choosing = false;
    await poll();
  } catch (error) { $("setup-error").textContent = error.message; }
  finally {
    changingFolder = false;
    refreshParameters();
    setControls(Boolean(root));
    setFormsEnabled(true);
  }
}
$("create-folder").onclick = () => setupAction(() => api("create-folder", {}));
$("choose-form").addEventListener("submit", event => {
  event.preventDefault();
  setupAction(() => api("choose-folder", { path: $("folder-path").value.trim() }));
});
$("change-folder").onclick = () => {
  if (!root) { $("folder-path").focus(); return; }
  if (choosing) { closeChooser(); return; }
  closeNewSketch();
  choosing = true;
  $("folder-path").value = root;
  $("setup-error").textContent = "";
  showSketches();
  $("folder-path").focus();
};
function closeChooser() {
  choosing = false;
  $("setup-error").textContent = "";
  showSketches();
  $("change-folder").focus();
}
$("close-setup").onclick = closeChooser;
$("setup").addEventListener("keydown", event => {
  if (event.key === "Escape" && choosing) { event.preventDefault(); closeChooser(); }
});
// The host swaps theme attributes and its managed theme <style> live. The editor follows through CSS
// variables; only the sketch preview needs a rerun to pick up the new background.
const themeObserver = new MutationObserver(() => {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--background-color-default").trim() || "#ffffff";
  if (background !== lastBackground && !dirty) run();
});
themeObserver.observe(document.documentElement, { attributes: true });
themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
window.addEventListener("beforeunload", event => {
  if (dirty) { remember(); event.preventDefault(); event.returnValue = ""; }
});
poll();
initializeRuntime();
setInterval(poll, 1200);
