import { fileURLToPath } from "node:url";
import { Orchestrator } from "@goopil/clusterkit";
import { createFileWatcherPlugin } from "@goopil/clusterkit-file-watcher";
import { createSignalRestartPlugin } from "@goopil/clusterkit-signal-restart";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import express from "express";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  // Anchor watch paths to this file's location instead of the current working
  // directory, so watching also works in the Docker harness (cwd = /app).
  const here = fileURLToPath(new URL(".", import.meta.url));

  orchestrator
    .use(createContainerSizingPlugin())
    .use(createSignalRestartPlugin()) // SIGHUP → rolling restart
    .use(
      createFileWatcherPlugin({
        // File changes → rolling restart
        watch: [here],
        envFile: fileURLToPath(new URL("../.env", import.meta.url)),
        debounceMs: 300,
      }),
    )
    .run(async () => {
      const app = express();
      app.get("/", (_req, res) => {
        res.json({
          hello: "world",
          pid: process.pid,
          restartKey: process.env.APP_KEY ?? "not-set",
        });
      });

      const server = app.listen({
        port: +(process.env?.PORT || 3010),
        host: "0.0.0.0",
        exclusive: capabilities.reusePort,
        reusePort: capabilities.reusePort,
      });

      orchestrator.registerOnShutdown(() => {
        server.close();
      });

      console.log(`Worker ${process.pid} listening on port ${process.env.PORT || 3010}`);
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
