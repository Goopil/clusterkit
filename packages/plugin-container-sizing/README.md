# `@goopil/clusterkit-sizing`

Container-aware sizing plugin for `@goopil/clusterkit`.

It reads cgroup CPU/memory limits (Linux v1/v2), computes worker/heap sizing, then optionally applies that plan to the
orchestrator before workers are forked.

## Capabilities

| Capability | Details |
|------------|---------|
| cgroup discovery | Reads Linux cgroup v1/v2 limits (`cpu` + `memory`) |
| Sizing strategies | `balanced`, `cpu-first` |
| Worker count automation | Can override worker count when orchestrator is configured with `workers.count: 'auto'` |
| Heap tuning | Computes and injects `--max-old-space-size` into worker `NODE_OPTIONS` |
| Safe fallback mode | Optional fallback to OS CPU/memory when no cgroup limits are present |
| Introspection | Exposes the computed plan via `plugin.sizing` |

## Installation

```bash
pnpm add @goopil/clusterkit-sizing
```

## Usage

```ts
import { Orchestrator } from "@goopil/clusterkit";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";

const orchestrator = new Orchestrator({ logger: console });
const sizing = createContainerSizingPlugin();

orchestrator.use(sizing).run(async () => {
  // your app bootstrap
});

// available after install() on primary
console.log(sizing.sizing);
```

## Options (`ContainerSizingOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `memoryOverheadFactor` | `number` | `0.80` | Fraction of total memory considered usable |
| `heapRatio` | `number` | `0.75` | Fraction of per-worker memory used for V8 old-space |
| `minWorkers` | `number` | `1` | Minimum worker count |
| `maxWorkers` | `number` | `64` | Maximum worker count |
| `strategy` | `'balanced' \| 'cpu-first'` | `'balanced'` | Worker/heap sizing strategy |
| `overrideWorkerCount` | `boolean` | `true` | Applies computed worker count when orchestrator is `workers.count: 'auto'` |
| `injectNodeOptions` | `boolean` | `true` | Injects computed `--max-old-space-size` into worker `NODE_OPTIONS` |
| `extraNodeOptions` | `string` | `undefined` | Extra flags appended to `NODE_OPTIONS` |
| `fallback` | `boolean` | `true` | If no cgroup limits exist, use OS resources (`false` = skip plugin) |

## Strategies

| Strategy | Behavior |
|----------|----------|
| `balanced` | `floor(cpu)` workers, reduced when each would get less than 128 MB of V8 heap (default) |
| `cpu-first` | Always `floor(cpu)` workers; the heap is clamped to the 128 MB viability floor (may over-commit memory, see `constrained`) |

## Result object (`ContainerSizingPlugin.sizing`)

After plugin installation on primary, `sizing.sizing` contains:

- `workers`
- `memoryPerWorkerMb`
- `v8HeapMb`
- `constrained` (`true` when the heap was clamped up to the 128 MB viability floor — memory is over-committed)
- `nodeOptions`
- `source` (detected limits + host fallback values)

## Related docs

- [Root README](../../README.md)
- [Core package README](../worker-manager/README.md)