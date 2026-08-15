export default function latency10ms(_req, res) {
  setTimeout(() => {
    res.json({ hello: "world", pid: process.pid });
  }, 10);
}
