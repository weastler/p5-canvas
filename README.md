# P5.js Canvas

Create generative art and animations inside **GitHub Copilot**. Open a p5.js
sketch, edit its JavaScript beside a live preview, and see your changes immediately.

https://github.com/user-attachments/assets/25f7c3c0-134a-4e07-9477-b0145ee08824

*A real canvas demo: switch sketches, edit code with autosave, open controls,
and switch between dark and light themes.*

- **Live editing:** changes rerun the preview and autosave.
- **Sketch controls:** adjust supported constants with sliders, colors and toggles.
- **Room to experiment:** create sketches and variations; hide the editor for a larger preview.

## Install

Requires the **GitHub Copilot app with canvas-extension support**, plus
**Node.js 22+ and npm**. Choose one installation method, not both.

### Direct extension

Ask Copilot:

```text
Install the P5.js Canvas extension from
https://github.com/weastler/p5-canvas/tree/dist-v1.0.0/p5-canvas
```

Or, in the app, open **Customize → Install canvas extension** and paste a folder URL:

- Latest: `https://github.com/weastler/p5-canvas/tree/dist/p5-canvas`
- Pinned: `https://github.com/weastler/p5-canvas/tree/dist-v1.0.0/p5-canvas`. For another
  version, replace `dist-v1.0.0` with its `dist-v*` tag or a commit ID from the `dist` branch.

The URL must point to the `p5-canvas` folder, not the repository root.

### Manual ZIP

Download [`p5-canvas-v1.0.0.zip`](https://github.com/weastler/p5-canvas/releases/download/v1.0.0/p5-canvas-v1.0.0.zip)
and extract its `p5-canvas/` folder into `~/.copilot/extensions/`, so the result is
`~/.copilot/extensions/p5-canvas/`. Then reload extensions or restart the app.

### Plugin

In Copilot CLI, run:

```sh
copilot plugin marketplace add weastler/p5-canvas
copilot plugin install p5-canvas@p5-canvas
```

Or add `weastler/p5-canvas` in the app's **Customize** marketplace settings
and install **p5-canvas**. The CLI route is verified; the Customize UI route
has not yet been tested. This plugin requires a Copilot host with canvas support.

The [v1.0.0 release](https://github.com/weastler/p5-canvas/releases/tag/v1.0.0)
includes both download packages and a
[pinned plugin snapshot](https://github.com/weastler/p5-canvas/tree/dist-v1.0.0).
The repository marketplace follows the latest build.

## Make something

Start a new session and ask: **"Open the P5.js sketches canvas."**

Use **New sketch** (+), or put a standalone p5.js `.js` file in your working
folder's `sketches/` directory. Select it from the dropdown and start editing.
Your sketches stay as ordinary files; conflicting disk edits pause autosave.

The first preview downloads p5.js 1.11.11 and caches it for offline use.
If the download fails, the canvas offers a registry-proxy setting.
Only run sketches you trust. Network requests, external assets and module imports
are not supported in the sandboxed preview.

To update, run `copilot plugin update p5-canvas@p5-canvas`, or reinstall the direct
extension from a newer release. Start a new session after updating.

## License

[MIT](LICENSE). The distribution includes editor dependency notices;
the downloaded p5.js runtime retains its LGPL-2.1 license.
