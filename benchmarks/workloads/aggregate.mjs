import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(readFileSync(join(__dirname, "..", "data", "records.json"), "utf8"));

export default function aggregate(_req, res) {
  const byCategory = {};
  const topAmounts = [];

  for (const r of records) {
    if (r.status === "completed") {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      if (topAmounts.length < 5 || r.amount > topAmounts[0].amount) {
        topAmounts.push({ id: r.id, amount: r.amount });
        topAmounts.sort((a, b) => a.amount - b.amount);
        if (topAmounts.length > 5) topAmounts.shift();
      }
    }
  }

  const totalCompleted = Object.values(byCategory).reduce((a, b) => a + b, 0);

  res.json({
    categories: byCategory,
    totalCompleted,
    topAmounts: topAmounts.reverse(),
    pid: process.pid,
  });
}
