import { createHmac } from "node:crypto";

const SECRET = "bench-secret-key-2026";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjQyLCJyb2xlIjoiYWRtaW4iLCJleHAiOjE5OTk5OTk5OTl9";
const PAYLOAD = JSON.stringify({ userId: 42, role: "admin", exp: 1999999999 });

export default function authVerify(_req, res) {
  const hmac = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
  const payload = JSON.parse(PAYLOAD);

  res.json({
    valid: hmac.length === 64,
    userId: payload.userId,
    role: payload.role,
    exp: payload.exp,
    pid: process.pid,
  });
}
