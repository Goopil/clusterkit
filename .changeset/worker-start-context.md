---
"@goopil/clusterkit": minor
---

Add a worker start context to `run(start)`: the callback now receives `{ listen, shutdown }`.

`ctx.listen(server, opts?)` binds any Node-style listen target (express app, raw `http.Server`, Koa, Fastify/NestJS raw
server) with the right platform flags — `SO_REUSEPORT` + `exclusive` where the kernel balances connections, cluster IPC
round-robin otherwise — replacing the manual `Orchestrator.getCapabilities()` + `exclusive`/`reusePort` dance. Defaults
to the `PORT` env var (fallback 3000) on `0.0.0.0` and returns the bound server. `ctx.shutdown(cb)` registers a worker
shutdown callback, same as `orchestrator.registerOnShutdown(cb)`.

Fully backward compatible: existing `run()` callbacks keep working unchanged, and `registerOnShutdown()` /
`getCapabilities()` remain available.

```js
orchestrator.run(async ({ listen, shutdown }) => {
  const server = listen(app); // PORT || 3000, 0.0.0.0, platform flags handled
  shutdown(() => server.close());
});
```
