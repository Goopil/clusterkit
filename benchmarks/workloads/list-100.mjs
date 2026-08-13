import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(readFileSync(join(__dirname, "..", "data", "records.json"), "utf8"));

export default function list100(req, res) {
  const page = Number.parseInt(req.query?.page || "1", 10);
  const limit = 100;
  const start = (page - 1) * limit;
  const slice = records.slice(start, start + limit);
  res.json({ data: slice, page, total: records.length, pid: process.pid });
}
