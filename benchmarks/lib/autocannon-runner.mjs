import autocannon from "autocannon";

export async function runAutocannon({ url, connections, durationSec, warmupSec }) {
  if (warmupSec > 0) {
    await autocannon({
      url,
      connections,
      duration: warmupSec,
      pipelining: 1,
      reuseConnections: true,
      ignoreUNIXErrors: true,
    });
  }

  const result = await autocannon({
    url,
    connections,
    duration: durationSec,
    pipelining: 1,
    reuseConnections: true,
    ignoreUNIXErrors: true,
  });

  return {
    rps: result.requests.average,
    latencyP50: result.latency.p50,
    latencyP95: result.latency.p97_5 ?? result.latency.p90,
    latencyP99: result.latency.p99,
    errors: result.errors + result.timeouts,
    rpsTotal: result.requests.total,
  };
}

export async function runScenario({ url, connections, warmupSec, measureSec, repetitions }) {
  const runs = [];
  for (let i = 0; i < repetitions; i++) {
    const run = await runAutocannon({ url, connections, durationSec: measureSec, warmupSec });
    runs.push(run);
  }

  const rpsValues = runs.map((r) => r.rps).sort((a, b) => a - b);
  const median = rpsValues[Math.floor(rpsValues.length / 2)];
  const min = rpsValues[0];
  const max = rpsValues[rpsValues.length - 1];
  const stddev = rpsValues.length > 1 ? calcStddev(rpsValues) : 0;

  const latP50Values = runs.map((r) => r.latencyP50).sort((a, b) => a - b);
  const latP95Values = runs.map((r) => r.latencyP95).sort((a, b) => a - b);
  const latP99Values = runs.map((r) => r.latencyP99).sort((a, b) => a - b);

  const latMedian = (arr) => arr[Math.floor(arr.length / 2)];

  return {
    rps: {
      median: Math.round(median),
      min: Math.round(min),
      max: Math.round(max),
      stddev: Math.round(stddev),
      runs: rpsValues.map((v) => Math.round(v)),
    },
    latency: {
      p50: Number(latMedian(latP50Values).toFixed(1)),
      p95: Number(latMedian(latP95Values).toFixed(1)),
      p99: Number(latMedian(latP99Values).toFixed(1)),
      p50Runs: latP50Values.map((v) => Number(v.toFixed(1))),
      p95Runs: latP95Values.map((v) => Number(v.toFixed(1))),
      p99Runs: latP99Values.map((v) => Number(v.toFixed(1))),
    },
    errors: runs.reduce((sum, r) => sum + r.errors, 0),
  };
}

function calcStddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
