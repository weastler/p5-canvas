# P5.js canvas for Copilot

A personal Copilot canvas extension that discovers `sketches/**/*.js` in the
active session's working folder (Git is not required). The live preview and JavaScript
editor appear side by side. Editing reruns the preview and saves after 600 ms.
Opening the canvas never creates a folder or sketch. If `sketches/` is missing,
the ordinary empty viewer lets you start with **New sketch**, creating the folder
and your first file only when you submit a valid name. No folder choice is required.
The header toolbar uses icon buttons with tooltips: **New sketch** (+), **New
variation** (copy), **Restart sketch** (circular arrow), **Hide/Show editor** (panel) for a larger
preview, and **Show/Hide controls** (sliders).
The editor and controls buttons use inverted colors while their panels are open.
Press Cmd/Ctrl+S to save.

## Live sketch controls

Click **Show controls** (sliders icon) to toggle a source-backed control panel.
The **About sketch controls** (?) button in the panel explains comment labels,
`@range` slider hints and supported literal types.
It stays usable with the editor hidden. Each edit replaces only the initializer
through a CodeMirror transaction: surrounding code/comments, undo, the existing
preview refresh and 600 ms autosave are preserved. Cmd/Ctrl+Z (Shift+Z to redo)
works in the panel as well as in the editor. There is no runtime parameter
override or separate parameter value store; the current editor buffer is authoritative.
Typing code, recovering a draft and refreshing from disk update the controls.
Sketch/folder transitions disable and detach old controls.

Discovery parses JavaScript without executing it. This first version supports
direct, top-level `const` bindings initialized with finite safe-precision number
literals (including signs, exponents, separators and radix notation), booleans,
or single/double-quoted string literals. Numbers get native numeric steppers,
booleans get switches, `#rgb`/`#rrggbb` strings get color pickers, and other strings
get multiline text boxes. String edits preserve the quote style and escape quotes,
backslashes, line breaks and control characters. Color edits normalize to six-digit
hex. Named colors, alpha hex and `rgb()` strings remain editable as ordinary text.
A text field keeps its type while you type a color-like value; it becomes a color
picker after it loses focus.
Identifiers are converted to readable labels; a directly preceding comment (no
blank line), or a same-line trailing comment, takes precedence. The identifier
is also shown so a descriptive comment never hides which constant will change.

Sliders require explicit bounds; no bounds are guessed. Add
`@range <min> <max> <step>` to the adjacent comment, with finite numeric values,
`min < max` and positive `step`:

```js
// Particle count @range 1 200 1
const PARTICLE_COUNT = 60;
const orbitSpeed = 0.75; // Orbital speed @range -2 2 0.05
const INK = "#f80";
const SHOW_TRAILS = true;
const TITLE = "Orbit study";
```

The hint applies to numeric bindings in that declaration and adds a slider beside
the number field. Invalid hints fall back to a plain number field. Source values
outside the annotated bounds or off its step are never clamped or rewritten:
the number shows the exact value and the slider is disabled with an explanation
until the number/source is changed. Number-field edits must be finite, safely
representable (integers within JavaScript's safe integer range), and within any
annotated bounds; step is a stepping hint, not a source quantization rule.

Computed expressions, calls, arrays, objects, destructuring, template literals,
`let`/`var`, nested declarations, BigInt, legacy octal and unsafe integers are
not converted into literals. Unsupported direct initializers are counted in the
panel; they must be edited in code. Any parser-reported syntax error temporarily
removes the controls until the code is complete. Discovery checks syntax, not
JavaScript's full semantic validity; runtime errors still appear in the preview.
Controls have no grouping, persistent panel preferences or gesture-level
slider undo grouping (each accepted slider input is an undoable transaction).

## Install a built release

Continuous integration builds the ready-to-install payload and publishes it to
the [`dist` branch](https://github.com/weastler/p5-canvas/tree/dist), so `main`
stays source-only. Install from the latest build:

```text
https://github.com/weastler/p5-canvas/tree/dist/p5-canvas
```

Each `v*` release also pins its build at `dist-<tag>`, for example
`https://github.com/weastler/p5-canvas/tree/dist-v1.0.0/p5-canvas`, and attaches
the same payload as a zip to its
[GitHub Release](https://github.com/weastler/p5-canvas/releases). To update,
install again from the `dist` branch or a newer pinned tag, then reload
extensions. CI installs dependencies only through the configured npm proxy
registry and fails rather than falling back to public npm.

## Install locally

Requires Node.js 22+ and GitHub Copilot with extension canvas support.

```sh
npm ci
npm run install:extension
```

The checkout does not require a particular npm registry. npm uses its normal
project, user, global and environment configuration, defaulting to public npm
when none is configured. A local `.npmrc` is ignored by Git, so registry proxy
settings, scoped registry mappings and credentials can remain local. The lockfile
pins package versions and integrity but leaves registry URLs to npm, so configured
default and scoped registries can be used. To update the lockfile without recording
your registry URLs, use `npm install --package-lock-only --ignore-scripts
--omit-lockfile-registry-resolved`. No public CDN is used. The SDK comes from
the Copilot host; do not install it. The installer builds a local
CodeMirror bundle and copies an allowlisted runtime payload, the project license and
editor dependency notices into
`$COPILOT_HOME/extensions/p5-canvas` (default `~/.copilot/extensions/p5-canvas`).
It requires this project's ownership marker before updating an existing installation;
matching scaffold/template text is not proof of ownership. Unmarked installations
must be moved aside or explicitly reviewed before installation. Run it again after source changes,
then reload extensions in Copilot.

### Runtime download and registry proxies

The extension does not bundle p5.js. On first use it downloads the runtime
automatically using the configured npm registry; a valid cache is used without npm.
The preview needs Node.js 22+ and `npm` on PATH for this one-time acquisition.
**Runtime settings** (gear icon) opens only when the runtime cannot be obtained,
explaining that an organization proxy registry may be required. Enter an HTTPS
registry/proxy URL and choose **Save and retry**, or choose **Retry download**.
Editing and saving remain available; the panel closes automatically on success.

Existing npm configuration takes precedence over npm's public default: npm reads
the session working folder's `.npmrc`, user/global configuration and environment
normally. With no configured registry, npm defaults to `https://registry.npmjs.org/`.
A saved extension-specific registry overrides that configuration; leave its field
blank and save to return to npm configuration. Authentication remains in npm
configuration, not in the URL or canvas. The Copilot host may filter credential
environment variables; use an accessible npm auth configuration if needed.
Only HTTPS registry URLs without embedded credentials, query strings or fragments
are accepted.

The extension requests `p5/-/p5-1.11.11.tgz` directly under the selected registry,
not a metadata-provided alternate download host. A failed configured registry is
never retried against public npm. Registry/proxy redirects remain governed by npm.
Registry services must support the standard npm tarball path.
`npm pack --ignore-scripts` downloads the package without installing dependencies
or running package scripts. No `package.json`, lockfile, `node_modules` or sketch
files are created or changed by runtime acquisition.

The package version is pinned to **1.11.11** and its SHA-512 integrity is pinned in
the extension (matching the development lockfile). Downloads are verified before
being atomically cached; cached archives are verified again on each provider
instance before use. Only the runtime and license are read from the archive;
package paths are never extracted onto the filesystem. Once cached, opening or
retrying works offline without invoking npm. A corrupt cache is not executed and
can be replaced with **Retry download**. Saving a registry does not discard a valid
cache or force a fresh download.

Ask Copilot: **"Open the P5.js sketches canvas."** Its canvas ID is `p5-sketches`.
The `get_state` action returns the working folder (`base`), the active sketches
`folder`, and discovered scripts. `get_current_sketch` asks this canvas instance's
connected editor for a fresh snapshot, not the disk version. A successful response
contains `status: "ready"`, the absolute `path`, complete editor `content`, and
`saveStatus: { dirty, saving, conflict, error }` (`error` is a message or `null`).
It reports `no_sketch` if nothing is selected or `unavailable` if the editor is
disconnected or changing selection. Content over 128 KiB returns `too_large` with
its path, size, limit and save status, but no partial code. A project extension
with the same folder name shadows this personal extension.

With no input, the canvas uses `<session working directory>/sketches`. The SDK's
`CanvasProviderOpenRequest.session.workingDirectory` is the authoritative current
folder; `session.workspacePath` is session artifact storage, not the user's folder.
The canvas does not guess from the extension process's CWD, installation directory
or home directory. Existing files are listed immediately. The folder is checked
again on every refresh, so externally created sketches appear automatically.
If `sketches/` is missing, the empty viewer shows its destination and enables
**New sketch**. Submitting the first valid sketch creates `sketches/` and the file;
opening, cancelling, or an invalid name creates nothing.

If the runtime supplies no working directory, the canvas offers **Open an existing
folder** instead. It never writes to a guessed location. Enter an absolute path to
a folder of `.js` sketches, or a folder containing `sketches/`.

To switch later, click the folder path under the canvas title. The folder chooser
opens with the current path; close it with its **X** button or Escape to return to
the current sketch without changing folders or losing drafts. Agents can open a specific
folder directly (absolute, existing, not the filesystem root):

```json
{"folderPath": "/absolute/path/to/sketches-or-its-parent"}
```

`repositoryPath` is accepted as a deprecated alias with the same meaning. Explicit
input takes precedence over the default; invalid paths fail to open rather
than falling back elsewhere. A user-triggered folder switch lasts for the open
panel/server lifetime (including iframe reloads), not across provider restarts or
fresh panels. An explicit `folderPath` input is retained by the host for rehydration.
Default opens always follow the current session folder. If a chosen folder disappears,
the canvas offers setup rather than silently switching folders. Restore
the original folder to recover a draft, or choose another folder. `get_state` reports
`status: "missing_folder"` for unavailable explicit choices or absent session CWD.
A missing default `sketches/` instead returns `status: "ready"` with
`pendingFolder: true`, the intended folder path, and an empty sketch list.
When changing open input, use a fresh canvas instance ID
(reopening an existing instance focuses its current page without calling the
provider again).

## Sketches and editing

Put standalone p5.js global-mode JavaScript files under `sketches/` in any folder.
This repository includes `sketches/orbits.js`. Each file is an independent sketch,
using cached p5.js 1.11.11. Discovery and external edits refresh every 1.2 seconds.
The default folder is created on first sketch creation, not when opening the viewer.
Symlinks and files over 1 MiB are rejected.

Click **New sketch** (+), enter a name, and choose **Create sketch** to start a file in
the currently open sketches folder. Names may contain letters, numbers, spaces,
hyphens and underscores; `.js` is added if omitted (128 characters maximum,
including the extension). The file starts with editable p5 `setup` and `draw`
functions and opens immediately in the editor and live preview. Existing files
are never overwritten, and nested paths are not accepted. The current draft must
save successfully or its conflict be resolved before a new sketch is created.
If creation succeeds but the file cannot be opened, the error identifies the
created file so you can select it after resolving the issue.

Click **New variation** (copy) to save the current editor content, after flushing
any pending autosave, as a new file beside the original named `<name>-v<N>.js`.
An existing `-v<N>` suffix is stripped first and N is the next free number from 2,
so `flow.js` becomes `flow-v2.js` and a variation of `flow-v2.js` becomes
`flow-v3.js` (or the next unused number). Existing files are never overwritten, and
the new variation opens immediately for preview and editing.

Disk content hashes prevent saving over a version that changed since it was read.
Conflicting edits stop autosave and offer **Use disk version** or **Save my draft
instead**. Unsaved drafts are also recovered from local browser storage, keyed by
sketches folder and file, after a panel reload. This recovery is scoped to the current
loopback server's browser origin; it does not survive an extension restart that
changes the server port. Drafts remain in memory while the panel stays open if local
storage is unavailable.
Save before switching sketches. Concurrent writes by external tools
are detected optimistically; this is not a filesystem-wide locking protocol.

The CodeMirror 6 JavaScript editor provides syntax highlighting, line numbers and
undo history. Its editable text and cursor share one surface. It uses Copilot
semantic color, typography, focus and header tokens, including live app theme
changes. Editor font measurements refresh when the app theme or fonts change;
comments use the same upright monospace metrics as the rest of the text.
Token colors use the app's `--syntax-color-*` variables and follow the
selected Copilot theme, not the OS theme. The page CSP permits inline styles only so the host can
inject its managed theme `<style>` elements; scripts remain same-origin only.
Sketch artwork retains its own chosen colors.
Narrow windows stack the editor below the preview.

## Execution and limitations

Only run sketches you trust: JavaScript can still consume CPU or hang its frame.
The preview uses a sandboxed opaque-origin iframe on a separate loopback server
without editor or file access (and without the editor's capability in its URL);
its CSP blocks network requests, navigation helpers, and external assets. Scripts
cannot read the parent's save capability. Loopback-only APIs validate host,
capability URL, origin and save header, confine file creation and editing to the selected sketches folder, and
reject symlink traversal. No credentials or host bridge are exposed to sketches.

Basic single-file global-mode sketches are the scope: no ES modules, npm imports,
network fetches, external assets, or additional p5 addons. Use `windowWidth` and
`windowHeight` with `windowResized()` if you want responsive sketch dimensions.
Draft recovery is local browser storage, not a backup system.

## Data locations and distribution

Sketches and variations are ordinary `.js` files in the user's session
`sketches/` folder, or the folder explicitly selected in the canvas. They are never
stored in the installed extension's `artifacts/` directory. No global folder
preferences are written. Older versions used
`$COPILOT_HOME/extensions/p5-canvas/artifacts/folders.json` for remembered paths
only, not sketches. That legacy file is now ignored and left untouched; it cannot
redirect a default open. Recovery drafts live in browser local storage as described
above. Runtime downloads and registry settings are the only new global state:
`$COPILOT_HOME/extension-data/p5-canvas/runtime/` contains the verified
`p5-1.11.11.tgz` (including its license), npm's download cache/logs, and
`registry.json`. These never live in the sketch folder or repository.

This deliberately deviates from the usual
`$COPILOT_HOME/extensions/<name>/artifacts/` convention. The app's gist share
flow walks the installed extension folder and skips hidden entries except
`.github/`, `.gitignore`, `.npmrc`, `.nvmrc` and `.node-version`, as well as
`node_modules/`, `dist/`, `build/`, `.git/`, symlinks and submodules, so anything
under `artifacts/` would be uploaded (or block sharing if binary or oversized).
If a previous build cached a runtime or registry setting under
`extensions/p5-canvas/artifacts/runtime/`, it is copied to the new location
after verification; the original is never moved or deleted. An invalid legacy
registry setting blocks downloads until a registry setting is saved in the canvas,
instead of silently falling back to another registry.

Prepare a clean local runtime folder for review or distribution:

```sh
npm run prepare:extension
```

`dist/p5-canvas/` contains only the allowlisted runtime assets,
`copilot-extension.json`, the project license, and bundled editor dependency notices. It excludes remembered
paths, `artifacts/`, source sketches, drafts, `node_modules/`, and development files.
The command neither installs nor uploads anything and refuses to rebuild a
distribution folder containing unexpected files.

For a separate, clean installation that the app can select for a later gist share:

```sh
npm run prepare:extension -- --project
```

This prepares `.github/extensions/p5-canvas/` in this checkout, without changing
the personal installation. The generated folder is ignored by Git and contains
only runtime assets, the project license and dependency notices. The command refuses unmarked
installations and unexpected files rather than removing them. The share target is
`project:p5-canvas` in this workspace; a project extension with this name shadows
the personal `user:p5-canvas` in this workspace when extensions are next reloaded.
Preparing it does not reload extensions or upload anything.

Upgrades never delete files. An installation upgraded from an older version can
still contain the oversized bundled `vendor/p5.min.js`, `vendor/p5-license.txt`,
retired source files, and private `artifacts/` data (remembered folders, older
runtime caches). The share flow would include them, and the 1 MB p5 file makes
sharing fail. `npm run install:extension` lists every such file it finds; move
them out of the extension folder yourself before sharing. The share command
selects an installed extension, not the prepared `dist/` folder; the separate
project-scoped installation avoids these legacy files.

The host gist-sharing format has per-file and total size limits. The prepared
payload omits p5.js and the installer tests check that every file fits the
1 MiB per-file limit. Gist publication has not been attempted or verified.
Repository-URL installation must point to a
complete runtime payload with the generated editor assets, such as the `dist`
branch's `p5-canvas/` folder; the source `extension/` folder alone is not a
ready-to-install distribution.

This project's code is licensed under MIT; see `LICENSE`. Bundled third-party
notices are `vendor/editor-licenses.txt` (the CodeMirror/Lezer editor dependencies,
MIT). The downloaded p5.js package retains its `package/license.txt` (LGPL-2.1)
in the verified cache. These notices do not establish release or licensing
compliance; source/redistribution obligations and publication approval still
require review before distribution.

## Development

```sh
npm test
npm run install:extension
```

Source is in `extension/`; the installed entry point is `extension.mjs`.
The browser regression uses an installed Chromium-based browser; set
`P5_TEST_BROWSER` to its executable if it is not found automatically.
Reload extensions after installation. No server runs until the canvas is opened;
closing it releases its loopback server.
