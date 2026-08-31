# Tests — Audit clusterkit 2026-08-31

## Score testing: 7/10

## État réel

- **Seuils:** lignes/fonctions/statements 85, branches 75, **global seulement** (aucun per-file). 6 packages vitest + Sonar + Codecov branchés.
- **Qualité unit:** rigoureuse — guards, idempotence, env-safety, fake timers disciplinés, `settleWithinBudget` self-bounding. `forcedKills` est la métrique la mieux couverte de la suite.
- **Intégration réelle:** `orchestrator.integration.test.ts` + `stress.test.ts` forkent de vrais workers (fixtures coopératives/stubborn/crash-loop) — mais seulement 5 tests, exécutés sur toutes les matrices y compris macOS (timeout 8s, flake possible).
- **Couverture externe:** Codecov n'upload que 3 packages; otlp/signal-restart/file-watcher sans gate externe; codecov `default`/`patch` non bloquants.

## Bugs que je pourrais introduire aujourd'hui sans qu'aucun test ne les empêche (liste vérifiée)

Voir AUDIT-033 pour la liste complète des 11 mutations "CI-green" et leurs emplacements. Top 5 par danger:

1. Supprimer `gracefulShutdowns++` — dashboards sous-comptent, zéro échec.
2. Supprimer les guards shutdown des timers d'escalade de drain (`orchestrator.ts:818,825`) — SIGKILL pendant shutdown.
3. `shift()`→`pop()` — l'ordre FIFO des restarts n'est jamais asserté.
4. `every`→`some` dans `waitForWorkersToExit` — shutdown "réussi" avec un worker vivant.
5. Retirer le try/catch de `runShutdownCallbacks` — un callback throwant casse le drain.

## Gaps structurels

1. **Mock cluster intégral dans orchestrator.test.ts** (1726 lignes, zéro fork réel). Tradeoff légitime (vitesse/déterminisme), mais le MockWorker encode des sémantiques (`exitedAfterDisconnect` posé par le primaire) légèrement différentes du vrai cluster — les régressions de drain réel ne peuvent être vues que par les 5 tests d'intégration.
2. **Chemins croisés non couverts:** recycle × shutdown, restartWorkers abort, installPlugins en échec, `setReady()`, `stabilityWindowMs: 0`, grammaire WEB_CONCURRENCY (AUDIT-007/033).
3. **Ce que CI n'exécute jamais:** smoke test des exemples (mort — AUDIT-031), smoke benchmarks, assertion `reusePort === true` sous Linux (le job s'appelle "Test (Linux Docker — SO_REUSEPORT)" sans jamais l'assertion), aucune gate de perf.
4. **Fragilités:** file-watcher.test.ts (chokidar réel + sleeps 500ms — plus grosse source de flake), intégration macOS avec timeouts serrés, une assertion conditionnelle (`if (restartTimestamps.length >= 2)`) qui saute silencieusement le check central d'un test backoff, deux tests backoff byte-identiques (l'un des deux comportements visés n'existe pas).
5. **Couplage implémentation:** accès aux privates (`pendingRestartQueue`, `restartLoopRunning`, `workerManager.*`) — cassera au refactoring, valide des comportements inatteignables via l'API publique.

## Scénarios de régression à ajouter (priorisés)

1. **Invariant shutdown 3 modes** (paramétré): callbacks + uninstall exécutés dans primaire-multi / single / worker — ferme AUDIT-001 et garde AUDIT-012.
2. **Métriques de flotte:** `gracefulShutdowns`, et un test "aucune métrique ne peut être supprimée" (assertion croisée après scénario complet).
3. **Recycle × shutdown:** drain en cours + SIGTERM → pas de SIGKILL, pas de fork post-initiation.
4. **restartWorkers abort:** pas de `restart:complete` (ou flag `aborted`), aucun fork après initiation.
5. **Ordre FIFO de la queue de restart** par workerId.
6. **installPlugins failure:** nom du plugin dans l'erreur + rollback des précédents.
7. **`waitForWorkersToExit` avec 1 vivant / N morts** (négatif).
8. **WEB_CONCURRENCY table:** `1e3`, `0`, `-3`, `NaN`, ` 8 ` (comportements pinned).
9. **Linux-only (harness docker):** `supportsReusePort() === true`.
10. **Plugins:** env payload conservé (AUDIT-015), startDelay annulé (AUDIT-014), reinstall prometheus (AUDIT-020), otlp flush sur SIGTERM réel (AUDIT-012).

## Tests de charge/résilience/sécurité absents

- Charge: aucun (les benchmarks existent mais hors CI — acceptable; un smoke boot suffit en gate, AUDIT-031).
- Résilience: les scénarios 2-4 ci-dessus sont les tests de résilience manquants.
- Sécurité: les tests de blocklist execArgv existent (bon point); ajouter les nouveaux patterns si AUDIT-025 est appliqué.
