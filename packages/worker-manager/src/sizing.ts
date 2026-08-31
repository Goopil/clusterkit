import os from "node:os";
import { getCgroupCpuLimit } from "./cgroup";

/**
 * Returns the number of logical CPUs available.
 * On Linux, if a cgroup CPU limit is set (e.g. Kubernetes / Docker),
 * returns the lower of the cgroup limit and the host CPU count.
 */
export function getCPUCount(): number {
  const hostCpus = os.availableParallelism();

  const cgroupLimit = getCgroupCpuLimit();
  if (cgroupLimit !== null && cgroupLimit < hostCpus) {
    return cgroupLimit;
  }

  return hostCpus;
}
