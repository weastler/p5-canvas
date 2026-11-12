import { createServer } from "node:http";

export async function startRunner(runtime) {
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
    try {
      if (!runtime.source) {
        res.statusCode = 503;
        res.end("p5.js is not ready. Use the canvas Runtime settings to download or retry.");
        return;
      }
      const source = runtime.source.replace(/<\/script/gi, "<\\/script");
      res.end(`<!doctype html><meta charset="utf-8"><style>
        html,body{margin:0;overflow:auto}canvas{display:block}
        </style><body><script>${source}</script><script>
        const report = message => parent.postMessage({type:"p5-error", message:String(message)}, "*");
        addEventListener("error", event => report(event.message));
        addEventListener("unhandledrejection", event => report(event.reason));
        let started = false;
        addEventListener("message", event => {
          if (started || event.source !== parent || event.data?.type !== "p5-run") return;
          started = true;
          try {
            document.body.style.background = event.data.background;
            (0, eval)(event.data.content);
            new p5();
          } catch (error) { report(error.message); }
        });
        </script>`);
    } catch (error) {
      res.statusCode = 500;
      res.end("p5.js is unavailable. Use the canvas Runtime settings to retry.");
      console.error("p5 runner:", error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
