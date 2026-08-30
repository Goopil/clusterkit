export async function checkPidDistribution(url, totalRequests = 100, batchSize = 20) {
  const distribution = {};

  for (let i = 0; i < totalRequests; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, totalRequests - i) }, () =>
      fetch(url).then((r) => r.json()),
    );
    const responses = await Promise.all(batch);
    for (const body of responses) {
      if (body?.pid) {
        const pidKey = String(body.pid);
        distribution[pidKey] = (distribution[pidKey] || 0) + 1;
      }
    }
  }

  const activePids = Object.keys(distribution).length;
  return { active: activePids, distribution };
}
