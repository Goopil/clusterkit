import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const USER_HZ = (() => {
  try {
    return Number.parseInt(execSync("getconf CLK_TCK", { encoding: "utf8" }).trim(), 10) || 100;
  } catch {
    return 100;
  }
})();

export class ProcSampler {
  constructor(rootPid, intervalMs = 1000) {
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
    this.snapshots = [];
    this.peakRssKb = 0;
    this.cpuTimeMsTotal = 0;
    this._prevCpuJiffies = null;
    this._timer = null;
    this._running = false;
  }

  start() {
    this._running = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    return this.snapshots;
  }

  _tick() {
    try {
      const pids = this._collectPids(this.rootPid);
      let rssKb = 0;
      let peakRssKb = 0;
      let cpuJiffies = 0;

      for (const pid of pids) {
        const status = this._readStatus(pid);
        const stat = this._readStat(pid);
        if (status) {
          rssKb += status.rssKb || 0;
          peakRssKb = Math.max(peakRssKb, status.hwmKb || 0);
        }
        if (stat) {
          cpuJiffies += stat.utime + stat.stime;
        }
      }

      this.peakRssKb = Math.max(this.peakRssKb, peakRssKb);

      let cpuPercent = 0;
      let cpuDeltaMs = 0;
      if (this._prevCpuJiffies !== null) {
        const jiffiesDelta = cpuJiffies - this._prevCpuJiffies;
        const intervalSec = this.intervalMs / 1000;
        cpuPercent = (jiffiesDelta / (USER_HZ * intervalSec)) * 100;
        cpuDeltaMs = (jiffiesDelta / USER_HZ) * 1000;
        this.cpuTimeMsTotal += cpuDeltaMs;
      }
      this._prevCpuJiffies = cpuJiffies;

      const t = this.snapshots.length * (this.intervalMs / 1000);
      this.snapshots.push({
        t: Number(t.toFixed(1)),
        rssKb,
        cpuPercent: Number(cpuPercent.toFixed(1)),
        pids: [...pids],
        pidCount: pids.length,
      });
    } catch {}
  }

  _collectPids(rootPid, seen = new Set()) {
    if (seen.has(rootPid)) return seen;
    seen.add(rootPid);

    try {
      const children = this._readChildren(rootPid);
      for (const pid of children) {
        this._collectPids(pid, seen);
      }
    } catch {}
    return seen;
  }

  _readChildren(pid) {
    try {
      const content = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
      return content.trim().split(/\s+/).filter(Boolean).map(Number.parseInt);
    } catch {
      return [];
    }
  }

  _readStatus(pid) {
    try {
      const content = readFileSync(`/proc/${pid}/status`, "utf8");
      const rssMatch = content.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      const hwmMatch = content.match(/^VmHWM:\s+(\d+)\s+kB$/m);
      return {
        rssKb: rssMatch ? Number.parseInt(rssMatch[1], 10) : 0,
        hwmKb: hwmMatch ? Number.parseInt(hwmMatch[1], 10) : 0,
      };
    } catch {
      return null;
    }
  }

  _readStat(pid) {
    try {
      const content = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parts = content.split(" ");
      const utime = Number.parseInt(parts[13], 10);
      const stime = Number.parseInt(parts[14], 10);
      return { utime, stime };
    } catch {
      return null;
    }
  }

  getStats() {
    if (this.snapshots.length === 0) {
      return { avgRssKb: 0, peakRssKb: 0, avgCpuPercent: 0, cpuTimeMs: 0 };
    }
    const avgRssKb = Math.round(this.snapshots.reduce((sum, s) => sum + s.rssKb, 0) / this.snapshots.length);
    const avgCpuPercent = Number(
      (this.snapshots.reduce((sum, s) => sum + s.cpuPercent, 0) / this.snapshots.length).toFixed(1),
    );
    return {
      avgRssKb,
      peakRssKb: this.peakRssKb,
      avgCpuPercent,
      cpuTimeMs: Math.round(this.cpuTimeMsTotal),
    };
  }
}
