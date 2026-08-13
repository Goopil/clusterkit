export default function uploadEcho(req, res) {
  if (!req.body?.name || !req.body.email) {
    res.status(400).json({
      error: "Validation failed",
      code: 400,
      message: "name and email are required",
      pid: process.pid,
    });
    return;
  }

  res.json({
    received: true,
    echo: {
      name: req.body.name,
      email: req.body.email,
      age: req.body.age || null,
      tags: req.body.tags || [],
    },
    timestamp: Date.now(),
    pid: process.pid,
  });
}
