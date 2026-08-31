# Resilience / Reliability — Audit clusterkit 2026-08-31

Le produit est un gestionnaire de résilience — c'est le domaine le plus critique. L'architecture de shutdown (ACK protocol, escalade SIGTERM→SIGINT→SIGKILL, breaker) est solide et bien testée. Les trous trouvés sont dans les **chemins croisés** (recycle × shutdown, restart × shutdown) et dans une API documentée morte.

## Score résilience: 6.5/10

## Modes de défaillance (par scénario)

### Scénario 1 — Déploiement (SIGTERM sur primaire multi-workers)

| Étape | Comportement | Problème |
|---|---|---|
| Drain workers | ACK protocol + budget 12s | Sain, bien testé |
| Callbacks `registerOnShutdown` | **Jamais appelés** | AUDIT-001 (High) |
| Flush OTLP | **Perdu** (dépend d'AUDIT-001) | AUDIT-012 |
| Exit du primaire | Peut pendre jusqu'à 30s (timer backoff non unref) | AUDIT-004 |
| Cleanup file-watcher | OK via uninstall; **sauf** si startDelay en cours → watchers fantômes, event loop tenue | AUDIT-014 |

C'est le scénario le plus fragile du produit — et c'est un scénario qui se produit à chaque déploiement.

### Scénario 2 — Crash loop applicatif

- Sliding window breaker (5/60s), readiness flip, backoff exponentiel avec stability window: **sain et bien testé** (unit + orchestrator).
- Lacunes: items déjà en queue au moment du trip re-forkent une fois (acceptable, borné par le backoff); breaker trip **silencieux** si aucun logger/listener (AUDIT-010).
- Récupération: `resetCircuitBreaker()` refait la capacité manquante — correct et testé.

### Scénario 3 — Recycle / hot-restart en production

- Escalade de drain codée en dur 5s/2s vs budget configuré 12s (AUDIT-002) → SIGKILL des drains longs.
- Recycle × shutdown: guards présents (`orchestrator.ts:818,825`, `worker-manager.ts:150-153`) mais **non testés** — suppression → SIGKILL pendant shutdown sans que CI rougisse (AUDIT-033 item 2).
- `restartWorkers` × shutdown: break présent, non testé, événement `restart:complete` émis à tort (AUDIT-003).

### Scénario 4 — Dépendance externe tombe

- Collector OTEL down: exporter retry, shutdown non bloqué au-delà du timeout exporter — **sain** (vérifié).
- Prometheus: scrapes pendant incident → fuite AggregatorRegistry (AUDIT-019) + amplification IPC (AUDIT-021).
- Filesystem: chokidar sur chemins inexistants ne crash pas (vérifié) mais no-op silencieux dans le run Docker documenté (AUDIT-032).

### Scénario 5 — Le primaire lui-même meurt

- Workers deviennent orphelins à la mort du primaire (pas de mécanisme parent-watchdog). En conteneur (cas cible), le runtime nettoie. Bare-metal: les workers continuent de servir (avec reusePort) l'ancienne version après un crash du primaire → split-brain de versions si un nouveau primaire démarre. **Likely, Low** — hors périmètre du produit (cluster Node) mais à documenter dans le README (limites).
- Fenêtre de boot sans handlers de signaux (AUDIT-009): SIGTERM pendant le fork initial → orphelins.

## Races analysées (question posée: "même opération exécutée deux fois simultanément ?")

- `restartWorkers()` double appel: guard `restartInProgress` — correct, testé.
- Shutdown double: guard `isShuttingDown` + `localShutdownInProgress` — correct, testé (signal + IPC concurrents).
- Crash pendant recycle: capacity formula `activeWorkers - recyclingCount` — correcte et testée (`test/orchestrator.test.ts:1338-1358`).
- Backoff × shutdown: double-check après l'attente — correct, testé.
- Boot: signal handlers après fork (AUDIT-009) — petite fenêtre réelle.

## Question "le système peut-il retourner succès alors que l'opération n'est pas terminée ?"

**Oui, trois fois:**
1. `shutdownPrimary` pose `process.exitCode = 0` sans avoir exécuté les callbacks enregistrés (AUDIT-001) — succès mensonger pour le cleanup.
2. `restart:complete` émis avec une liste partielle après abandon (AUDIT-003).
3. file-watcher: restart "réussi" avec l'ancien env après changement de `.env` (AUDIT-015) — l'opération métier (reload de config) n'a pas eu lieu.

## Recovery & idempotence

- Idempotence des opérations double-exécutées: bonne (guards ci-dessus), sauf install/uninstall cycles des plugins (AUDIT-018, AUDIT-020) et install partiel sans rollback (AUDIT-005).
- Pas de persistance d'état: pas de risque de corruption de données côté core. L'"intégrité de données" du produit = env des workers et métriques — couverts par AUDIT-015 et AUDIT-012.
