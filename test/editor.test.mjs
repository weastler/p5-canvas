import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const browserPath = [
  process.env.P5_TEST_BROWSER,
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find(candidate => candidate && existsSync(candidate));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("CodeMirror preserves caret alignment, saves, preview, conflicts, and drafts", {
  skip: browserPath ? false : "Set P5_TEST_BROWSER to a Chromium-based browser to run this test.",
  timeout: 60000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "p5-editor-test-")));
  const extension = path.join(root, "extension");
  const base = path.join(root, "work");
  const folder = path.join(base, "sketches");
  const sketch = path.join(folder, "art.js");
  const second = path.join(folder, "other.js");
  const demo = await readFile(new URL("../sketches/orbits.js", import.meta.url), "utf8");
  const original = "// Caret alignment inside this comment, including long positions after font and theme changes.\n" +
    demo.replace("createCanvas(640, 480);", 'createCanvas(640, 480).elt.dataset.marker = "first";');
  let entry;
  let browser;
  let socket;

  try {
    await cp(new URL("../extension", import.meta.url), extension, { recursive: true });
    await mkdir(folder, { recursive: true });
    await writeFile(sketch, original);
    await writeFile(second, "function setup() { createCanvas(40, 40); }\n");
    const { startServer } = await import(pathToFileURL(path.join(extension, "server.mjs")));
    const source = await readFile(new URL("../node_modules/p5/lib/p5.min.js", import.meta.url), "utf8");
    const runtime = {
      source,
      status: async () => ({ status: "ready", version: "1.11.11", registry: null }),
      acquire: async () => ({ status: "ready", version: "1.11.11" }),
    };
    entry = await startServer({ base, folder }, { runtime });

    const profile = path.join(root, "browser-profile");
    browser = spawn(browserPath, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--disable-background-networking", "--disable-extensions", "--no-first-run", "--window-size=1100,720", "about:blank",
    ], { stdio: "ignore" });
    let port;
    await waitFor(async () => {
      try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }, "browser DevTools");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); callback(message); }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, response => response.error ? reject(new Error(response.error.message)) : resolve(response.result));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const shortcut = async key => {
      const modifiers = process.platform === "darwin" ? 4 : 2;
      const params = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    };
    const replaceText = async text => {
      await evaluate('document.querySelector(".cm-content").focus()');
      await shortcut("a");
      await send("Input.insertText", { text });
    };
    const typeKeys = async text => {
      for (const key of text) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key });
      }
    };
    const previewMarker = async () => {
      const { targetInfos } = await send("Target.getTargets");
      const frame = targetInfos.find(target => target.type === "iframe" && target.url.startsWith("http://127.0.0.1:"));
      if (!frame) return;
      try {
        const { sessionId } = await send("Target.attachToTarget", { targetId: frame.targetId, flatten: true });
        const result = await send("Runtime.evaluate", {
          expression: '(() => { const canvas = document.querySelector("canvas"); return canvas && (canvas.dataset.marker || `${canvas.width}x${canvas.height}`); })()',
          returnByValue: true,
        }, sessionId);
        await send("Target.detachFromTarget", { sessionId });
        return result.result.value;
      } catch (error) {
        if (/context|frame|target|session/i.test(error.message)) return;
        throw error;
      }
    };
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
    const runtimeServer = async (failures, cached = false) => {
      let ready = cached;
      let attempts = 0;
      let registry;
      const state = () => ({ status: ready ? "ready" : "missing", version: "1.11.11", registry: registry || null });
      const server = await startServer({ base, folder }, { runtime: {
        get source() { return ready ? source : undefined; },
        status: async () => state(),
        configure: async value => { registry = value; },
        acquire: async () => {
          attempts++;
          if (!ready && attempts <= failures) throw new Error("Could not download p5.js 1.11.11 from https://registry.npmjs.org/.");
          ready = true;
          return state();
        },
      } });
      return { server, attempts: () => attempts, registry: () => registry };
    };
    const panelHidden = () => evaluate('document.querySelector("#runtime-settings-panel").hidden');
    await t.test("first run downloads automatically without showing runtime settings", async () => {
      const runtimeCase = await runtimeServer(0);
      try {
        await send("Page.navigate", { url: runtimeCase.server.url });
        await waitFor(async () => await previewMarker() === "first", "automatic runtime preview");
        assert.equal(runtimeCase.attempts(), 1);
        assert.equal(await panelHidden(), true);
      } finally { await runtimeCase.server.close(); }
    });
    await t.test("cached runtime starts without showing runtime settings", async () => {
      const runtimeCase = await runtimeServer(0, true);
      try {
        await send("Page.navigate", { url: runtimeCase.server.url });
        await waitFor(async () => await previewMarker() === "first", "cached runtime preview");
        assert.equal(await panelHidden(), true);
      } finally { await runtimeCase.server.close(); }
    });
    await t.test("failed download explains proxies and dismisses after proxy retry", async () => {
      const runtimeCase = await runtimeServer(1);
      try {
        await send("Page.navigate", { url: runtimeCase.server.url });
        await waitFor(() => evaluate('document.querySelector(".cm-content")?.textContent.includes("Caret alignment")'), "editor without runtime");
        await waitFor(async () => !await panelHidden(), "runtime failure settings");
        assert.match(await evaluate('document.querySelector("#runtime-help").textContent'),
          /trouble downloading the p5\.js runtime from your npm registry.*proxy registry in place of the public npm registry/);
        assert.match(await evaluate('document.querySelector("#runtime-settings-error").textContent'), /Could not download/);
        assert.equal((await runtimeCase.server.currentSketch()).content, original);
        await evaluate(`(() => {
          document.querySelector("#registry-url").value = "https://proxy.example/npm/";
          document.querySelector("#registry-form").requestSubmit();
        })()`);
        await waitFor(async () => await previewMarker() === "first", "runtime retry preview");
        assert.equal(runtimeCase.registry(), "https://proxy.example/npm/");
        assert.equal(runtimeCase.attempts(), 2);
        assert.equal(await panelHidden(), true);
        assert.equal(await readFile(sketch, "utf8"), original);
      } finally { await runtimeCase.server.close(); }
    });
    await t.test("first run opens an empty viewer and New sketch lazily creates and autosaves in CWD", async () => {
      const firstBase = path.join(root, "first-run");
      const firstFolder = path.join(firstBase, "sketches");
      await mkdir(firstBase);
      const first = await startServer({ base: firstBase }, { runtime });
      const capture = async name => {
        if (!process.env.P5_TEST_SCREENSHOT_DIR) return;
        const image = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(process.env.P5_TEST_SCREENSHOT_DIR, name), Buffer.from(image.data, "base64"));
      };
      try {
        await send("Page.navigate", { url: first.url });
        await waitFor(() => evaluate('!document.querySelector("#new-sketch")?.disabled'), "first-run New sketch");
        assert.deepEqual(await evaluate('[document.querySelector("#setup").hidden, document.querySelector("main").hidden, document.querySelector("#new-variation").disabled]'),
          [true, false, true]);
        assert.equal(await evaluate('document.querySelector("#repository").textContent'), firstFolder);
        assert.equal(await evaluate('document.querySelector("#save-status").textContent'), "No sketch");
        assert.deepEqual(await readdir(firstBase), [], "opening writes nothing to the working folder");
        await capture("p5-first-run-empty.png");
        await evaluate('document.querySelector("#new-sketch").click(); document.querySelector("#cancel-new-sketch").click()');
        assert.deepEqual(await readdir(firstBase), [], "cancelling writes nothing");
        await evaluate(`(() => {
          document.querySelector("#new-sketch").click();
          document.querySelector("#sketch-name").value = "first";
          document.querySelector("#new-sketch-form").requestSubmit();
        })()`);
        await waitFor(() => evaluate('document.querySelector("#sketches").value === "first.js" && document.querySelector("#new-sketch-form").hidden'), "first file selected");
        await waitFor(async () => await previewMarker() === "640x480", "first file live preview");
        await capture("p5-first-run-created.png");
        const content = (await first.currentSketch()).content + "// first-run autosave\n";
        await replaceText(content);
        await waitFor(async () => await readFile(path.join(firstFolder, "first.js"), "utf8") === content, "first-run autosave");
        await waitFor(() => evaluate('document.querySelector("#save-status").textContent === "Saved"'), "first-run save complete");
        const draft = content + "// retained while default sketches folder is missing\n";
        await replaceText(draft);
        await rm(firstFolder, { recursive: true });
        await waitFor(() => evaluate('document.querySelector("#notice").textContent.includes("No sketches yet")'), "default folder removed");
        assert.equal(await evaluate('document.querySelector(".cm-content").cmTile.root.view.state.doc.toString()'), draft);
        assert.equal((await first.currentSketch()).status, "unavailable");
        await shortcut("s");
        await waitFor(() => evaluate('!document.querySelector("#conflict").hidden'), "missing default folder draft conflict");
        await mkdir(firstFolder);
        await writeFile(path.join(firstFolder, "first.js"), content);
        await evaluate('document.querySelector("#keep-draft").click()');
        await waitFor(async () => await readFile(path.join(firstFolder, "first.js"), "utf8") === draft, "default-folder draft recovery");
        first.configure({});
        await waitFor(() => evaluate('!document.querySelector("#setup").hidden'), "no-CWD folder choice");
        assert.equal(await evaluate('document.querySelector("#new-sketch").disabled'), true);
        assert.match(await evaluate('document.querySelector("#setup-message").textContent'), /No working folder is known/);
      } finally { await first.close(); }
    });
    await send("Page.navigate", { url: entry.url });
    await waitFor(() => evaluate('document.querySelector(".cm-content")?.textContent.includes("Caret alignment")'), "CodeMirror");
    try { await waitFor(async () => await previewMarker() === "first", "initial live sketch"); }
    catch (error) {
      const runtimeError = await evaluate('document.querySelector("#runtime-error").textContent');
      const src = await evaluate('document.querySelector("#preview").src');
      throw new Error(`${error.message}: ${runtimeError}; src: ${src}`);
    }
    let current = await entry.currentSketch();
    assert.deepEqual(current, {
      status: "ready", path: sketch, content: original,
      saveStatus: { dirty: false, saving: false, conflict: false, error: null },
    });
    assert.equal(await evaluate('document.querySelectorAll("textarea").length'), 0);
    assert.equal(await evaluate('!!document.querySelector(".tok-comment") && !!document.querySelector(".tok-keyword")'), true);

    await t.test("source-backed controls stay synchronized, save, undo and reject stale edits", async t => {
      const fixture = `// Particle count @range 1 50 1
const PARTICLE_COUNT = 12;
const SPEED = -1.5;
const INK = '#f80';
const ENABLED = true;
const TITLE = 'Orbit';
const COMPUTED = Math.random();
function setup() { createCanvas(120, 120).elt.dataset.marker = String(PARTICLE_COUNT); background(INK); }
function draw() {}
`;
      const field = (name, type) => `Array.from(document.querySelectorAll("#parameters .parameter")).find(row => row.querySelector("small").textContent === ${JSON.stringify(name)})?.querySelector(${JSON.stringify(type ? `input[type="${type}"]` : "input, textarea")})`;
      const setField = (name, value, type) => evaluate(`(() => {
        const input = ${field(name, type)};
        ${typeof value === "boolean" ? `input.checked = ${value}` : `input.value = ${JSON.stringify(value)}`};
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await replaceText(fixture);
      await evaluate('document.querySelector("#toggle-controls").click()');
      assert.equal(await evaluate('document.querySelector("#toggle-controls").getAttribute("aria-label")'), "Hide controls");
      await t.test("controls help opens by keyboard and dismisses without changing source", async () => {
        assert.equal(await evaluate('document.querySelector("#controls-help").matches(":popover-open")'), false);
        await evaluate('document.querySelector("#controls-help-button").focus()');
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        assert.equal(await evaluate('document.querySelector("#controls-help").matches(":popover-open")'), true);
        const help = await evaluate('document.querySelector("#controls-help").textContent');
        assert.match(help, /directly above \(no blank line\) or on the same line/);
        assert.match(help, /@range <min> <max> <step>/);
        assert.match(help, /const SPEED = 1;/);
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        assert.equal(await evaluate('document.querySelector("#controls-help").matches(":popover-open")'), false);
        assert.equal(await evaluate('document.activeElement.id'), "controls-help-button");
        await evaluate('document.querySelector("#controls-help-button").click()');
        const outside = await evaluate(`(() => {
          const rect = document.querySelector("#preview-pane").getBoundingClientRect();
          return { x: rect.left + 2, y: rect.top + 2 };
        })()`);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...outside, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...outside, button: "left", clickCount: 1 });
        assert.equal(await evaluate('document.querySelector("#controls-help").matches(":popover-open")'), false);
        await evaluate('document.querySelector("#controls-help-button").click(); document.querySelector("#toggle-controls").click()');
        assert.equal(await evaluate('document.querySelector("#controls-help").matches(":popover-open")'), false);
        await evaluate('document.querySelector("#toggle-controls").click()');
        assert.equal((await entry.currentSketch()).content, fixture);
      });
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#parameters input, #parameters textarea")).map(input => input.type)'),
        ["range", "number", "number", "color", "checkbox", "textarea"]);
      assert.match(await evaluate('document.querySelector("#parameters-help").textContent'), /unsupported/);
      await setField("PARTICLE_COUNT", "24", "range");
      await waitFor(async () => (await readFile(sketch, "utf8")).includes("PARTICLE_COUNT = 24;"), "control autosave");
      await waitFor(async () => await previewMarker() === "24", "control preview");
      assert.equal(await evaluate(`${field("PARTICLE_COUNT", "number")}.value`), "24");
      await evaluate(`${field("PARTICLE_COUNT", "number")}.focus()`);
      await shortcut("z");
      assert.equal(await evaluate(`${field("PARTICLE_COUNT", "number")}.value`), "12");
      await evaluate(`${field("SPEED")}.focus(); ${field("SPEED")}.select()`);
      await typeKeys("-0.50");
      assert.match((await entry.currentSketch()).content, /const SPEED = -0\.5;/);
      assert.equal(await evaluate(`${field("SPEED")}.value`), "-0.50");
      assert.equal(await evaluate(`document.activeElement === ${field("SPEED")}`), true);
      await typeKeys("5");
      assert.match((await entry.currentSketch()).content, /const SPEED = -0\.505;/);
      await evaluate(`${field("TITLE")}.focus(); ${field("TITLE")}.select()`);
      await typeKeys("Slow spin");
      assert.match((await entry.currentSketch()).content, /const TITLE = 'Slow spin';/);
      assert.equal(await evaluate(`${field("TITLE")}.value`), "Slow spin");
      assert.equal(await evaluate(`document.activeElement === ${field("TITLE")} && document.activeElement.selectionStart === 9`), true);
      await evaluate(`${field("TITLE")}.select()`);
      await typeKeys("#abc tag");
      assert.match((await entry.currentSketch()).content, /const TITLE = '#abc tag';/);
      assert.equal(await evaluate(`document.activeElement === ${field("TITLE")} && document.activeElement.value === "#abc tag"`), true);
      await evaluate(`${field("TITLE")}.select()`);
      await typeKeys("#abc");
      assert.equal(await evaluate(`document.activeElement === ${field("TITLE")} && document.activeElement.tagName`), "TEXTAREA");
      await evaluate(`${field("SPEED")}.focus()`);
      await waitFor(() => evaluate(`!!${field("TITLE", "color")}`), "color control after text blur");
      await replaceText((await entry.currentSketch()).content.replace("'#abc'", "'Slow spin'"));
      await evaluate(`${field("SPEED")}.focus()`);
      await setField("SPEED", "0.125");
      await setField("ENABLED", false);
      await setField("INK", "#123456");
      const text = "a'\"\\\n${literal}";
      await setField("TITLE", text);
      let snapshot = await entry.currentSketch();
      assert.match(snapshot.content, /const SPEED = 0\.125;/);
      assert.match(snapshot.content, /const ENABLED = false;/);
      assert.match(snapshot.content, /const INK = '#123456';/);
      assert.equal(await evaluate(`${field("TITLE")}.value`), text);
      assert.ok(snapshot.content.includes("// Particle count @range 1 50 1"));
      await waitFor(async () => (await readFile(sketch, "utf8")) === snapshot.content, "typed control persistence");
      await evaluate('document.querySelector("#toggle").click()');
      const beforeInvalid = (await entry.currentSketch()).content;
      await setField("SPEED", "");
      assert.equal((await entry.currentSketch()).content, beforeInvalid);
      assert.equal(await evaluate(`${field("SPEED")}.validity.valid`), false);
      await setField("SPEED", "2.5");
      assert.match((await entry.currentSketch()).content, /SPEED = 2\.5/);
      await evaluate('document.querySelector("#toggle").click()');
      await evaluate(`window.__staleControl = ${field("SPEED")}`);
      const changed = fixture.replace("const SPEED = -1.5;", 'const MOTION = "slow";');
      await replaceText(changed);
      assert.equal(await evaluate(`${field("SPEED")} === undefined`), true);
      assert.equal(await evaluate(`${field("MOTION")}.type`), "textarea");
      await evaluate('window.__staleControl.value = "999"; window.__staleControl.dispatchEvent(new Event("input"))');
      assert.equal((await entry.currentSketch()).content, changed);
      await replaceText(fixture.replace("SPEED = -1.5", "SPEED = false"));
      assert.equal(await evaluate(`${field("SPEED")}.getAttribute("role")`), "switch");
      await replaceText(changed + '\nconst INCOMPLETE = "');
      assert.equal(await evaluate('document.querySelectorAll("#parameters input, #parameters textarea").length'), 0);
      await evaluate('window.__staleControl.dispatchEvent(new Event("input"))');
      assert.ok((await entry.currentSketch()).content.endsWith('const INCOMPLETE = "'));
      await replaceText(fixture);
      await waitFor(async () => (await readFile(sketch, "utf8")) === fixture, "restored fixture save");
      await waitFor(() => evaluate('document.querySelector("#save-status").textContent === "Saved"'), "fixture save completion");
      const external = fixture.replace("PARTICLE_COUNT = 12", "PARTICLE_COUNT = 31");
      await writeFile(sketch, external);
      await waitFor(() => evaluate(`${field("PARTICLE_COUNT", "number")}.value === "31"`), "external controls refresh");
      await replaceText(external.replace("PARTICLE_COUNT = 31", "PARTICLE_COUNT = 80"));
      assert.equal(await evaluate(`${field("PARTICLE_COUNT", "range")}.disabled`), true);
      assert.equal(await evaluate(`${field("PARTICLE_COUNT", "number")}.value`), "80");
      await replaceText(external);
      await waitFor(async () => await previewMarker() === "31", "screenshot preview");
      for (const [mode, width] of [["light", 1100], ["dark", 375]]) {
        await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await evaluate(`(() => {
          document.documentElement.dataset.colorMode = "${mode}";
          const root = document.documentElement.style;
          root.setProperty("--background-color-default", "${mode === "dark" ? "#0d1117" : "#ffffff"}");
          root.setProperty("--text-color-default", "${mode === "dark" ? "#e6edf3" : "#1f2328"}");
          root.setProperty("--border-color-default", "${mode === "dark" ? "#30363d" : "#d0d7de"}");
          document.querySelector("#repository").textContent = "Temporary validation sketches";
          document.querySelector("#controls-pane").scrollIntoView();
        })()`);
        assert.ok(await evaluate(`document.documentElement.scrollWidth <= ${width}`), `controls fit ${width}px`);
        const layout = await evaluate(`(() => {
          const pane = document.querySelector("#controls-pane").getBoundingClientRect();
          return { width: pane.width, scroll: document.querySelector("#controls-pane").scrollWidth };
        })()`);
        assert.ok(layout.scroll <= layout.width + 1);
        assert.equal(await evaluate(`getComputedStyle(${field("SPEED")}).backgroundColor`), mode === "dark" ? "rgb(13, 17, 23)" : "rgb(255, 255, 255)");
        await evaluate('document.querySelector("#controls-help-button").click()');
        const helpLayout = await evaluate(`(() => {
          const help = document.querySelector("#controls-help");
          const rect = help.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: rect.width, scrollWidth: help.scrollWidth, background: getComputedStyle(help).backgroundColor };
        })()`);
        assert.ok(helpLayout.left >= 0 && helpLayout.right <= width, `help fits ${width}px horizontally`);
        assert.ok(helpLayout.top >= 0 && helpLayout.bottom <= 900, "help fits viewport vertically");
        assert.ok(helpLayout.scrollWidth <= helpLayout.width, "help text wraps without horizontal scrolling");
        assert.equal(helpLayout.background, mode === "dark" ? "rgb(13, 17, 23)" : "rgb(255, 255, 255)");
        await evaluate('document.querySelector("#controls-help-button").click()');
        if (process.env.P5_TEST_SCREENSHOT_DIR) {
          await waitFor(async () => await previewMarker() === "31", "screenshot preview");
          const { cssContentSize } = await send("Page.getLayoutMetrics");
          const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
          await writeFile(path.join(process.env.P5_TEST_SCREENSHOT_DIR, `p5-controls-${mode}-${width}.png`), Buffer.from(image.data, "base64"));
        }
      }
      await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
      await evaluate(`(() => {
        window.__staleControl = ${field("SPEED")};
        const select = document.querySelector("#sketches"); select.value = "other.js";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor(async () => (await entry.currentSketch()).path === second, "controls sketch switch");
      assert.equal(await evaluate('document.querySelectorAll("#parameters input, #parameters textarea").length'), 0);
      await evaluate('window.__staleControl.value = "888"; window.__staleControl.dispatchEvent(new Event("input"))');
      assert.equal((await entry.currentSketch()).content, "function setup() { createCanvas(40, 40); }\n");
      await evaluate(`(() => { const select = document.querySelector("#sketches"); select.value = "art.js"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await waitFor(async () => (await entry.currentSketch()).path === sketch, "return from controls test");
      const alternate = path.join(root, "alternate");
      await mkdir(alternate);
      await writeFile(path.join(alternate, "art.js"), external);
      await evaluate(`(() => {
        window.__folderStale = ${field("SPEED")};
        document.querySelector("#change-folder").click();
        document.querySelector("#folder-path").value = ${JSON.stringify(alternate)};
        document.querySelector("#choose-form").requestSubmit();
      })()`);
      await waitFor(async () => (await entry.currentSketch()).path === path.join(alternate, "art.js"), "controls folder switch");
      await evaluate('window.__folderStale.value = "999"; window.__folderStale.dispatchEvent(new Event("input"))');
      assert.equal((await entry.currentSketch()).content, external);
      assert.equal(await readFile(path.join(alternate, "art.js"), "utf8"), external);
      await evaluate(`(() => {
        document.querySelector("#change-folder").click();
        document.querySelector("#folder-path").value = ${JSON.stringify(folder)};
        document.querySelector("#choose-form").requestSubmit();
      })()`);
      await waitFor(async () => (await entry.currentSketch()).path === sketch, "controls original folder");
      await replaceText(original);
      await waitFor(async () => (await readFile(sketch, "utf8")) === original, "restore original fixture");
      await evaluate(`(() => {
        document.querySelector("#toggle-controls").click();
        document.documentElement.removeAttribute("style");
        document.querySelector("#repository").textContent = ${JSON.stringify(folder)};
        const view = document.querySelector(".cm-content").cmTile.root.view;
        view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
        view.scrollDOM.scrollTop = 0;
        view.scrollDOM.scrollLeft = 0;
        window.scrollTo(0, 0);
      })()`);
    });

    for (const width of [1100, 650, 480, 375]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false });
      const layout = await evaluate(`(() => {
        const header = document.querySelector("header");
        const toolbar = document.querySelector(".toolbar").getBoundingClientRect();
        const select = document.querySelector("#sketches").getBoundingClientRect();
        const label = document.createRange();
        label.selectNodeContents(document.querySelector(".header-controls label").firstChild);
        const labelRect = label.getBoundingClientRect();
        const button = document.querySelector("#toggle-controls").getBoundingClientRect();
        const title = document.querySelector(".header-title").getBoundingClientRect();
        const controls = document.querySelector(".header-controls").getBoundingClientRect();
        return {
          rightEdge: header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight),
          toolbarLeft: toolbar.left, buttonRight: button.right, buttonBottom: button.bottom,
          selectRight: select.right, selectHeight: select.height,
          selectCenter: select.top + select.height / 2, buttonCenter: button.top + button.height / 2,
          labelCenter: labelRect.top + labelRect.height / 2,
          selectPadding: parseFloat(getComputedStyle(document.querySelector("#sketches")).paddingTop),
          titleBottom: title.bottom, controlsTop: controls.top,
          scrollWidth: document.documentElement.scrollWidth,
        };
      })()`);
      assert.ok(Math.abs(layout.buttonRight - layout.rightEdge) <= 1, `toolbar reaches right padding at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(Math.abs(layout.selectRight + 12 - layout.toolbarLeft) <= 1, `selector stays beside toolbar at ${width}px`);
      assert.equal(layout.selectHeight, 32, `selector matches toolbar button height at ${width}px`);
      assert.ok(layout.selectPadding >= 6, `selector has vertical padding at ${width}px`);
      assert.ok(Math.abs(layout.selectCenter - layout.buttonCenter) <= 1, `selector stays centered at ${width}px`);
      assert.ok(Math.abs(layout.labelCenter - layout.buttonCenter) <= 2, `label stays centered at ${width}px`);
      assert.ok(layout.scrollWidth <= width, `no horizontal overflow at ${width}px`);
      if (width <= 480) assert.ok(layout.controlsTop >= layout.titleBottom + 12, `controls wrap below title at ${width}px`);
      t.diagnostic(`Header at ${width}px: right-padding gap ${layout.rightEdge - layout.buttonRight}px`);
    }
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });

    const themes = {
      light: {
        "--background-color-default": "#ffffff", "--text-color-default": "#1f2328",
        "--text-color-muted": "#656d76", "--border-color-default": "#d0d7de",
        "--syntax-color-fg": "#1f2328", "--syntax-color-comment": "#59636e",
        "--syntax-color-keyword": "#cf222e", "--syntax-color-entity": "#8250df",
        "--syntax-color-constant": "#0550ae", "--syntax-color-string": "#0a3069",
        "--syntax-color-regexp": "#116329", "--syntax-color-variable": "#1f2328",
        "--color-focus-outline": "#0969da",
      },
      dark: {
        "--background-color-default": "#0d1117", "--text-color-default": "#e6edf3",
        "--text-color-muted": "#8d96a0", "--border-color-default": "#30363d",
        "--syntax-color-fg": "#e6edf3", "--syntax-color-comment": "#8b949e",
        "--syntax-color-keyword": "#ff7b72", "--syntax-color-entity": "#d2a8ff",
        "--syntax-color-constant": "#79c0ff", "--syntax-color-string": "#a5d6ff",
        "--syntax-color-regexp": "#7ee787", "--syntax-color-variable": "#e6edf3",
        "--color-focus-outline": "#58a6ff",
      },
    };
    let commentPosition;
    for (const [mode, values] of Object.entries(themes)) {
      await evaluate(`(() => {
        document.documentElement.dataset.colorMode = ${JSON.stringify(mode)};
        for (const [name, value] of Object.entries(${JSON.stringify(values)})) document.documentElement.style.setProperty(name, value);
      })()`);
      await t.test(`${mode} panel toggles invert colors and reflect visible panes`, async () => {
        for (const [id, pane, initiallyOpen] of [["toggle", "editor-pane", true], ["toggle-controls", "controls-pane", false]]) {
          for (const [step, open] of [initiallyOpen, !initiallyOpen, initiallyOpen].entries()) {
            const state = await evaluate(`(() => {
              const button = document.getElementById(${JSON.stringify(id)});
              const style = getComputedStyle(button);
              const page = getComputedStyle(document.body);
              return {
                expanded: button.getAttribute("aria-expanded"),
                pressed: button.getAttribute("aria-pressed"),
                hidden: document.getElementById(${JSON.stringify(pane)}).hidden,
                background: style.backgroundColor, color: style.color,
                pageBackground: page.backgroundColor, pageColor: page.color,
              };
            })()`);
            assert.equal(state.expanded, String(open));
            assert.equal(state.pressed, String(open));
            assert.equal(state.hidden, !open);
            assert.equal(state.background, open ? state.pageColor : state.pageBackground);
            assert.equal(state.color, open ? state.pageBackground : state.pageColor);
            if (process.env.P5_TEST_SCREENSHOT_DIR && step === 1) {
              const image = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1100, height: 110, scale: 1 } });
              await writeFile(path.join(process.env.P5_TEST_SCREENSHOT_DIR, `toolbar-${mode}-${id}.png`), Buffer.from(image.data, "base64"));
            }
            if (step < 2) await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
          }
        }
      });
      for (const [selector, offset] of [[".tok-keyword", 2], [".tok-comment", 10]]) {
        const position = await evaluate(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)}).firstChild;
          const range = document.createRange();
          range.setStart(node, ${offset}); range.setEnd(node, ${offset + 1});
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width * 0.8, y: rect.top + rect.height / 2,
            expected: rect.right, top: rect.top, bottom: rect.bottom };
        })()`);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x, y: position.y, button: "left", clickCount: 1 });
        await waitFor(async () => {
          const cursor = await evaluate(`(() => {
            const rect = document.querySelector(".cm-cursor-primary")?.getBoundingClientRect();
            return rect && { left: rect.left, top: rect.top, bottom: rect.bottom };
          })()`);
          return cursor && Math.abs(cursor.left - position.expected) <= 1.5 &&
            Math.abs(cursor.top - position.top) <= 1 && Math.abs(cursor.bottom - position.bottom) <= 1;
        }, `${mode} ${selector} cursor alignment`);
        if (selector === ".tok-comment") commentPosition = position;
      }
      const measured = await evaluate(`(() => ({
        comment: getComputedStyle(document.querySelector(".tok-comment")).color,
        keyword: getComputedStyle(document.querySelector(".tok-keyword")).color,
        background: getComputedStyle(document.querySelector("#editor")).backgroundColor,
        style: getComputedStyle(document.querySelector(".tok-comment")).fontStyle,
      }))()`);
      assert.equal(measured.style, "normal");
      assert.equal(measured.comment, mode === "dark" ? "rgb(139, 148, 158)" : "rgb(89, 99, 110)");
      assert.equal(measured.keyword, mode === "dark" ? "rgb(255, 123, 114)" : "rgb(207, 34, 46)");
      assert.equal(measured.background, mode === "dark" ? "rgb(13, 17, 23)" : "rgb(255, 255, 255)");
      if (process.env.P5_TEST_SCREENSHOT_DIR) {
        await evaluate('document.querySelector(".cm-cursorLayer").style.animation = "none"');
        await evaluate('document.querySelector("#repository").textContent = "Demo sketches"');
        const image = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(process.env.P5_TEST_SCREENSHOT_DIR, `p5-codemirror-${mode}.png`), Buffer.from(image.data, "base64"));
        if (mode === "dark") {
          await send("Emulation.setDeviceMetricsOverride", { width: 480, height: 720, deviceScaleFactor: 1, mobile: false });
          const narrow = await send("Page.captureScreenshot", { format: "png" });
          await writeFile(path.join(process.env.P5_TEST_SCREENSHOT_DIR, "p5-header-narrow.png"), Buffer.from(narrow.data, "base64"));
          await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
        }
      }
    }

    await sleep(250);
    await evaluate(`(() => {
      const root = document.documentElement;
      window.__p5ThemeMetrics = Object.fromEntries(["--font-mono", "--text-code-block", "--leading-code-block"]
        .map(name => [name, root.style.getPropertyValue(name)]));
      window.__p5SetTimeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => window.__p5SetTimeout(fn, delay === 600 ? 100000 : delay, ...args);
      const view = document.querySelector(".cm-content").cmTile.root.view;
      view.dispatch({ selection: { anchor: 20 } });
      view.focus();
    })()`);
    await send("Input.insertText", { text: "X" });
    await evaluate(`(() => {
      const root = document.documentElement;
      root.style.setProperty("--font-mono", '"Courier New", monospace');
      root.style.setProperty("--text-code-block", "22px");
      root.style.setProperty("--leading-code-block", "1.5");
    })()`);
    const metricsMatch = async expectedSize => evaluate(`(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const node = document.querySelector(".tok-comment").firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 20);
      const characterWidth = range.getBoundingClientRect().width / 20;
      const scroller = getComputedStyle(view.scrollDOM);
      return parseFloat(scroller.fontSize) === ${expectedSize} &&
        Math.abs(view.defaultCharacterWidth - characterWidth) < 0.2 &&
        Math.abs(view.defaultLineHeight - parseFloat(scroller.lineHeight)) < 0.5;
    })()`);
    await waitFor(() => metricsMatch(22), "late theme typography remeasurement");
    const afterTheme = await evaluate(`(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      return { content: view.state.doc.toString(), cursor: view.state.selection.main.head,
        contentLineHeight: getComputedStyle(view.contentDOM).lineHeight,
        gutterLineHeight: getComputedStyle(view.dom.querySelector(".cm-gutters")).lineHeight,
        scrollerLineHeight: getComputedStyle(view.scrollDOM).lineHeight };
    })()`);
    assert.equal(afterTheme.content, original.slice(0, 20) + "X" + original.slice(20));
    assert.equal(afterTheme.cursor, 21);
    assert.equal(afterTheme.contentLineHeight, afterTheme.scrollerLineHeight);
    assert.equal(afterTheme.gutterLineHeight, afterTheme.scrollerLineHeight);
    await evaluate('window.setTimeout = window.__p5SetTimeout');
    await shortcut("z");
    await waitFor(() => evaluate(`document.querySelector(".cm-content").cmTile.root.view.state.doc.toString() === ${JSON.stringify(original)}`), "undo after remeasurement");

    await evaluate(`(() => {
      window.__p5MetricStyle = document.createElement("style");
      document.head.append(window.__p5MetricStyle);
    })()`);
    await sleep(250);
    await evaluate(`(() => {
      window.__p5MetricStyle.sheet.insertRule("#editor .cm-scroller { font-size: 19px !important; }", 0);
      document.fonts.dispatchEvent(new Event("loadingdone"));
    })()`);
    await waitFor(() => metricsMatch(19), "late font-load remeasurement");
    await evaluate('window.__p5MetricStyle.remove()');
    await waitFor(() => metricsMatch(22), "removed theme stylesheet remeasurement");

    await sleep(250);
    await evaluate(`(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const originalSetState = view.setState;
      window.__p5ResetCount = 0;
      view.setState = function (...args) { window.__p5ResetCount++; return originalSetState.apply(this, args); };
      view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      document.documentElement.style.setProperty("--text-code-block", "17px");
    })()`);
    assert.equal(await evaluate('document.querySelector(".cm-content").cmTile.root.view.compositionStarted'), true);
    await sleep(250);
    assert.equal(await evaluate('window.__p5ResetCount'), 0);
    await evaluate('document.querySelector(".cm-content").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))');
    await waitFor(() => evaluate("window.__p5ResetCount > 0"), "remeasurement after composition");
    await waitFor(() => metricsMatch(17), "post-composition typography");
    await evaluate(`(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      delete view.setState;
      const root = document.documentElement;
      for (const [name, value] of Object.entries(window.__p5ThemeMetrics)) {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      }
    })()`);
    await sleep(250);

    const edited = original.replace('"first"', '"second"') + '\n// autosaved by CodeMirror\n// </script><img src=x>\n';
    await replaceText(edited);
    current = await entry.currentSketch();
    assert.equal(current.content, edited);
    assert.equal(current.path, sketch);
    assert.equal(current.saveStatus.dirty, true);
    await waitFor(async () => (await readFile(sketch, "utf8")) === edited, "autosave");
    await waitFor(async () => await previewMarker() === "second", "live preview after editing");
    assert.equal(await evaluate('document.querySelector(".cm-content").textContent.includes("<img src=x>")'), true);
    assert.equal(await evaluate('!!document.querySelector(".cm-content img")'), false);

    const draft = edited + "// draft during external edit\n";
    const external = edited + "// external concurrent edit\n";
    await replaceText(draft);
    await writeFile(sketch, external);
    await waitFor(() => evaluate('!document.querySelector("#conflict").hidden'), "save conflict");
    assert.equal(await evaluate('document.querySelector(".cm-content").textContent.includes("draft during external edit")'), true);
    assert.equal(await readFile(sketch, "utf8"), external);
    current = await entry.currentSketch();
    assert.equal(current.content, draft);
    assert.equal(current.saveStatus.conflict, true);
    assert.equal(current.saveStatus.dirty, true);
    await evaluate(`(() => {
      document.querySelector("#new-sketch").click();
      document.querySelector("#sketch-name").value = "blocked";
      document.querySelector("#new-sketch-form").requestSubmit();
    })()`);
    await waitFor(() => evaluate('document.querySelector("#create-error").textContent.includes("Resolve or save")'), "creation blocked by conflict");
    assert.equal((await entry.currentSketch()).content, draft);
    await assert.rejects(readFile(path.join(folder, "blocked.js")), { code: "ENOENT" });
    assert.equal(await readFile(sketch, "utf8"), external);
    await evaluate('document.querySelector("#cancel-new-sketch").click()');
    await evaluate('document.querySelector("#keep-draft").click()');
    await waitFor(async () => (await readFile(sketch, "utf8")) === draft, "conflict resolution");

    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: commentPosition.x, y: commentPosition.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: commentPosition.x, y: commentPosition.y, button: "left", clickCount: 1 });
    await waitFor(() => evaluate('window.getSelection().anchorNode?.textContent.includes("Caret alignment")'), "comment selection");
    const selection = await evaluate('window.getSelection().anchorOffset');
    const refreshed = draft + "// refreshed from disk\n";
    await writeFile(sketch, refreshed);
    await waitFor(() => evaluate('document.querySelector(".cm-content").textContent.includes("refreshed from disk")'), "external refresh");
    await waitFor(() => evaluate(`window.getSelection().anchorOffset === ${selection} && window.getSelection().anchorNode?.textContent.includes("Caret alignment")`), "selection after external refresh");
    await replaceText(refreshed + "// first file history\n");
    await waitFor(async () => (await readFile(sketch, "utf8")).includes("first file history"), "first file save");
    await waitFor(() => evaluate('document.querySelector("#save-status").textContent === "Saved"'), "save completion");
    await evaluate(`(() => { const select = document.querySelector("#sketches"); select.value = "other.js"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(() => evaluate('document.querySelector(".cm-content").textContent.includes("createCanvas(40")'), "second sketch");
    current = await entry.currentSketch();
    assert.equal(current.path, second);
    assert.equal(current.content, "function setup() { createCanvas(40, 40); }\n");
    await evaluate('document.querySelector(".cm-content").focus()');
    await shortcut("z");
    await sleep(150);
    assert.equal(await evaluate('document.querySelector(".cm-content").textContent.includes("createCanvas(40")'), true);
    assert.equal(await readFile(second, "utf8"), "function setup() { createCanvas(40, 40); }\n");

    await evaluate(`(() => { const select = document.querySelector("#sketches"); select.value = "art.js"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(() => evaluate('document.querySelector(".cm-content").textContent.includes("first file history")'), "original sketch");
    const saved = await readFile(sketch, "utf8");
    await evaluate(`(() => {
      window.__p5SetTimeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => window.__p5SetTimeout(fn, delay === 600 ? 100000 : delay, ...args);
    })()`);
    const manual = saved + "// saved with shortcut\n";
    await replaceText(manual);
    await shortcut("s");
    await waitFor(async () => (await readFile(sketch, "utf8")) === manual, "Cmd/Ctrl+S");
    await evaluate('window.setTimeout = window.__p5SetTimeout');

    const beforeCreate = manual + "// saved before creating another sketch\n";
    await replaceText(beforeCreate);
    await evaluate(`(() => {
      document.querySelector("#toggle").click();
      document.querySelector("#new-sketch").click();
      document.querySelector("#sketch-name").value = "fresh";
      document.querySelector("#new-sketch-form").requestSubmit();
    })()`);
    try {
      await waitFor(() => evaluate('document.querySelector("#sketches").value === "fresh.js" && document.querySelector("#new-sketch-form").hidden'), "new sketch selection");
    } catch (error) {
      const state = await evaluate('({ error: document.querySelector("#create-error").textContent, notice: document.querySelector("#notice").textContent, save: document.querySelector("#save-status").textContent, name: document.querySelector("#sketches").value })');
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    }
    assert.equal(await readFile(sketch, "utf8"), beforeCreate);
    assert.equal(await evaluate('document.querySelector("#editor-pane").hidden'), false);
    assert.deepEqual(await evaluate('["aria-expanded", "aria-pressed"].map(attribute => document.querySelector("#toggle").getAttribute(attribute))'),
      ["true", "true"], "creating a sketch restores the editor toggle's active state");
    current = await entry.currentSketch();
    assert.equal(current.path, path.join(folder, "fresh.js"));
    assert.match(current.content, /function draw\(\)/);
    assert.equal(current.saveStatus.dirty, false);
    assert.equal(await readFile(current.path, "utf8"), current.content);
    await waitFor(async () => await previewMarker() === "640x480", "new sketch live preview");
    const freshContent = current.content + "// new sketch autosave\n";
    await replaceText(freshContent);
    await waitFor(async () => (await readFile(path.join(folder, "fresh.js"), "utf8")) === freshContent, "new sketch autosave");
    await evaluate(`(() => {
      document.querySelector("#new-sketch").click();
      document.querySelector("#sketch-name").value = "fresh";
      document.querySelector("#new-sketch-form").requestSubmit();
    })()`);
    await waitFor(() => evaluate('document.querySelector("#create-error").textContent.includes("already exists")'), "duplicate sketch error");
    assert.equal((await entry.currentSketch()).content, freshContent);
    assert.equal(await readFile(path.join(folder, "fresh.js"), "utf8"), freshContent);
    await evaluate(`(() => {
      document.querySelector("#sketch-name").value = "../outside";
      document.querySelector("#new-sketch-form").requestSubmit();
    })()`);
    await waitFor(() => evaluate('document.querySelector("#create-error").textContent.includes("Use a sketch name")'), "invalid sketch name error");
    assert.equal((await entry.currentSketch()).path, path.join(folder, "fresh.js"));
    await evaluate(`(() => {
      window.__p5Fetch = window.fetch;
      window.fetch = (input, init) => input === "sketch?name=later.js"
        ? Promise.resolve(new Response(JSON.stringify({ error: "Unable to read new sketch" }), { status: 500 }))
        : window.__p5Fetch(input, init);
      document.querySelector("#sketch-name").value = "later";
      document.querySelector("#new-sketch-form").requestSubmit();
    })()`);
    await waitFor(() => evaluate('document.querySelector("#create-error").textContent.includes("Unable to read new sketch")'), "new sketch read failure");
    assert.equal(await evaluate('document.querySelector("#sketches").value'), "fresh.js");
    assert.match(await evaluate('document.querySelector("#create-error").textContent'), /Created later\.js, but could not open it/);
    current = await entry.currentSketch();
    assert.equal(current.path, path.join(folder, "fresh.js"));
    assert.equal(current.content, freshContent);
    assert.match(await readFile(path.join(folder, "later.js"), "utf8"), /function setup\(\)/);
    await evaluate(`(() => {
      window.fetch = window.__p5Fetch;
      document.querySelector("#cancel-new-sketch").click();
      const select = document.querySelector("#sketches");
      select.value = "later.js";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(async () => (await entry.currentSketch()).path === path.join(folder, "later.js"), "opening created sketch after retry");
    await evaluate(`(() => {
      const select = document.querySelector("#sketches");
      select.value = "fresh.js";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(async () => (await entry.currentSketch()).path === path.join(folder, "fresh.js"), "returning to previous sketch");
    await evaluate(`(() => {
      window.__p5Fetch = window.fetch;
      window.fetch = (input, init) => input === "save"
        ? Promise.resolve(new Response(JSON.stringify({ error: "Disk is read-only" }), { status: 500 }))
        : window.__p5Fetch(input, init);
    })()`);
    const failedSaveDraft = freshContent + "// retained after a failed save\n";
    await replaceText(failedSaveDraft);
    await evaluate(`(() => {
      document.querySelector("#new-sketch").click();
      document.querySelector("#sketch-name").value = "not-created";
      document.querySelector("#new-sketch-form").requestSubmit();
    })()`);
    await waitFor(() => evaluate('document.querySelector("#create-error").textContent.includes("Disk is read-only")'), "creation blocked by save failure");
    current = await entry.currentSketch();
    assert.equal(current.content, failedSaveDraft);
    assert.equal(current.saveStatus.dirty, true);
    assert.equal(current.saveStatus.error, "Disk is read-only");
    assert.equal(await readFile(path.join(folder, "fresh.js"), "utf8"), freshContent);
    await assert.rejects(readFile(path.join(folder, "not-created.js")), { code: "ENOENT" });
    await evaluate(`(() => {
      window.fetch = window.__p5Fetch;
      document.querySelector("#cancel-new-sketch").click();
      document.querySelector(".cm-content").focus();
    })()`);
    await shortcut("s");
    await waitFor(async () => (await readFile(path.join(folder, "fresh.js"), "utf8")) === failedSaveDraft, "saving retained draft");
    await evaluate(`(() => {
      const select = document.querySelector("#sketches");
      select.value = "art.js";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(() => evaluate('document.querySelector(".cm-content").textContent.includes("saved before creating another sketch")'), "returning to preserved sketch");

    assert.deepEqual(await evaluate('["new-sketch", "new-variation", "restart", "toggle"].map(id => [document.getElementById(id).getAttribute("aria-label"), document.getElementById(id).textContent.trim()])'),
      [["New sketch", ""], ["New variation", ""], ["Restart sketch", ""], ["Hide editor", ""]]);
    await evaluate('document.querySelector("#toggle").click()');
    assert.equal(await evaluate('document.querySelector("#toggle").getAttribute("aria-label")'), "Show editor");
    await evaluate('document.querySelector("#toggle").click()');
    const variationDraft = beforeCreate + "// unsaved when making a variation\n";
    await replaceText(variationDraft);
    await evaluate('document.querySelector("#new-variation").click()');
    await waitFor(() => evaluate('document.querySelector("#sketches").value === "art-v2.js"'), "variation selection");
    assert.equal(await readFile(sketch, "utf8"), variationDraft);
    assert.equal(await readFile(path.join(folder, "art-v2.js"), "utf8"), variationDraft);
    await writeFile(path.join(folder, "art-v3.js"), "// taken\n");
    await evaluate('document.querySelector("#new-variation").click()');
    await waitFor(() => evaluate('document.querySelector("#sketches").value === "art-v4.js"'), "variation of a variation");
    assert.equal(await readFile(path.join(folder, "art-v3.js"), "utf8"), "// taken\n");
    assert.equal(await readFile(path.join(folder, "art-v4.js"), "utf8"), variationDraft);
    assert.equal((await entry.currentSketch()).path, path.join(folder, "art-v4.js"));
    await evaluate(`(() => {
      const select = document.querySelector("#sketches");
      select.value = "art.js";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(async () => (await entry.currentSketch()).path === sketch, "returning from variation");

    // Folder changes and sketch creation never overlap, and New variation needs an open sketch.
    const empty = path.join(root, "empty");
    await mkdir(empty);
    await evaluate(`(() => {
      const realFetch = window.fetch, gates = {};
      window.fetch = async (route, init) => { await gates[route]?.promise; return realFetch(route, init); };
      window.__hold = route => { let release; gates[route] = { promise: new Promise(resolve => { release = resolve; }) }; gates[route].release = release; };
      window.__release = route => { gates[route].release(); delete gates[route]; };
      window.__restoreFetch = () => { window.fetch = realFetch; };
      window.__forceClick = id => { const button = document.getElementById(id); button.disabled = false; button.click(); };
    })()`);
    const chooseFolder = target => evaluate(`(() => {
      document.querySelector("#change-folder").click();
      document.querySelector("#folder-path").value = ${JSON.stringify(target)};
      document.querySelector("#choose-form").requestSubmit();
    })()`);
    const busyControls = '["new-sketch", "new-variation", "sketches", "folder-path", "close-setup"].map(id => document.getElementById(id).disabled)';
    await evaluate('window.__hold("choose-folder")');
    await chooseFolder(empty);
    assert.deepEqual(await evaluate(busyControls), [true, true, true, true, true]);
    await evaluate('window.__forceClick("new-variation")');
    assert.equal(await evaluate('document.querySelector("#notice").textContent'), "Wait for the folder change to finish.");
    await evaluate('window.__release("choose-folder")');
    await waitFor(() => evaluate(`document.querySelector("#repository").textContent === ${JSON.stringify(empty)}`), "empty folder chosen");
    assert.deepEqual(await evaluate('[document.querySelector("#new-sketch").disabled, document.querySelector("#new-variation").disabled]'), [false, true]);
    assert.deepEqual(await readdir(empty), []);
    assert.equal(existsSync(path.join(folder, "art-v5.js")), false);

    await chooseFolder(folder);
    await waitFor(() => evaluate(`document.querySelector("#repository").textContent === ${JSON.stringify(folder)} && !document.querySelector("#new-variation").disabled`), "original folder chosen");
    await evaluate(`(() => {
      const select = document.querySelector("#sketches");
      select.value = "art.js";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(async () => (await entry.currentSketch()).path === sketch, "reopening art.js");
    await evaluate('document.querySelector("#change-folder").click(); document.querySelector("#folder-path").value = ' + JSON.stringify(empty));
    await evaluate('window.__hold("create-variation"); document.querySelector("#new-variation").click()');
    assert.deepEqual(await evaluate(busyControls), [true, true, true, true, true]);
    await evaluate('document.querySelector("#choose-form").requestSubmit()');
    assert.equal(await evaluate('document.querySelector("#setup-error").textContent'), "Wait for the new sketch to finish.");
    await evaluate('window.__release("create-variation")');
    await waitFor(() => evaluate('document.querySelector("#sketches").value === "art-v5.js"'), "variation created in original folder");
    assert.equal(await evaluate('document.querySelector("#repository").textContent'), folder);
    assert.deepEqual(await readdir(empty), []);
    await evaluate('document.querySelector("#close-setup").click(); window.__restoreFetch()');
    await evaluate(`(() => {
      const select = document.querySelector("#sketches");
      select.value = "art.js";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(async () => (await entry.currentSketch()).path === sketch, "returning after serialization checks");
    const chooserDraft = beforeCreate + "// kept while choosing a folder\n";
    await replaceText(chooserDraft);
    for (const dismiss of ['document.querySelector("#close-setup").click()',
      'document.querySelector("#folder-path").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))']) {
      await evaluate(`(() => {
        document.querySelector("#change-folder").click();
        document.querySelector("#folder-path").value = ${JSON.stringify(root)};
      })()`);
      assert.deepEqual(await evaluate('[document.querySelector("#setup").hidden, document.querySelector("#close-setup").hidden, document.querySelector("#change-folder").getAttribute("aria-expanded"), document.activeElement.id]'),
        [false, false, "true", "folder-path"]);
      await evaluate(dismiss);
      assert.deepEqual(await evaluate('[document.querySelector("#setup").hidden, document.querySelector("#change-folder").getAttribute("aria-expanded"), document.activeElement.id, document.querySelector("#repository").textContent]'),
        [true, "false", "change-folder", folder]);
      current = await entry.currentSketch();
      assert.equal(current.path, sketch);
      assert.equal(current.content, chooserDraft);
    }
    await waitFor(async () => (await readFile(sketch, "utf8")) === chooserDraft, "draft saved after closing chooser");

    await evaluate(`(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("storage disabled"); } }); })()`);
    const recovered = chooserDraft + "// recovered in-memory draft\n";
    await replaceText(recovered);
    await rm(folder, { recursive: true });
    await waitFor(() => evaluate('!document.querySelector("#setup").hidden'), "missing-folder recovery");
    assert.equal(await evaluate('document.querySelector("#close-setup").hidden'), true);
    assert.equal((await entry.currentSketch()).status, "no_sketch");
    assert.match(await evaluate('document.querySelector("#notice").textContent'), /storage is unavailable/);
    await mkdir(folder);
    await writeFile(sketch, chooserDraft);
    await waitFor(() => evaluate('document.querySelector(".cm-content").textContent.includes("recovered in-memory draft")'), "draft restoration");
    await waitFor(async () => (await readFile(sketch, "utf8")) === recovered, "restored draft autosave");

    await evaluate(`(() => {
      window.__p5SetTimeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => window.__p5SetTimeout(fn, delay === 600 ? 100000 : delay, ...args);
    })()`);
    await replaceText("😀".repeat(32769));
    current = await entry.currentSketch();
    assert.equal(current.status, "too_large");
    assert.equal(current.path, sketch);
    assert.equal(current.sizeBytes, 131076);
    assert.equal(current.limitBytes, 131072);
    assert.equal(Object.hasOwn(current, "content"), false);
  } finally {
    if (socket) socket.close();
    if (entry) await entry.close();
    if (browser && browser.exitCode === null) {
      const stopped = new Promise(resolve => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      let timeout;
      await Promise.race([stopped, new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]);
      clearTimeout(timeout);
      if (browser.exitCode === null && browser.signalCode === null) { browser.kill("SIGKILL"); await stopped; }
    }
    await rm(root, { recursive: true, force: true });
  }
});
