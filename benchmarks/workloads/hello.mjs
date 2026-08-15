export default function hello(_req, res) {
  res.json({ hello: "world", pid: process.pid });
}
