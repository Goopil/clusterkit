# Findings — Audit clusterkit 2026-08-31

Format par finding: Severity / Confidence / Domain / Location, puis Problem, Evidence, Impact, Trigger, Verification, Recommended fix, Alternatives, Regression risk.

Confiance: **Confirmed** (démontrable dans le repo) · **Likely** (très probable, information externe requise) · **Needs verification**.

---

## AUDIT-001 — `registerOnShutdown()` n'est jamais appelé lors du shutdown du primaire multi-workers

- **Severity:** High
- **Confidence:** Confirmed
- **Domain:** Reliability / Correctness
- **Location:** `packages/worker-manager/src/orchestrator.ts:846-872` (shutdownPrimary), doc: `README.md:228`, `README.md:161`

### Problem

`shutdownPrimary()` (primaire multi-workers) enchaîne `initiateShutdown → uninstallPlugins → dispose` mais n'appelle jamais `runShutdownCallbacks(signal)`. Les callbacks enregistrés via l'API publique `registerOnShutdown()` ne s'exécutent donc **pas** dans le mode de déploiement le plus courant (primaire avec ≥ 2 workers). Ils ne s'exécutent que dans les workers (`orchestrator.ts:910`) et en mode single-worker (`orchestrator.ts:580`).

### Evidence

- `orchestrator.ts:846-872`: aucun appel à `runShutdownCallbacks` dans `shutdownPrimary`.
- Contraste direct: `shutdownSingleWorker` (`:579-589`) et `startWorker.handleShutdown` (`:909-917`) l'appellent.
- `README.md:228` documente « Calls your `registerOnShutdown()` callback (e.g. `server.close()`) » comme étape de la séquence de shutdown — sans restriction au single-worker.

### Impact

Tout cleanup enregistré sur l'orchestrateur du primaire (flush de métriques, fermeture de connexions, export final) est silencieusement sauté à chaque SIGTERM. Le plugin otlp-meter est directement touché (AUDIT-012: perte des métriques accumulées à chaque déploiement). C'est un **silent failure**: pas d'erreur, pas de log, comportement documenté ≠ comportement réel.

### Trigger

SIGTERM/SIGINT reçu par un primaire en mode multi-workers (`workers >= 2`) — le cas par défaut en conteneur.

### Verification

Test minimal: primaire multi-workers + `registerOnShutdown(spy)` + SIGTERM → assert `spy` appelé. Échoue aujourd'hui.

### Recommended fix

Dans `shutdownPrimary()`, après `initiateShutdown` (ou avant — à décider, cf. Alternatives), appeler `await this.runShutdownCallbacks(signal)`. Ajouter le test de non-régression ci-dessus.

### Alternatives

- Déprécier `registerOnShutdown` en le documentant "workers + single-worker only" et diriger les primaires vers `uninstall` de plugin. Moins bien: casse la promesse existante et le pattern des plugins (otlp-meter l'utilise).
- Exécuter les callbacks **avant** `initiateShutdown` (arrêt d'acceptation de nouvelles requêtes d'abord). Ordre defensible, mais change la sémantique documentée ("callback appelé pendant le drain"); recommandé: après le drain des workers, avant `uninstallPlugins`.

### Regression risk

Faible. Les callbacks actuellement ignorés vont se mettre à s'exécuter — si un utilisateur a enregistré par erreur un callback lourd, le shutdown s'allonge; atténué par le budget `shutdown.timeoutMs` (exit timer des modes single/worker) qui devra être appliqué aussi sur ce chemin.

---

## AUDIT-002 — L'escalade de drain des recyclages code en dur 5s/2s, ignorant la config shutdown

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Reliability / Correctness
- **Location:** `packages/worker-manager/src/orchestrator.ts:808-839` (drainRecycledWorker)

### Problem

`drainRecycledWorker` escalade vers SIGTERM après **5 000 ms** et SIGKILL après **2 000 ms de plus** — valeurs littérales. Les options `shutdown.timeoutMs` (défaut 12s), `sigtermDelayMs` (2s) et `sigintDelayMs` (1s) sont validées dans `validation.ts:140-145` mais ignorées sur ce chemin.

### Evidence

- `orchestrator.ts:817` `setTimeout(..., 5_000)` et `:824` `setTimeout(..., 2_000)`, avec le commentaire "after 5s send SIGTERM, after 2s more send SIGKILL".
- Le chemin de shutdown coordonné (`shutdown-coordinator.ts:229-248`) utilise bien `sigtermDelayMs`/`sigintDelayMs`.
- Un test pinue l'ordre mais pas les valeurs (`test/orchestrator.test.ts:930-972` avance 5_001ms/2_001ms; un re-timing ≤ 7s passerait).

### Impact

Un worker recyclé qui draine (requêtes longues, keep-alive) est SIGKILLé après **7s effectifs** alors que le budget configuré est 12s. Différence de comportement entre "recycle/hot-restart" et "shutdown" pour le même drain — surprise pour qui règle `timeoutMs` à 30s (grace de 7s quand même).

### Trigger

`maxAgeMs > 0` ou `restartWorkers()`, avec un drain dépassant 7s.

### Verification

Worker fixture qui ferme son serveur après 10s; recycle; observer SIGKILL à ~7s malgré `timeoutMs: 30_000`.

### Recommended fix

Dérivé la fenêtre de la config: SIGTERM après `timeoutMs` (ou `sigtermDelayMs` aligné sur le chemin shutdown), SIGKILL après `sigintDelayMs` supplémentaire — réutiliser les mêmes bornes que `ShutdownCoordinator.killWorkerGradually`. Mettre à jour le test pour pinner les durées (avancer le fake timer au-delà de la config choisie).

### Alternatives

Tolérer le hardcode en le documentant explicitement ("recycle grace = 7s, non configurable") — mais alors retirer l'illusion que `sigtermDelayMs` s'applique ici. La dérivation config est un diff plus petit que la doc à maintenir.

### Regression risk

Faible. Un drain plus long retarde le recycle suivant (stagger 1s déjà présent); borne sup = `awaitBoundedWorkerExit` qui force-kill à `timeoutMs + délais + 5s`.

---

## AUDIT-003 — `restartWorkers()` interrompu par un shutdown: branche non testée et `restart:complete` mensonger

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Testing / Observability
- **Location:** `packages/worker-manager/src/orchestrator.ts:386-407`

### Problem

Si le shutdown démarre pendant un rolling restart, la boucle `break` (ligne 389) puis… log « Hot restart complete » et émission de `restart:complete` avec la liste **partielle** `restartedWorkerIds`. Aucun statut "aborted". Aucun test ne couvre ce `break`.

### Evidence

- `orchestrator.ts:386-389` (break), `:406-407` (log + emit après la boucle, hors du break).
- Sous-audit tests: aucun test du break; les tests de course (`test/orchestrator.test.ts:818-894`) ne couvrent que le chemin crash-restart.
- Second pass (réfutation partielle): en code actuel, la fenêtre d'orphan-fork post-shutdown est quasi nulle — `cluster.fork()` est synchrone et `initiateShutdown` capture `getActiveWorkers()` en synchrone; le break protège le cas multi-itérations. Le risque orphan existe si le break est supprimé (fork après capture), pas aujourd'hui.

### Impact

Consommateurs de l'événement (dashboards, automatisations) voient un `restart:complete` alors que le roll est incomplet — observabilité trompeuse. Et la branche d'abandon peut être supprimée sans qu'aucun test ne rougisse (les replacements forkés après initiation du shutdown survivraient en orphelins, le primaire ne s'arrêterait jamais).

### Trigger

SIGHUP/hot-restart en cours + SIGTERM concurrent.

### Verification

Test: démarrer `restartWorkers` sur N workers, déclencher shutdown pendant l'attente du premier drain, assert que `restart:complete` n'est pas émis (ou porte un flag d'abandon) et qu'aucun worker n'est forké après initiation.

### Recommended fix

Ne pas émettre `restart:complete` (ou émettre `restart:aborted`) quand la boucle break sur shutdown; log "Hot restart aborted". Ajouter le test.

### Alternatives

Garder l'émission mais ajouter un champ `aborted: true` — rétrocompatible mais demande aux consommateurs de lire le champ.

### Regression risk

Quasi nul.

---

## AUDIT-004 — Les timers de backoff de restart ne sont pas `unref()` → sortie du primaire retardée

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Reliability / Operations
- **Location:** `packages/worker-manager/src/orchestrator.ts:748` (restartWorkerWithBackoff)

### Problem

`await new Promise((resolve) => setTimeout(resolve, delayMs))` — timer **référencé**. Tous les autres timers du primaire sont `unref()` (crashCleanupInterval:523, backoffResetTimer:628, waitTimer:466, forceKillTimer:838), pas celui-ci.

### Evidence

`orchestrator.ts:748` seul `setTimeout` du core sans `.unref()`.

### Impact

Si le shutdown démarre pendant un backoff (max `maxBackoffMs`, défaut 30s), le primaire reste vivant jusqu'à l'expiration du timer après la fin du shutdown. `docker stop` (grace 10s) escalade alors en SIGKILL → exit 137 "mystérieux" alors que le shutdown s'est bien déroulé. Bruit opérationnel, fausse piste d'incident.

### Trigger

Crash d'un worker puis SIGTERM du primaire pendant la fenêtre de backoff (1s→30s).

### Verification

Fake timers: démarrer un restart avec backoff, initier shutdown, avancer les timers, vérifier que l'event loop se vide (process exit) dès la fin de `shutdownPrimary`, pas à l'expiration du backoff.

### Recommended fix

`.unref()` sur ce timer (une ligne). Cohérence avec le reste du fichier.

### Alternatives

Aucune nécessaire.

### Regression risk

Nul (le timer reste appelé; seul son effet sur la durée de vie du process change).

---

## AUDIT-005 — `installPlugins()` sans isolation d'erreur ni rollback; instance briquée en cas d'échec

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Reliability
- **Location:** `packages/worker-manager/src/orchestrator.ts:171-175, 190-210`

### Problem

Contrairement à `uninstallPlugins` (try/catch par plugin, `:177-188`), `installPlugins` n'attrape rien. De plus `isPrimaryStarted = true` est posé **avant** l'installation (`:192` vs `:197`) : un plugin qui throw → `run()` rejette, aucun worker, aucun handler de signaux, et l'instance est définitivement inutilisable ("run() already called"). Pas de rollback des plugins déjà installés. Aucun log d'orchestrateur identifiant le plugin fautif (la rejection remonte nue).

### Evidence

`orchestrator.ts:171-175` (boucle sans try/catch), `:191-197` (ordre assert → flag → install). Sous-audit tests: aucun test avec plugin failing.

### Impact

- Primaire: crash au boot, message sans contexte plugin (DX dégradé, mais fail-fast défendable pour une erreur de config).
- Worker: rejection de `run()` non catchée → crash → restart → même échec → **crash loop de flotte** jusqu'à trip du breaker (5 crashes), readiness flip — pour une erreur potentiellement transitoire (import dynamique otlp, fs indisponible).

### Trigger

Tout throw/exception dans `install()` d'un plugin.

### Verification

Test: `orchestrator.use({name:'x', install: () => { throw new Error('boom') }})`; assert message d'erreur contient le nom du plugin et que les plugins déjà installés reçoivent `uninstall`.

### Recommended fix

Option minimale: try/catch par plugin avec rethrow enrichi (`Plugin '<name>' install failed: <cause>`) + rollback (`uninstall` des plugins déjà installés) avant rethrow. Le fail-fast (rejeter `run()`) est conservé — c'est le comportement correct pour une erreur de config.

### Alternatives

Tolérer l'échec et continuer sans le plugin — rejeté: silencieux, masque une misconfiguration (cf. anti-refactoring: le rollback+enrichissement est le plus petit correctif qui supprime le silent failure).

### Regression risk

Faible.

---

## AUDIT-006 — `health.live` est un état mort: jamais muté, jamais testé négativement

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness / API
- **Location:** `packages/worker-manager/src/types.ts:19-22`, `orchestrator.ts:70,270-272`

### Problem

`HealthStatus.live` est initialisé `true` et jamais modifié dans tout `packages/**`. Seule assertion: `live: true` trivial (`test/orchestrator.test.ts:228`).

### Evidence

Grep `.live` sur `packages/**`: aucune écriture. Le circuit breaker trippe (`health.ready = false`, `orchestrator.ts:682`) mais laisse `live: true`.

### Impact

API trompeuse: un consommateur qui câble liveness K8s sur `getHealth().live` ne verra jamais de défaillance. Sémantique réelle: `live` = "le process tourne" (le role de K8s liveness), `ready` seul varie. Le problème est l'illusion d'information.

### Trigger

Intégration `getHealth()` dans un probe.

### Verification

Grep confirmé; ajouter un test documentant l'invariant (ou l'inverse).

### Recommended fix

Choisir: (a) documenter `live` comme constant-by-design dans types.ts + README ("live is always true; readiness is the signal"), ou (b) le retirer de l'API (breaking, non recommandé en 1.x). Recommandé: (a) + test d'invariant.

### Alternatives

Faire passer `live = false` sur trip du breaker — non: un primaire vivant avec breaker tripé est vivant; priver le probe liveness de signal supprimerait le pod alors que ready=false suffit.

### Regression risk

Nul.

---

## AUDIT-007 — `WEB_CONCURRENCY`: grammaire de parsing silencieuse (pas de warning sur valeurs invalides)

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Observability / Correctness
- **Location:** `packages/worker-manager/src/orchestrator.ts:989-1006`

### Problem

`Number.parseInt(WEB_CONCURRENCY, 10)`: `"0"`, `"-3"`, `"NaN"`, `"0x10"`, `"1e3"` passent tous en fall-through silencieux vers `getCPUCount()` (ou donnent 1 worker pour `"1e3"` — parseInt s'arrête au premier caractère non numérique). Seul le dépassement du cap 256 loggue un warn.

### Evidence

Code `:992-1002`; sous-audit tests: seuls `"10000"`→clamp et `"2"` sont testés.

### Impact

`WEB_CONCURRENCY=1e3` → 1 worker au lieu de 1000 (ou d'un rejet) — dégradation de capacité silencieuse en prod. Aucune indication log pour l'opérateur.

### Trigger

Valeur non-entière-décimale dans l'env.

### Verification

`WEB_CONCURRENCY=1e3 node app.js` → 1 worker, aucun log.

### Recommended fix

Une ligne: si `webConcurrency` défini mais parse invalide/`<= 0`, `log.warn("Ignoring invalid WEB_CONCURRENCY", { value })` avant fall-through. Ne pas changer la grammaire (comportement parseInt stable et documentable).

### Alternatives

Rejeter au boot (throw) — trop dur pour une var d'env optionnelle; le warn suffit.

### Regression risk

Nul.

---

## AUDIT-008 — `use()` après `run()` : plugin silencieusement jamais installé (et désinstallé quand même)

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness / DX
- **Location:** `packages/worker-manager/src/orchestrator.ts:223-226, 177-188`

### Problem

`use(plugin)` pousse dans `plugins` sans vérifier que `run()` a déjà eu lieu. Un plugin ajouté après `run()` ne sera **jamais installé** (installPlugins n'est appelé qu'au démarrage) mais **sera** désinstallé (uninstallPlugins itère tout).

### Evidence

`use()` sans garde; `installPlugins` appelé uniquement dans `runPrimary`/`runWorker`.

### Impact

Config fonctionnellement ignorée sans erreur — footgun classique des builder chains.

### Trigger

`new Orchestrator(cfg).run(...)` puis `.use(p)`.

### Verification

Test: assert throw (ou warning) sur use-after-run.

### Recommended fix

Deux lignes: throw `Error("use(): cannot be called after run()")` si `isPrimaryStarted || isWorkerStarted`, miroir de `patchWorkerEnv`/`overrideWorkerCount` qui lèvent déjà après fork.

### Alternatives

Installer immédiatement si déjà démarré — non: sémantique d'ordre ambiguë (workers déjà forkés), incohérent avec les autres méthodes.

### Regression risk

Nul.

---

## AUDIT-009 — Handlers de signaux enregistrés **après** le fork initial (fenêtre d'orphelins au boot)

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Reliability
- **Location:** `packages/worker-manager/src/orchestrator.ts:498-532`

### Problem

`startPrimary` fork la flotte **puis** enregistre SIGTERM/SIGINT/SIGHUP. Un SIGTERM reçu entre le premier fork et l'enregistrement tue le primaire avec le handler par défaut de Node (exit immédiat) → workers orphelins (ils ne meurent que si l'app gère la déconnexion IPC; sinon ils restent accrochés aux sockets jusqu'à intervention externe).

### Evidence

Ordre dans `startPrimary`: `forkWorkers` (`:507`) puis `signalHandler.register` (`:510-516`).

### Impact

Fenêtre courte (ms) mais réelle lors des déploiements agressifs (kill au boot, timeouts de readiness courts). En conteneur, l'arrêt du container nettoie les orphelins; en bare-metal non.

### Trigger

Signal pendant la fenêtre de boot.

### Verification

Difficile à provoquer de façon fiable (fenêtre ms); test par injection: `forkWorkers` mocké lent + SIGTERM.

### Recommended fix

Enregistrer les signaux **avant** `forkWorkers` (3 lignes déplacées). Les handlers sont conçus pour fonctionner avec une flotte vide (initiateShutdown sur liste vide → no-op sûr).

### Alternatives

Documenter la fenêtre — non: le déplacement est trivial et sans risque.

### Regression risk

Nul (les guards shutdown existants couvrent la flotte vide).

---

## AUDIT-010 — Logger par défaut `null`: crash loop / breaker trip invisibles si rien n'est câblé

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Observability
- **Location:** `packages/worker-manager/src/orchestrator.ts:61-93, 675-689`; README (logger @default null)

### Problem

Le logger par défaut est `null` (silence total). Le circuit breaker trippe, la readiness flippe (`health.ready = false`), mais **rien ne sort** et rien n'expose l'état (pas d'endpoint, pas d'événement obligatoire à consommer). Un utilisateur qui ne passe ni logger ni listener `circuit-breaker:tripped` a une flotte morte sans un mot.

### Evidence

`DEFAULTS.logger = null` (`validation.ts:184`); la seule signalisation est l'événement + `getHealth()`, opt-in.

### Impact

Mode d'échec "cassé sans le dire" — précisément le scénario 3h du matin. La readiness n'est visible que si l'app expose `getHealth()`.

### Trigger

Configuration minimale sans logger (snippets README simplifiés).

### Verification

Reproduire crash loop sans logger: zéro sortie.

### Recommended fix

En mode dégradé (logger null), émettre les événements critiques (`circuit-breaker:tripped`) sur `process.emitWarning` ou stderr une fois par trip. Une ligne dans `handleWorkerExit`. Pas de logger par défaut (respect du contrat "zero dependency, silent by default" — le README est honnête sur ce point).

### Alternatives

Logger par défaut console — rejeté: changerait le comportement par défaut promis (silence) et polluerait les tests.

### Regression risk

Nul.

---

## AUDIT-011 — Détection SO_REUSEPORT: faux négatif mis en cache pour la vie du process

- **Severity:** Low
- **Confidence:** Likely
- **Domain:** Resilience
- **Location:** `packages/worker-manager/src/platform.ts:61, 97-148`

### Problem

La sonde a un timeout de 500ms et le résultat (y compris `false` sur timeout) est mis en cache **pour la durée du process**. Un pod CPU-throttlé au boot peut définitivement perdre reusePort (fallback round-robin cluster) sans indication.

### Evidence

`platform.ts:61` (`setTimeout(() => cleanup(false), 500)`), cache sans expiration (`:98`). Le commentaire du code reconnaît le risque ("does not cache a false negative for the whole process lifetime" — c'est précisément ce qui arrive sur timeout).

### Impact

Distribution des connexions dégradée (round-robin cluster au lieu de reuseport) pour tout le cycle de vie du pod. Pas de perte de fonctionnalité, uniquement de performance/distribution. Probabilité faible (500ms pour deux binds loopback).

### Trigger

CPU starvation extrême au boot (throttling cgroup agressif, node busy).

### Verification

Reproductible en laboratoire avec un timer faké / un cgroup cpu.max très bas; non démontrable statiquement → **Likely**.

### Recommended fix

Ne pas cacher le résultat `false` issu du timeout (distinguer "échec de sonde" de "absence prouvée"): re-prober à la demande suivante. ~5 lignes.

### Alternatives

Augmenter le timeout — déplace le problème. Exposer la valeur cache dans `getCapabilities()` pour diagnostic — complément utile et gratuit.

### Regression risk

Nul (la sonde est déjà idempotente et bornée).

---

## AUDIT-012 — otlp-meter: aucun flush des métriques à l'arrêt du primaire multi-workers (perte à chaque déploiement)

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Reliability / Observability
- **Location:** `packages/plugin-otlp-meter/src/index.ts:193-200`; conséquence directe d'AUDIT-001

### Problem

Le flush final est branché uniquement sur `registerOnShutdown` (`:193-195`) — jamais appelé en primaire multi-workers (AUDIT-001). `uninstall()` (`:198-200`) ne fait que détacher les listeners. Résultat: à chaque SIGTERM, tout ce que la `PeriodicExportingMetricReader` n'a pas encore exporté (jusqu'à `exportIntervalMs`, défaut 60s) est perdu.

### Evidence

Code ci-dessus; les tests contournent le problème en appelant `plugin.shutdown()` manuellement (`test/otlp-meter.integration.test.ts:120`, `test/otlp-meter.e2e.test.ts:98-103`) — le chemin réel n'est jamais exercé.

### Impact

Perte de métriques orchestrator (crashes, restarts, trips du breaker, active_workers) sur chaque déploiement/roll — précisément les séries qu'on veut voir autour d'un incident de déploiement.

### Trigger

Déploiement (SIGTERM) en mode multi-workers.

### Verification

Primaire multi-workers + collector mocké: compteur incrémenté juste avant SIGTERM → absent du collector après arrêt.

### Recommended fix

Se corrige automatiquement si AUDIT-001 est corrigé. En défense supplémentaire: appeler `shutdownProvider()` aussi dans `uninstall()` (idempotent via `isShutdown`) pour couvrir le path `uninstallPlugins` de `shutdownPrimary`.

### Alternatives

Exporter plus fréquemment à l'approche du shutdown — sur-ingénierie; le flush à l'arrêt est le pattern OTel standard.

### Regression risk

Faible (shutdown OTel est borné par le timeout exporter, imbriqué sous l'exit timer).

---

## AUDIT-013 — signal-restart / file-watcher: détection single-worker cassée avec `workers: 'auto'`

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Correctness
- **Location:** `packages/plugin-signal-restart/src/index.ts:58`; `packages/plugin-file-watcher/src/index.ts:104`

### Problem

Les deux plugins lisent `config.workers.count === 1` à l'installation. Or `ResolvedConfig.workers.count` reste la **chaîne `"auto"`** tant qu'un plugin de sizing n'a pas appelé `overrideWorkerCount` — et `resolveWorkerCount()` ne matérialise jamais la valeur dans la config. Sur un hôte 1-CPU (ou `WEB_CONCURRENCY=1`) sans plugin sizing: le check est faux → signal-restart route SIGHUP vers `restartWorkers()` qui **no-op** (`orchestrator.ts:367-370`) — le comportement documenté "exit for external restart" n'arrive jamais, et `lastRestart` est quand même mis à jour. file-watcher démarre des watchers dont les restarts no-op.

### Evidence

`orchestrator.ts:483-489` (overrideWorkerCount ne mute que si `count === 'auto'`, et un sizing plugin est requis), `validation.ts:233` (count reste `'auto'`), `orchestrator.ts:978-987` (resolveWorkerCount ne modifie pas cfg). Contrast: otlp-meter (`index.ts:181`) et prometheus (`index.ts:187`) interrogent correctement `orchestrator.workerCount`.

### Impact

SIGHUP silencieusement inopérant dans une configuration légitime (`workers: 'auto'` résolvant à 1). file-watcher: warning "no effect" affiché à tort OU watchers démarrés à tort selon la valeur — comportement dépendant de l'ordre d'installation quand plugin-sizing présent (la config est lue une fois à l'install, avant que sizing n'ait pu overrider… non: sizing installe avant car ordre de `use()`; si file-watcher est `use()`-é avant sizing, il lit la valeur pré-override).

### Trigger

`workers: 'auto'` (défaut) résolvant à 1 sans plugin de sizing.

### Verification

`new Orchestrator({ workers: { count: 'auto' } })` + `WEB_CONCURRENCY=1` + signal-restart + SIGHUP → log "initiating hot restart" puis rien (no-op), `lastRestart` mis à jour.

### Recommended fix

Remplacer `config.workers.count === 1` par `orchestrator.workerCount === 1` dans les deux plugins (même pattern que otlp/prometheus). 2 lignes + tests.

### Alternatives

Exposer un helper `orchestrator.isSingleWorkerMode()` — non nécessaire, `workerCount` existe.

### Regression risk

Nul.

---

## AUDIT-014 — file-watcher: timer `startDelayMs` non tracké — watchers (re)démarrés après cleanup

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Reliability
- **Location:** `packages/plugin-file-watcher/src/index.ts:255-261, 284-300, 265-281`

### Problem

`setTimeout(startWatchers, startDelayMs).unref()` n'est stocké nulle part: `uninstall()` et le callback shutdown ne peuvent pas l'annuler. Si le shutdown/uninstall survient pendant le délai, `startWatchers()` s'exécute **ensuite** et crée des watchers chokidar neufs + un intervalle `pollEnv` — après le cleanup. Les handles chokidar sont référencés (ref'd): l'event loop du primaire peut ne plus se vider, `shutdownPrimary` (qui ne fait que `process.exitCode = 0`) **ne termine jamais**.

### Evidence

Code ci-dessus; aucun stockage du timer; `startWatchers` n'a pas de garde "déjà nettoyé".

### Impact

Arrêt qui pend (résolu par SIGKILL externe) + watchers fantômes déclenchant des restarts vers un orchestrateur en cours d'arrêt. `isWatching` devient incohérent.

### Trigger

`startDelayMs > 0` + shutdown/uninstall dans la fenêtre.

### Verification

Test: plugin avec `startDelayMs: 1000`, `uninstall()` immédiat, avancer les timers → assert aucun watcher créé (`isWatching === false`, `watchers.length === 0`).

### Recommended fix

Stocker le timer dans une variable de closure, le `clearTimeout` dans uninstall et le callback shutdown, et ajouter une garde `if (closed) return` en tête de `startWatchers`. ~5 lignes.

### Alternatives

Aucune nécessaire.

### Regression risk

Nul.

---

## AUDIT-015 — file-watcher: coalescing du debounce perd le payload `.env` → restart avec env périmé

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Data integrity
- **Location:** `packages/plugin-file-watcher/src/index.ts:142-152, 109-140`

### Problem

Deux chemins où la payload env est perdue:

1. `triggerRestart(reason, env)` écrase `pendingEnv` sans fusion (`:142-144`): un changement de fichier simple dans la même fenêtre de debounce écrase un payload `.env` en attente avec `undefined` → restart sans overlay.
2. `flushRestart` efface `pendingEnv` (`:119-121`) **avant** le skip `minRestartIntervalMs` (`:126-129`): un trigger dans la fenêtre minimale jette la payload sans trailing retry.

### Evidence

Code ci-dessus.

### Impact

La feature phare du plugin — "redémarrer avec le nouvel env après édition du .env" — restart avec l'**ancien** env, silencieusement. Pire cas classiques: secret rotation suivie d'un commit de code dans la même seconde.

### Trigger

Événement `.env` + autre événement dans `debounceMs` (300ms par défaut), ou tout trigger dans `minRestartIntervalMs`.

### Verification

Test: trigger("env-change", {A:1}) puis trigger("file-change") dans la fenêtre → assert l'overlay reçu par restartWorkers contient A:1 (échoue aujourd'hui).

### Recommended fix

- Fusion au lieu d'écrasement: `pendingEnv = { ...pendingEnv, ...env }` (l'env le plus récent gagne clé par clé) — ou dernier-écrit-gagne mais **fusione** le cas `undefined` en préservant l'ancien payload.
- Sur skip `minRestartIntervalMs`: programmer un trailing flush après le reste de l'intervalle.

### Alternatives

Logger un warn quand une payload est jetée — masque le problème au lieu de le corriger.

### Regression risk

Faible; les tests debounce existants (`test/file-watcher.test.ts`) pin déjà le coalescing des raisons.

---

## AUDIT-016 — file-watcher: `parseEnvFile` diverge de dotenv (commentaires inline, `export`, multiline)

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness
- **Location:** `packages/plugin-file-watcher/src/parse-env.ts:1-15`

### Problem

Pas de support `export KEY=`, valeurs multiline, échappement de quotes; les commentaires inline restent dans la valeur (`TOKEN=abc # rotated` → `"abc # rotated"`).

### Evidence

Code du parser (15 lignes).

### Impact

Les workers redémarrés reçoivent des valeurs différentes de celles lues par dotenv/le shell — erreurs de config silencieuses sur des fichiers .env standard.

### Trigger

Fichier .env avec ces syntaxes (courantes).

### Verification

Unitaire: `parseEnvFile('TOKEN=abc # rotated')` → `"abc # rotated"`.

### Recommended fix

Au minimum: strip les commentaires inline hors quotes + ignorer les clés `__proto__`/`constructor`/`prototype` (voir SECURITY). Documenter explicitement les limites dans l'option `envParser` (un custom parser est déjà supporté). Ne pas réimplémenter dotenv complet (YAGNI: l'option `envParser` est la porte de sortie).

### Alternatives

Dépendre de `dotenv` — rejeté: dépendance runtime pour un plugin peer-é, et l'option custom couvre les cas avancés.

### Regression risk

Nul.

---

## AUDIT-017 — otlp-meter: `setGlobalMeterProvider` écrase un provider global préexistant; doc "primary only" fausse

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness / DX
- **Location:** `packages/plugin-otlp-meter/src/index.ts:140, 135-141`; `src/types.ts:33-37`

### Problem

`metrics.setGlobalMeterProvider(meterProvider)` s'exécute dans primaire **et** workers, avant toute branche `isPrimary`. Une app qui a configuré son propre SDK OTel avant `run()` le voit remplacé (attribution `serviceName: "clusterkit"`, export cassé après shutdown du provider). De plus `meterProvider` est documenté "primary only; undefined in workers" (`types.ts`) alors qu'il est créé dans les workers aussi.

### Evidence

Code ci-dessus + doc contradictoire.

### Impact

Casse/confuse les setups OTel préexistants; pas de crash.

### Trigger

App utilisant `@opentelemetry/api` avant `orchestrator.run()`.

### Verification

Définir un provider global factice, installer le plugin, vérifier `metrics.getMeter()` route vers le provider du plugin.

### Recommended fix

Check `metrics.getMeter(...)` — plus simple: ne pas écraser si `metrics.getMeterProvider()` retourne un provider non-délégant, et log un warn. + corriger la doc de types.ts.

### Alternatives

Option `setGlobalProvider: false` par défaut — une config pour un cas edge, YAGNI; le warn suffit en première intention.

### Regression risk

Faible.

---

## AUDIT-018 — otlp-meter: latch `isShutdown` jamais réinitialisé — provider orphelin au reinstall

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness
- **Location:** `packages/plugin-otlp-meter/src/index.ts:102-107, 135`

### Problem

Après un `shutdown()`, `isShutdown` reste `true` pour toujours. Un cycle uninstall → reinstall sur la même instance réassigne `meterProvider` (`:135`) sans shutdown de l'ancien (orphan: interval de lecture toujours actif, unref'd) et le nouveau provider ne pourra jamais être flushé.

### Evidence

Code ci-dessus; prometheus supporte explicitement le cycle reinstall (garde `clearPrimaryListeners`), l'asymétrie est involontaire.

### Impact

Leak de provider + perte de flush; pas de crash.

### Trigger

Reinstall du même plugin instance après shutdown.

### Verification

Test: install → shutdown → install → shutdown → assert ancien provider fermé et nouveau flushable.

### Recommended fix

Dans `install()`: `if (meterProvider) await shutdownProvider(); isShutdown = false;` avant de créer le nouveau. 3 lignes.

### Alternatives

Aucune nécessaire.

### Regression risk

Nul.

---

## AUDIT-019 — prom-client `AggregatorRegistry`: fuite d'une entrée de Map par scrape en timeout (upstream, surfacé par le plugin)

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Performance / Stability
- **Location:** `packages/plugin-prometheus/src/index.ts:100-107` (usage); upstream `prom-client@15.1.3 lib/cluster.js:63, 58-62, 184`

### Problem

`AggregatorRegistry.clusterMetrics()` stocke chaque requête dans une `Map` (`requests.set`) supprimée uniquement en cas de succès; le chemin timeout 5s appelle `done(err)` sans `delete`. Le plugin attrape l'erreur (dégrade le scrape) mais ne peut pas nettoyer l'entrée.

### Evidence

Vérifié dans node_modules (prom-client); comportement non corrigé en 15.1.3.

### Impact

Croissance mémoire lente du primaire proportionnelle aux scrapes échoués — fuite persistante si un worker est mort/déconnecté pendant les scrapes (situation fréquente autour d'un incident…). Ordre de grandeur: entrée par scrape timeouté, non par worker.

### Trigger

Scrape pendant qu'un worker est unreachable (recycle, crash, IPC saturé).

### Verification

Mock d'un worker qui n'accuse pas réception + N scrapes → taille de la Map interne croissante.

### Recommended fix

Contournement plugin-side minimal: sur erreur `clusterMetrics()`, rien à faire de propre sans upstream — (1) upstream: PR pour `requests.delete` dans le path timeout, (2) plugin: documenter le symptôme (croissance RSS du primaire si scrapes pendant incident) dans README du plugin. Priorité basse: la fenêtre de fuite est bornée aux scrapes qui échouent.

### Alternatives

Patch fork de prom-client — non.

### Regression risk

Nul (side upstream).

---

## AUDIT-020 — prometheus: reinstall (même registry, `defaultMetrics: true`) throw en mode single-worker

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness
- **Location:** `packages/plugin-prometheus/src/index.ts:196-198`

### Problem

`collectDefaultMetrics({ register })` s'exécute à chaque install du primaire; prom-client throw sur doublon de noms de métriques. Le garde anti-doublon de listeners (`clearPrimaryListeners`) couvre les événements, pas les default metrics.

### Evidence

Code + comportement prom-client `Registry.registerMetric`.

### Impact

`run()` rejette au second install (single-worker mode, registry partagé) — échec de démarrage.

### Trigger

Uninstall → reinstall, single-worker, `defaultMetrics: true` (défaut).

### Verification

Test: deux cycles install/uninstall en single-worker avec même registry.

### Recommended fix

Flag `defaultMetricsInstalled` dans la closure; n'appeler `collectDefaultMetrics` qu'une fois par registry. 3 lignes.

### Alternatives

Aucune nécessaire.

### Regression risk

Nul.

---

## AUDIT-021 — Amplification IPC à chaque scrape `/metrics` (surface DoS) sur endpoints publics des exemples

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Performance / Security
- **Location:** `packages/plugin-prometheus/src/index.ts` (cache 1000ms); `examples/*/src/index.mjs` (host 0.0.0.0); `SECURITY.md:25-27`

### Problem

Chaque scrape (cache expiré) diffuse un fan-out IPC vers tous les workers et agrège. Exposé publiquement sans auth (configuration des exemples, AUDIT-026), un scraper agressif transforme 1 requête HTTP en N messages IPC + agrégation — amplification côté primaire et workers. SECURITY.md documente le risque mais les exemples (l'intégration de référence) font exactement le contraire.

### Evidence

SECURITY.md l'admet; exemples bind 0.0.0.0 sans auth; docker-compose publie 9090-9095.

### Impact

DoS amplifié sur le primaire; recon (pids, métriques internes). Risque demo-copié-en-prod.

### Trigger

Endpoint metrics public.

### Verification

N/A statique — combinaison documentée.

### Recommended fix

Exemples: bind `127.0.0.1` par défaut (var `METRICS_HOST` supportée par les exemples) — corrige aussi le README qui référence `METRICS_HOST` inexistant (AUDIT-032). 4 exemples × 1 ligne.

### Alternatives

Rate-limit sur le serveur d'exemple — inutile pour une démo; le bind loopback est le standard.

### Regression risk

Nul (docker-compose publie les ports; l'accès hôte passe par localhost mapping — vérifier que le curl documenté fonctionne toujours).

---

## AUDIT-022 — prometheus: `getMetrics()` dans un worker retourne des métriques orchestrator à zéro

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Correctness / DX
- **Location:** `packages/plugin-prometheus/src/index.ts:36-58, 137-198, 100-107`; `README.md:278-291`

### Problem

Gauges/counters enregistrés dans le registry dans **tous** les process; les listeners d'événements ne sont branchés qu'au primaire. `getMetrics()` appelé depuis le code applicatif (qui tourne dans les workers) retourne des zéros — le README prescrit le serveur au primaire, mais rien n'empêche (ni ne détecte) le mauvais wiring.

### Evidence

Code + doc README prescrivant le pattern correct sans garde contre l'erreur.

### Impact

`/metrics` tout-zéro sans erreur — débogage confus ("pourquoi active_workers = 0 ?").

### Trigger

Montage de `getMetrics()` dans l'app (worker).

### Verification

getMetrics() dans un worker → zéros.

### Recommended fix

Une ligne dans `getMetrics()`: si `!cluster.isPrimary`, throw avec message explicite ("call getMetrics() in the primary; see README"). Fail-fast > zéro silencieux.

### Alternatives

Doc seulement — insuffisant, le piège coûte peu à empêcher.

### Regression risk

Nul (changement d'API à la marge: les appels invalides passaient en silence).

---

## AUDIT-023 — Actions GitHub tierces tag-pinnées mélangées aux SHA-pinnées

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Security / Supply chain
- **Location:** `.github/workflows/ci.yml:79` (`codecov/codecov-action@v7`, reçoit `secrets.CODECOV_TOKEN`), `ci.yml:89` (`actions/upload-artifact@v4`), `.github/workflows/cq.yml:20,23,24` (checkout/pnpm/setup-node `@v4`, expose `SONAR_TOKEN`)

### Problem

Le reste des workflows est SHA-pinné (`ci.yml:21-23`, `release.yml:37-43`, `cq.yml:32`) — ces quatre références flottantes sont de la dérive, pas une politique.

### Evidence

Diff visible dans les workflows eux-mêmes.

### Impact

Compromission du repo upstream de l'action (ou force-move du tag) → code arbitraire en CI avec `CODECOV_TOKEN`/`SONAR_TOKEN` (tokens low-privilege → impact plafonné) et tampering d'artifacts/cache.

### Trigger

Prochaine exécution CI résolvant le tag mutable.

### Verification

Lire les workflows (fait).

### Recommended fix

SHA-pin ces 4 références avec commentaire `# vX` (style existant). 15 min.

### Alternatives

Aucune nécessaire.

### Regression risk

Nul.

---

## AUDIT-024 — `pnpm dlx publint` : exécution de code non-pinnée à chaque CI

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Security / Supply chain
- **Location:** `.github/workflows/ci.yml:123`

### Problem

`pnpm dlx publint "$pkg"` résout `latest` du registre à chaque run — publint **et son arbre de dépendances** s'exécutent sans aucune intégrité, dans un repo où tout le reste est frozen-lockfile.

### Evidence

Ligne ci-dessus.

### Impact

Une seule release malveillante de publint ou d'une dépendance transitive → code arbitraire dans CI (exfiltration de sources, attestations fausses; le job packaging n'a que GITHUB_TOKEN read-only — pas de tampering de release).

### Trigger

Aucune précondition.

### Verification

Lire le workflow (fait).

### Recommended fix

Ajouter `publint` aux devDependencies racine (couvert par le lockfile) et lancer `pnpm exec publint`. scripts/package-smoke-test.mjs l'exécute peut-être déjà — unifier.

### Alternatives

Pin par version dans la commande (`pnpm dlx publint@X.Y.Z`) — acceptable mais hors lockfile; devDependencies est plus propre.

### Regression risk

Nul.

---

## AUDIT-025 — Blocklist execArgv: flags dangereux non bloqués

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Security
- **Location:** `packages/worker-manager/src/validation.ts:65-75`

### Problem

Passent la validation: `--tls-keylog=file` (dump des clés TLS des workers sur disque), `--cpu-prof`/`--heap-prof` + `--cpu-prof-dir` (écriture de fichiers arbitraire, disque plein), `--report-on-signal`/`--report-on-fatalerror` (rapports de diagnostic contenant tout `process.env`), `--redirect-warnings`, `--diagnostic-dir`, `--stack-size`. `NODE_OPTIONS` dans `workers.env` ne fait l'objet que d'un warning (tradeoff documenté et délibéré — le plugin sizing l'utilise).

### Evidence

Patterns manquants dans `DANGEROUS_ARG_PATTERNS`.

### Impact

Limité: la config est opérateur-controlled (`SECURITY.md:28-30` le documente honnêtement) — garde-fou anti fat-finger, pas frontière de sécurité. `--tls-keylog` est le plus intéressant (confidentialité réelle si les workers terminent du TLS).

### Trigger

Config execArgv par un opérateur (ou un code injecté capable de modifier la config — dans ce cas il contrôle déjà les workers).

### Verification

`validateConfig({ workers: { execArgv: ['--tls-keylog=/tmp/k'] } })` → accepté.

### Recommended fix

Ajouter `/^--(tls-keylog|cpu-prof|heap-prof|report-|diagnostic-dir|redirect-warnings)/` à la blocklist. Garder NODE_OPTIONS en warn (documenté).

### Alternatives

Passer à une allowlist — rejeté: breaking pour des flags légitimes nombreux, le gain est faible vu le threat model.

### Regression risk

Faible (des configs exotiques mais légitimes pourraient être rejetées — les patterns ci-dessus sont tous des flags d'écriture/inspection).

---

## AUDIT-026 — Exemples de référence: metrics sans auth sur 0.0.0.0, `METRICS_HOST` documenté mais inexistant

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Security / DX
- **Location:** `examples/express/src/index.mjs:40-43`, `examples/hono/src/index.mjs:54-58` (idem fastify/koa); `README.md:588`; `SECURITY.md:25-27`; `docker-compose.yml:64-70`

### Problem

Les exemples bindent `METRICS_PORT` sur `0.0.0.0` sans auth; SECURITY.md recommande 127.0.0.1; README:588 affirme qu'un curl Docker "requires explicit non-loopback metrics host" — aucun exemple ne lit `METRICS_HOST` (grep: 0 occurrence).

### Evidence

Ci-dessus.

### Impact

Le pattern à copier contredit la doc sécurité du même repo; le knob documenté n'existe pas.

### Trigger

Copie des exemples en prod.

### Verification

Grep METRICS_HOST sur examples/ → 0.

### Recommended fix

Supporter `METRICS_HOST` (défaut `0.0.0.0` dans docker, `127.0.0.1` sinon) dans les 4-5 exemples concernés — ou le plus simple: lire `process.env.METRICS_HOST ?? "0.0.0.0"` et documenter.

### Alternatives

Supprimer la phrase du README — la moitié du fix.

### Regression risk

Nul.

---

## AUDIT-027 — Images Docker flottantes (`otel/opentelemetry-collector-contrib:latest`, `node:22-slim` tag-only)

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Security / Ops
- **Location:** `docker-compose.yml:94`, `docker/Dockerfile.test:4`, `docker/Dockerfile.examples:10`, `benchmarks/Dockerfile.bench:2`

### Problem

Le collector OTEL est sur `:latest` (pire variante), les Node sur tag sans digest. Dependabot suit les Dockerfiles mais rien ne pinnne le collector.

### Evidence

Ci-dessus.

### Impact

Builds non reproductibles; compromission upstream de l'image → code arbitraire dans des conteneurs non privilégiés (cap_drop ALL, USER app — mitigations présentes).

### Trigger

Rebuild.

### Verification

Lire les fichiers (fait).

### Recommended fix

Pin version + digest du collector. Les conteneurs non-root/cap-drop limitent déjà l'impact.

### Alternatives

Aucune nécessaire.

### Regression risk

Nul (maintenance: bumps via Dependabot).

---

## AUDIT-028 — SECURITY.md: 3 packages absents de la politique de support; `release.yml` pousse tous les tags

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** Security / Ops
- **Location:** `SECURITY.md:7-11`; `.github/workflows/release.yml:66-68`

### Problem

La table des versions supportées liste core/prometheus/sizing — otlp-meter, signal-restart et file-watcher sont publiés mais absents. `git push origin --tags` pousse tout tag présent sur le runner.

### Evidence

Ci-dessus.

### Impact

Consommateurs des 3 plugins sans garantie de fix; tags parasites poussés publiquement.

### Trigger

N/A.

### Verification

Lire les fichiers (fait).

### Recommended fix

Ajouter 3 lignes à SECURITY.md; ne pousser que les tags créés par le run (parsing de la sortie changesets).

### Alternatives

Aucune nécessaire.

### Regression risk

Nul.

---

## AUDIT-029 — BENCHMARKS.md non régénérable + comparaison pm2 invalide (bug du harness) + métrique mal étiquetée

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Operations / Credibilité
- **Location:** `benchmarks/lib/reporter.mjs:23-27,40`; `benchmarks/targets/pm2-reload-3.mjs:34`; `benchmarks/pm2-server.mjs:20-31`; `benchmarks/lib/autocannon-runner.mjs:27`; `benchmarks/results/macos.json`

### Problem

Quatre problèmes enchaînés:

1. `reporter.mjs` ne couvre que 3 workloads / 6 targets — un rerun de `pnpm bench` **écrase** BENCHMARKS.md (8 workloads, Key Findings) avec une version tronquée.
2. pm2-reload-3 mesure un bug du harness: `wait_ready: true` mais `pm2-server.mjs` n'envoie jamais `process.send('ready')` → comptages de workers sous-évalués attribués à pm2 dans les Key Findings.
3. La colonne "Lat p95" est en réalité p97.5 (`p97_5 ?? p90`, fallback mort) — jamais disclosed.
4. Le baseline macOS `single` (workers:1, sans fork) montre 3-4 PIDs de service avec shutdown 5001ms — la donnée n'est pas ce qu'elle prétend; non flaggé.

### Evidence

Chacune vérifiée dans le code par le sous-audit.

### Impact

Les conclusions publiques (clusterkit "wins or ties 5 of 8") reposent en partie sur des comparaisons invalides et une métrique mal étiquetée — risque de crédibilité si un tiers régénère/vérifie. Le rerun destructeur du doc est un piège de maintenance direct.

### Trigger

`pnpm bench` (écrasement); lecture des conclusions pm2/p95.

### Verification

Exécuter reporter.mjs sur un BENCHMARKS.md copié → troncature. Envoyer `ready` dans pm2-server et rebench pm2-reload.

### Recommended fix

1. Envoyer `ready` dans pm2-server.mjs (ou retirer `wait_ready`) puis rebench les cibles pm2 uniquement.
2. Renommer la colonne `Lat p97.5` (une ligne dans reporter).
3. Faire matcher reporter.mjs à la liste des workloads/targets réels (boucle sur les fichiers, pas une liste codée en dur) et protéger BENCHMARKS.md (générer vers un fichier séparé).
4. Flagger les tables macOS `single` comme invalides ou les retirer.

### Alternatives

Régénérer tout BENCHMARKS.md depuis la source après fixes — c'est l'option propre; coût: un run de bench complet (~36min docker).

### Regression risk

Nul (docs/benchmarks).

---

## AUDIT-030 — Ports de métriques fantômes (NestJS 9094/9095) + exemples inertia jamais bootés

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Operations / DX
- **Location:** `README.md:576-579`; `docker-compose.yml:39-40,69-70`; `docker/start-examples.sh:23-24`; `docker/Dockerfile.examples:65`; `examples/nestjs-express/src/main.ts`, `examples/nestjs-fastify/src/main.ts`; `examples/inertia-ssr/src/index.mjs:28-30`, `examples/inertia-ssr-react/src/index.mjs:25-27`

### Problem

Les ports de métriques NestJS (9094/9095) sont déclarés à **cinq endroits** mais `main.ts` ne crée aucun serveur de métriques et ne lit jamais `METRICS_PORT` → `examples:start` mappe deux ports morts. Les deux exemples inertia enregistrent le plugin prometheus sans aucune route `getMetrics()`, ne sont ni dans start-examples.sh ni dans docker-compose, et le smoke test ne les couvre pas → jamais bootés nulle part.

### Evidence

Grep METRICS_PORT dans les main.ts NestJS: 0; absence des inertia dans les scripts docker.

### Impact

Utilisateurs qui scrient des endpoints connection-refused; plugin prometheus chargé (overhead IPC worker-metrics) pour rien dans 2 exemples; 2 exemples sur 10 sans aucun boot test.

### Trigger

`pnpm examples:start`; suivi du README.

### Verification

Boot nestjs-express, curl :9094 → refused.

### Recommended fix

Option la plus paresseuse honnête: **supprimer** les ports fantômes du README/compose/scripts et retirer le plugin prometheus des inertia **ou** ajouter la route + le serveur (20 lignes × 2). Si l'objectif est de démontrer l'intégration NestJS+prometheus, ajouter la route; sinon, nettoyer. Décision à prendre (voir ARCHITECTURE.md §décisions).

### Alternatives

Voir ci-dessus — deux chemins, les deux valides; ne rien faire n'en est pas un (le README ment déjà).

### Regression risk

Nul.

---

## AUDIT-031 — Le smoke test des exemples ne tourne jamais; pas de gate benchmark; pas d'assertion Linux reusePort

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Testing / CI
- **Location:** `examples/test/smoke.test.ts` (sans package.json); `package.json` root (`--filter=./packages/**`); `docker/Dockerfile.test`; `benchmarks/package.json` (script smoke jamais appelé en CI); `test/platform.test.ts:30-37`

### Problem

1. `examples/test/smoke.test.ts` boote 4 exemples et vérifie HTTP 200 + métriques — mais examples/ n'a pas de package.json, les filtres turbo/pnpm excluent examples/, et Dockerfile.test commente explicitement "examples have no unit tests". Test mort.
2. Le script `benchmarks smoke` (boot check) n'est jamais appelé par CI.
3. Le job "Test (Linux Docker — SO_REUSEPORT)" n'assert jamais `reusePort === true` sur Linux: platform.test.ts ne test que macOS/Windows false; la sonde (deux-sockets, parse kernel, timeout 500ms) est non testée.

### Evidence

Vérifié par le sous-audit tests (noms de jobs et filtres).

### Impact

Le CI advertise des garanties qu'il n'exécute pas: les régressions des exemples (comme les ports fantômes AUDIT-030) et de la sonde reuseport passent en vert.

### Trigger

Toute régression exemples/platform.

### Verification

Retirer un exemple du smoke list → CI vert.

### Recommended fix

1. Ajouter un package.json minimal à examples/ avec un script `test:smoke` et l'appeler dans un job CI (ou intégrer au job test-linux du compose).
2. Ajouter `--target` smoke benchmarks en job nightly (pas sur chaque PR — coût).
3. Dans le harness Docker, ajouter un test qui assert `Orchestrator.supportsReusePort() === true` sous Linux (un `it` conditionnel platform === linux dans platform.test.ts, exécuté seulement par le compose).

### Alternatives

Supprimer le smoke test mort — c'est la moitié de la valeur: le garder et le brancher.

### Regression risk

Nul.

---

## AUDIT-032 — Dérive documentaire: compteurs d'exemples contradictoires, image erronée, RELEASING.md périmé, hot-reload no-op en Docker, anti-pattern unhandled rejection

- **Severity:** Low
- **Confidence:** Confirmed
- **Domain:** DX / Docs
- **Location:** `README.md:25,567,571-580,706,721,214`; `packages/worker-manager/README.md:179`; `RELEASING.md:71-85`; `docker/start-examples.sh:25`; `examples/*/package.json` (engines >=20); `examples/*/src/*.mjs` (IIFE async sans .catch)

### Problem

- README: "8 ready-to-run examples" (l.25), "Nine" (l.567), table de 10 (l.571-580), "All 6 example servers" (l.721, Docker en démarre 8).
- README:706: "node:25-slim" — Dockerfile.test est `node:22-slim`.
- README:214: "SIGHUP is logged but ignored" — le handler est un no-op silencieux.
- `packages/worker-manager/README.md:179`: lien vers `../../docs/audit-2026-05-03.md` inexistant.
- RELEASING.md: décrit des versions RC (`1.0.0-rc.1`) alors que les packages sont en 1.2.0/1.1.0 stables.
- hot-reload en Docker: `watch: ["./src"]` résout `/app/src` ( inexistant) — le watch ne fait rien dans `examples:start` (fonctionne en local).
- engines des exemples `>=20` vs requirement core `>=22.12`.
- Tous les exemples: `(async () => { ... })()` sans `.catch()` → unhandled rejection copiable en prod.

### Evidence

Chacune vérifiée par le sous-audit docs.

### Impact

Crédibilité et onboarding; le hot-reload Docker no-op est le plus trompeur (feature démo silencieusement inopérante dans le run documenté).

### Trigger

Lecture des docs / `pnpm examples:start`.

### Verification

Lire (fait).

### Recommended fix

Batch de 30 min: corriger les compteurs (10 partout), l'image, la phrase SIGHUP, le lien mort, RELEASING.md; hot-reload: chemins relatifs au fichier du plugin (`new URL('./src', import.meta.url)`) ou watch des paths absolus; engines `>=22.12`; ajouter `.catch(err => { console.error(err); process.exit(1); })` dans les exemples.

### Alternatives

Néant.

### Regression risk

Nul.

---

## AUDIT-033 — Gaps de test transversaux: deletions qui passent CI (métriques, races recycle×shutdown, ordre de queue)

- **Severity:** Medium
- **Confidence:** Confirmed
- **Domain:** Testing
- **Location:** `test/orchestrator.test.ts`, `test/worker-manager.test.ts`, `test/shutdown-coordinator.test.ts` (détails par item)

### Problem

Bugs que je pourrais introduire aujourd'hui sans qu'aucun test n'échoue (vérifiés par grep/assertion-inversion du sous-audit):

1. Supprimer `metrics.gracefulShutdowns++` (`orchestrator.ts:649,662`) — compteur jamais asserté.
2. Supprimer les guards `isShutdownInProgress()` des timers d'escalade de drain (`orchestrator.ts:818,825`) — SIGTERM/SIGKILL pendant shutdown; aucune couverture recycle×shutdown.
3. Supprimer le `break` mid-roll de `restartWorkers` (`:389`) — cf. AUDIT-003.
4. Swallower les erreurs d'`installPlugins` (`:171-175`) — cf. AUDIT-005.
5. `shift()` → `pop()` dans `processRestartQueue` (`:715`) — l'ordre FIFO n'est jamais asserté par workerId.
6. `every` → `some` dans `waitForWorkersToExit` (`shutdown-coordinator.ts:212`) — shutdown résolu avec un worker vivant.
7. Supprimer la branche `stabilityWindowMs === 0` (`orchestrator.ts:606-613`) — jamais testée au niveau orchestrateur.
8. Supprimer la guard shutdown de `setReady()` (`:285-287`) — zéro test de `setReady()`.
9. Retirer le try/catch de `runShutdownCallbacks` (`:942-948`) — un callback throwant casse la chaîne de drain.
10. Toute variation de la grammaire WEB_CONCURRENCY (`:989-1006`) — cf. AUDIT-007.
11. Retimer l'escalade de drain ≤ 7s — cf. AUDIT-002.

### Evidence

Chaque item vérifié par absence d'assertion correspondante (sous-audit tests, méthode: grep des symboles + lecture des assertions).

### Impact

Filet de sécurité troué précisément sur les chemins transversaux (races inter-composants), là où les unit tests mockés ne regardent pas.

### Trigger

Refactoring ordinaire.

### Verification

Appliquer chaque mutation → CI vert.

### Recommended fix

Prioriser (impact×probabilité): tests pour 1, 2, 5, 6 (métriques + races shutdown) en premier; puis 3/4/8/9 (gards publics); 7/10/11 ensuite. La liste est la spec de `TESTING.md`.

### Alternatives

Coverage-per-file thresholds — complémentaire mais n'attrape pas les deletions de compteur (le code est couvert, l'assertion absente).

### Regression risk

Nul.

---

## Seconde passe (Phase 14) — ce que j'ai réfuté ou affiné

Par honnêteté méthodologique, les conclusions initiales suivantes ont été corrigées après re-vérification:

- **Orphan-fork massif pendant le shutdown (initialement High):** réfuté en code actuel — `cluster.fork()` et la capture de liste d'`initiateShutdown` sont synchrones; la fenêtre réelle est quasi nulle tant que le `break` existe. Reformulé en AUDIT-003 (test gap + événement mensonger).
- **`forcedKills` non incrémenté dans `killWorkerGradually`:** réfuté — il l'est (`shutdown-coordinator.ts:246`) et c'est la métrique la mieux couverte de la suite.
- **Backoff "reset par chaque worker online" (suspecté bug de contention):** affiné — le timer partagé avec clear/re-arm est la sémantique voulue ("dernier online gagne"); le cas discriminant (crash à window−1ms) reste non testé (AUDIT-033 item 7).
- **`getCPUCount` sync fs sur l'event loop:** non-retenue — appelé une fois et mis en cache (`cachedAutoWorkerCount`), coût négligeable.
- **Duplication de tests backoff:** confirmée mais sans conséquence technique directe → reléguée (pas un finding numéroté; voir TESTING.md).

---

## Matrice de risques

Probabilité (P): Low / Med / High · Impact (I): Low / Med / High · Sévérité: dérivée (P×I, hors "facile à corriger ≠ peu grave") · Priorité: P1 (immédiat) / P2 (proche) / P3 (planifié).

| Finding | Domaine | P | I | Sévérité | Confiance | Priorité |
|---|---|---|---|---|---|---|
| AUDIT-001 registerOnShutdown mort (multi-workers) | Reliability | High | High | **High** | Confirmed | P1 |
| AUDIT-012 Flush OTLP perdu au déploiement | Reliability | High | Med | High | Confirmed | P1 |
| AUDIT-015 Payload .env perdue (file-watcher) | Data integrity | Med | High | High | Confirmed | P1 |
| AUDIT-014 Watchers post-cleanup → shutdown pend | Reliability | Low | High | Medium | Confirmed | P1 |
| AUDIT-013 Single-worker detection cassée (auto) | Correctness | Med | Med | Medium | Confirmed | P1 |
| AUDIT-002 Drain recyclé SIGKILLé à 7s | Reliability | Med | Med | Medium | Confirmed | P2 |
| AUDIT-004 Timer backoff non unref (exit retardé) | Operations | Med | Low | Medium | Confirmed | P1 |
| AUDIT-003 restart:complete mensonger + gap test | Testing/Obs | Med | Low | Medium | Confirmed | P2 |
| AUDIT-005 installPlugins sans isolation/rollback | Reliability | Low | Med | Medium | Confirmed | P2 |
| AUDIT-033 11 mutations passent CI | Testing | High | Med | Medium | Confirmed | P2 |
| AUDIT-023 Actions tag-pinnées | Security | Low | Med | Medium | Confirmed | P1 |
| AUDIT-024 pnpm dlx publint | Security | Low | Med | Medium | Confirmed | P1 |
| AUDIT-029 Benchmarks invalides/non régénérables | Ops | Med | Med | Medium | Confirmed | P3 |
| AUDIT-030 Ports fantômes + inertia non bootés | Ops | High | Low | Medium | Confirmed | P3 |
| AUDIT-031 Smoke test mort, pas de gates CI | Testing | High | Med | Medium | Confirmed | P3 |
| AUDIT-010 Breaker silencieux sans logger | Observability | Med | Med | Medium | Confirmed | P3 |
| AUDIT-020 Prometheus reinstall throw (single) | Correctness | Low | Low | Low | Confirmed | P2 |
| AUDIT-018 otlp latch isShutdown | Correctness | Low | Low | Low | Confirmed | P2 |
| AUDIT-022 getMetrics() zéro en worker | DX | Med | Low | Low | Confirmed | P2 |
| AUDIT-021 Amplification scrape IPC | Perf/Sec | Low | Med | Low | Confirmed | P3 |
| AUDIT-019 Fuite AggregatorRegistry (upstream) | Perf | Low | Med | Low | Confirmed | P3 |
| AUDIT-009 Signaux après fork (boot) | Reliability | Low | Med | Low | Confirmed | P3 |
| AUDIT-006 health.live mort | API | High | Low | Low | Confirmed | P3 |
| AUDIT-007 WEB_CONCURRENCY silencieux | Obs | Med | Low | Low | Confirmed | P3 |
| AUDIT-008 use() après run() ignoré | DX | Low | Low | Low | Confirmed | P3 |
| AUDIT-011 Cache faux négatif reuseport | Resilience | Low | Low | Low | Likely | P3 |
| AUDIT-016 parse-env ≠ dotenv | Correctness | Med | Low | Low | Confirmed | P3 |
| AUDIT-017 Global provider écrasé | DX | Low | Low | Low | Confirmed | P3 |
| AUDIT-025 Blocklist gaps | Security | Low | Low | Low | Confirmed | P3 |
| AUDIT-026 Exemples 0.0.0.0 + METRICS_HOST fantôme | Sec/DX | Med | Low | Low | Confirmed | P2 |
| AUDIT-027 Images flottantes | Sec | Low | Low | Low | Confirmed | P3 |
| AUDIT-028 SECURITY.md gaps + tags | Sec | Low | Low | Low | Confirmed | P3 |
| AUDIT-032 Dérive documentaire (bundle) | DX | High | Low | Low | Confirmed | P3 |
