export default function errorRate(_req, res) {
  if (Math.random() < 0.1) {
    res.status(500).json({
      error: "Internal error",
      code: 500,
      message: "simulated failure",
      pid: process.pid,
    });
    return;
  }

  res.json({
    success: true,
    data: { id: Math.floor(Math.random() * 10000), status: "ok" },
    pid: process.pid,
  });
}
