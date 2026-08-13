import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pm2 from "pm2";

const __dirname = dirname(fileURLToPath(import.meta.url));

const script = join(__dirname, "..", "pm2-server.mjs");
const workload = process.env.BENCH_WORKLOAD || "hello";
const port = Number.parseInt(process.env.PORT || "3100", 10);

pm2.connect((err) => {
  if (err) {
    console.error("pm2 connect failed:", err);
    process.exit(1);
  }

  pm2.start(
    {
      name: "bench-target",
      script,
      instances: 3,
      exec_mode: "cluster_mode",
      env: { PORT: String(port), BENCH_WORKLOAD: workload },
    },
    (err2) => {
      if (err2) {
        console.error("pm2 start failed:", err2);
        pm2.disconnect();
        process.exit(1);
      }
    },
  );
});

process.on("SIGTERM", () => {
  pm2.delete("all", () => {
    pm2.killDaemon(() => {
      pm2.disconnect();
      process.exit(0);
    });
  });
});

process.on("SIGINT", () => {
  pm2.delete("all", () => {
    pm2.killDaemon(() => {
      pm2.disconnect();
      process.exit(0);
    });
  });
});
