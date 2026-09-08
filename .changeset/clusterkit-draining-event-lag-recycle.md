---
"@goopil/clusterkit": minor
---

feat: emit `worker:draining` at the recycle decision — before the network drain starts — with `{ workerId, pid, reason }`. This is the moment new work should stop being routed to the worker (age-based recycling, RSS/wedged/lag recycles and rolling restarts all converge on it). For TCP the listening socket and established connections are separate, so closing the listen socket in a `worker:draining` handler removes the worker from the `SO_REUSEPORT` group immediately while existing connections keep draining (Linux ≥ 5.10 migrates in-flight connection requests to remaining group members).

feat: add `health.maxEventLoopLagMs` — recycle a worker whose reported event-loop lag exceeded this value (ms) for `health.lagRecycleBeats` (default 3) consecutive beats, through the same bounded drain as the other health policies. Catches "slow but alive" workers that the wedged (heartbeat silence) policy never sees. Opt-in (`0` = disabled), requires `health.heartbeatMs > 0`. `worker:recycle` gains the `"lag"` reason.
