# Architecture — Audit clusterkit 2026-08-31

## Score architecture: 9/10

## Carte actuelle (modèle mental)

```
Orchestrator (facade EventEmitter, 1011 lignes)
├── WorkerManager ......... fork / tracking / age-recycling / execArgv
├── ShutdownCoordinator ... ACK protocol + escalade SIGTERM→SIGINT→SIGKILL
├── SignalHandler ......... register/unregister POSIX (mini, sain)
├── CrashTracker .......... sliding-window breaker (63 lignes)
├── validation.ts ......... config → ResolvedConfig + garde prototype/env/execArgv
├── platform.ts / sizing.ts / cgroup.ts ... capacités + sizing
└── plugins (install avant fork, primaire ET workers)
    ├── prometheus (registres: primaire counters/gauges + AggregatorRegistry IPC)
    ├── container-sizing (cgroup → overrideWorkerCount)
    ├── otlp-meter (MeterProvider OTel, primaire + workers)
    ├── signal-restart (SIGHUP → restartWorkers / exit single)
    └── file-watcher (chokidar + .env parse → restartWorkers overlay)
```

**Points forts réels:**
- Décomposition nette, pas de God object: `orchestrator.ts` est une façade (les services portent la logique); 1011 lignes pour le composant le plus central d'un produit de ce type est raisonnable.
- Pas de cycle runtime: les imports croisés orchestrator↔types sont type-only (érasés).
- Injection `clusterModule` pour les tests — la seule couture nécessaire, pas plus.
- Plugin system minimaliste (name + install + uninstall optionnel) — pas d'abstraction spéculative.
- `safeEmit` isole les erreurs de listeners du control flow interne — décision de design rare et correcte.
- Zéro dépendance runtime du core tenue (vérifié dans package.json).

## Problèmes structurels

### 1. Contrat asymétrique du cycle de vie (source d'AUDIT-001/012)

Trois modes d'exécution (primaire multi-workers / single-worker primaire / worker) avec trois chemins de shutdown **non factorisés**:

- single-worker: `runShutdownCallbacks` + `uninstallPlugins` ✔
- worker: `runShutdownCallbacks` (pas d'uninstall) ✔
- primaire multi-workers: `uninstallPlugins` seul — callbacks ignorés ✘

Ce n'est pas un bug de code isolé, c'est une **absence d'invariant testé** ("tout chemin de shutdown exécute les callbacks"). Remédiation: un invariant + un test paramétré sur les trois modes (voir REMEDIATION_PLAN).

### 2. Deux vérités sur la vivacité des workers

`metrics.activeWorkers` (compteur incrémenté au fork, décrémenté à l'exit) vs `cluster.workers` (vérité Node). Aujourd'hui synchronisés par `cleanupWorker` — cohérence correcte mais non garantie par construction (deux sources à maintenir). Risk faible; ne pas refactorer sans cause (voir Do-not-fix), mais **tout nouveau code doit lire `cluster.workers` via `getActiveWorkers()`**, pas le compteur.

### 3. La périphérie doc/exemples est un time bomb déjà explosé

Le contrat utilisateur est dupliqué dans README racine, README core, SECURITY.md, AGENTS.md, 10 exemples, BENCHMARKS.md — sans test de cohérence ni source unique. Résultat mesuré dans cet audit: compteurs d'exemples contradictoires, ports fantômes dans 5 endroits, BENCHMARKS.md non régénérable, RELEASING.md périmé, knob `METRICS_HOST` inexistant (AUDIT-029/030/032). Ce n'est pas de la docs-porn: **ce sont des promesses fausses que les utilisateurs croient**. Remédiation: les exemples deviennent la source exécutable (smoke test branché, AUDIT-031), et la doc référence au lieu de dupliquer les tableaux de config.

### 4. Dépendance comportementale upstream (prom-client)

Le plugin prometheus dépend d'un détail d'implémentation d'`AggregatorRegistry` (Map de requêtes, fuite au timeout — AUDIT-019). Couplage acceptable (délibéré), à surveiller lors des bumps de prom-client.

## Décisions à prendre (ADR recommandé pour la 1)

1. **Sémantique de `registerOnShutdown` en primaire multi-workers** (AUDIT-001): exécuter après le drain des workers (recommandé — cohérent avec la doc "server.close()" dans le callback) ou avant (arrêt d'acceptation tôt). Impact: ordre relative aux `uninstallPlugins`. → ADR court.
2. **Exemples NestJS/inertia: feature ou nettoyage** (AUDIT-030): ajouter les serveurs de métriques (~40 lignes) ou retirer les promesses. → Décision produit, pas technique.
3. **`health.live`: constante documentée vs retirée** (AUDIT-006): documenter (recommandé, non-breaking).

## Ce qui n'est PAS un problème (refus de refactorer)

- `orchestrator.ts` en un seul fichier (pas de split cosmétique).
- La répétition `workerManager/shutdownCoordinator/signalHandler` en tant que services (c'est déjà la bonne granularité; une interface `Lifecycle` commune serait une abstraction sans deuxième implémentation).
- La blocklist `DANGEROUS_ARG_PATTERNS` (pas une allowlist) — tradeoff documenté, correct pour le threat model.
- Le plugin interface sans middlewares/hooks supplémentaires — c'est minimal par design et ça marche.
