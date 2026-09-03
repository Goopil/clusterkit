const cluster = require("node:cluster");

const mode = process.env.WM_IT_MODE ?? "cooperative";
const messagePrefix = process.env.WM_IT_MESSAGE_PREFIX ?? "__wm";
const shutdownType = `${messagePrefix}:shutdown`;
const shutdownAckType = `${messagePrefix}:shutdown-ack`;

const keepAlive = setInterval(() => {
  // Keep event loop alive for shutdown/kill assertions.
}, 1_000);

function sendAck() {
  if (typeof process.send === "function") {
    process.send({ type: shutdownAckType });
  }
}

function setupCooperativeHandlers() {
  process.on("message", (msg) => {
    if (!msg || msg.type !== shutdownType) {
      return;
    }

    sendAck();

    const shutdownDelayMs = Number(process.env.WM_IT_SHUTDOWN_DELAY_MS ?? "0");
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(0);
    }, shutdownDelayMs).unref();
  });

  process.on("disconnect", () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
}

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});

  process.on("message", () => {
    // Intentionally ignore shutdown messages.
  });
} else if (mode === "crash-loop-single") {
  const workerId = cluster.worker?.id ?? 0;
  const shouldCrash = workerId % 2 === 1;

  if (shouldCrash) {
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(1);
    }, 25).unref();
  } else {
    setupCooperativeHandlers();
  }
} else if (mode === "crash-loop-all") {
  setTimeout(() => {
    clearInterval(keepAlive);
    process.exit(1);
  }, 25).unref();
} else {
  setupCooperativeHandlers();
}
