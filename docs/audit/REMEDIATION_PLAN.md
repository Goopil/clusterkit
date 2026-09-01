# Remediation Plan — Audit clusterkit 2026-08-31

Priorisation: **impact × risque × urgence / effort**. Chaque tâche référence ses IDs. Les phases sont cumulables; Phase 0 peut être livrée en une demi-journée.

## Phase 0 — Immediate (critique, ≤ 1 jour)

- [ ] Fix AUDIT-001 — exécuter `runShutdownCallbacks(signal)` dans `shutdownPrimary()` + test d'invariant paramétré sur les 3 modes (primaire-multi / single / worker). *Effort: S. Risque si non fait: cleanup/flush silencieusement sautés à chaque déploiement.*
- [ ] Fix AUDIT-012 — flush OTLP aussi dans `uninstall()` (idempotent) — protège le path uninstall même avant la correction complète de 001. *Effort: XS.*
- [ ] Fix AUDIT-004 — `.unref()` sur le timer de backoff (`orchestrator.ts:748`). *Effort: XS — une ligne.*
- [x] Fix AUDIT-013 — `orchestrator.workerCount === 1` dans signal-restart (`:58`) et file-watcher (`:104`). *Effort: XS + tests.*
- [x] Fix AUDIT-023 — SHA-pinner `codecov-action`, `upload-artifact`, et les 3 `@v4` de cq.yml. *Effort: XS.*
- [x] Fix AUDIT-024 — `publint` en devDependencies racine, `pnpm exec publint` dans CI. *Effort: XS.*

## Phase 1 — Stabilisation (réduction du risque, ≤ 1 semaine)

- [ ] Fix AUDIT-014 — tracker le timer `startDelayMs`, garde "closed" dans `startWatchers`. *Effort: S.*
- [ ] Fix AUDIT-015 — fusion du payload env dans le debounce + trailing flush après skip `minRestartIntervalMs`. *Effort: S + tests.*
- [ ] Fix AUDIT-005 — enrichir l'erreur d'`installPlugins` (nom du plugin) + rollback des plugins déjà installés. *Effort: S.*
- [ ] Fix AUDIT-002 — dériver l'escalade de `drainRecycledWorker` de la config shutdown + pinner les durées dans le test. *Effort: S (attention: AUDIT-033 item 11 pour le test).*
- [ ] Fix AUDIT-003 — ne pas émettre `restart:complete` (ou `aborted: true`) sur break + test du chemin.
- [ ] Tests AUDIT-033 (items 1, 2, 5, 6 d'abord): `gracefulShutdowns` asserté, guards recycle×shutdown, FIFO de la queue, `waitForWorkersToExit` négatif.
- [ ] Fix AUDIT-020 — flag `defaultMetricsInstalled` (prometheus reinstall).
- [ ] Fix AUDIT-018 — reset du latch `isShutdown` au reinstall (otlp).
- [ ] Fix AUDIT-022 — throw explicite si `getMetrics()` hors primaire (prometheus).

## Phase 2 — Performance (impact mesurable)

- [ ] AUDIT-019 — upstream PR prom-client (`requests.delete` dans le path timeout) + documenter le symptôme côté plugin. *Effort: M (dépend upstream).*
- [ ] AUDIT-026 — `METRICS_HOST` supporté dans les exemples (défaut loopback hors Docker) + fix de la phrase README:588. *Effort: S.*
- [ ] Ajouter le runbook minimal et 2-3 benchmarks recommandés (scrape storm, fork rate) dans `benchmarks/` — seulement si un besoin réel se manifeste. *Effort: M. Sinon: skip (voir Do-not-fix).*

## Phase 3 — Architecture (dette structurelle)

- [ ] AUDIT-029 — réparer le harness benchmarks: `ready` signalé à pm2, reporter générant la vraie liste workloads/targets, colonne `Lat p97.5`, regénérer BENCHMARKS.md, flagger/retirer les tables macOS `single`. *Effort: M + un run de bench (~36min docker).*
- [ ] AUDIT-030 — décision: ajouter les serveurs de métriques NestJS (~40 lignes) **ou** retirer les ports fantômes (README/compose/start-examples/Dockerfile) et le plugin prometheus des inertia. Idem inertia: route + smoke ou nettoyage. *Effort: S-M, décision produit.*
- [ ] AUDIT-031 — brancher le smoke test des exemples (package.json + job CI) + assertion `reusePort === true` dans le harness Linux + smoke benchmarks en nightly. *Effort: M.*
- [ ] AUDIT-009 — enregistrer les signaux avant `forkWorkers`. *Effort: XS.*
- [ ] ADR: sémantique exacte de `registerOnShutdown` (ordre relatif au drain) — documenter la décision prise en Phase 0.

## Phase 4 — Long term (non urgent)

- [ ] AUDIT-025 — étendre la blocklist execArgv (tls-keylog, cpu-prof, report-, redirect-warnings, diagnostic-dir).
- [ ] AUDIT-016 — commentaires inline + clés interdites dans `parse-env.ts`; documenter les limites du parser.
- [ ] AUDIT-006 — documenter `health.live` comme constant + test d'invariant (ou le retirer en 2.0).
- [ ] AUDIT-007 — warn sur `WEB_CONCURRENCY` invalide.
- [ ] AUDIT-008 — throw sur `use()` après `run()`.
- [ ] AUDIT-010 — `process.emitWarning` sur `circuit-breaker:tripped` quand aucun logger.
- [ ] AUDIT-011 — ne pas cacher le `false` issu du timeout de sonde reuseport.
- [ ] AUDIT-017 — ne pas écraser un provider OTel global préexistant + corriger la doc types.ts.
- [ ] AUDIT-027 — pin digest du collector OTEL.
- [ ] AUDIT-028 — compléter SECURITY.md (3 packages), ne pousser que les tags du run.
- [ ] AUDIT-032 — batch docs: compteurs d'exemples, image, SIGHUP, lien mort, RELEASING.md, engines >=22.12, hot-reload paths, `.catch()` dans les exemples.
- [ ] AUDIT-033 (reste) — items 7-11 + per-file coverage thresholds sur les packages publiés.

## Quick wins (fort impact, faible effort)

| Action | IDs | Effort |
|---|---|---|
| `runShutdownCallbacks` dans shutdownPrimary + test invariant | 001, 012 | S |
| `.unref()` timer backoff | 004 | XS |
| `workerCount === 1` dans 2 plugins | 013 | XS |
| SHA-pin actions + publint local | 023, 024 | XS |
| Signaux avant fork | 009 | XS |

## Structural fixes

- Invariant de cycle de vie testé sur les 3 modes (001 + 033) — c'est le seul changement qui empêche **une classe** de régressions plutôt qu'un cas.
- Examples comme surface exécutable (031 + 030) — tue la classe "doc fausse non détectée".

## Long-term debt (réel, peut attendre)

- Fuite prom-client upstream (019), blocklist hardening (025), parser .env (016), docs cosmétiques (032), gates de perf (031 partiel).

## Do not fix (coût > bénéfice, décision explicite)

1. **Ne pas splitter `orchestrator.ts`** — 1011 lignes de façade, granularité de services déjà correcte. Un split n'apporterait rien de mesurable.
2. **Ne pas passer `DANGEROUS_ARG_PATTERNS` en allowlist** — threat model opérateur-de-confiance (SECURITY.md:28-30); breaking pour des configs légitimes; le gain est cosmétique. Étendre la blocklist suffit (025).
3. **Ne pas ajouter de logger par défaut** — le contrat "silencieux par défaut" est promis et documenté; le `emitWarning` ciblé (010) couvre le seul risque réel.
4. **Ne pas paralléliser `processRestartQueue`** — la sérialisation avec backoff est le mécanisme anti fork-bomb voulu; changer c'est re-concevoir le tradeoff sans incident mesuré.
5. **Ne pas abstraire un "Lifecycle" commun** aux 3 chemins de shutdown — le test d'invariant (Phase 0) capture la garantie sans nouvelle interface à une seule implémentation.
6. **Ne pas revoir `Math.floor` du sizing** — direction conservatrice documentée et testée (sous-provisioning volontaire, 0.5 CPU perdus max).
7. **Ne pas patcher/forker prom-client localement** — upstream PR ou vivre avec (fuite lente, fenêtre incident).
8. **Ne pas ajouter de cache/agrégation au scrape prometheus au-delà de l'existant** — la dédup in-flight de prom-client + le cache 1s couvrent l'usage nominal; mesurer avant.
