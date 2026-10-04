// ClusterKit demo server: 2 workers, crash recovery, zero-downtime hot restart.
// Used by demo.tape (vhs) to record the animated README screenshot.
import { createServer } from "node:http";
import { createSignalRestartPlugin } from "../../packages/plugin-signal-restart/dist/index.mjs";
import { Orchestrator } from "../../packages/worker-manager/dist/index.mjs";

const orchestrator = new Orchestrator({
  workers: { count: 2 },
  logger: console,
});

// `kill -HUP <primary-pid>` triggers a rolling restart with zero dropped connections.
orchestrator.use(createSignalRestartPlugin());

orchestrator.run(async ({ listen }) => {
  const server = createServer((_req, res) => {
    res.end(`served by pid ${process.pid}\n`);
  });
  listen(server, { port: 4321 });
});
