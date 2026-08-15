export default function cpuIoMix(_req, res) {
  const start = performance.now();
  while (performance.now() - start < 1) {
    Math.sqrt(Math.random() * 1000000);
  }
  setTimeout(() => {
    res.json({ hello: "world", pid: process.pid });
  }, 2);
}
