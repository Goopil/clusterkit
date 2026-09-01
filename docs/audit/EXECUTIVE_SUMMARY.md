# Executive Summary — Audit clusterkit 2026-08-31

## Verdict global: **7.5 / 10** — Niveau de risque: **modéré, concentré sur le cycle de déploiement et la périphérie**

Bibliothèque d'orchestration de workers Node.js **au-dessus de la moyenne du marché npm**: architecture décomposée propre, zéro dépendance runtime tenue, validation et sécurité défensive sérieuses, suite de tests rigoureuse sur les chemins unitaires, chaîne de publication (OIDC, changesets, tests-before-publish) exemplaire.

Les problèmes réels se concentrent sur **trois zones**:

1. **Le contrat de shutdown est asymétrique** — l'API documentée `registerOnShutdown()` n'est jamais appelée en primaire multi-workers (AUDIT-001, High), ce qui casse aussi le flush OTLP à chaque déploiement (AUDIT-012) et le cleanup des plugins qui s'y fient.
2. **Les chemins croisés ne sont pas testés** — 11 mutations dangereuses passent CI aujourd'hui (AUDIT-033): races recycle×shutdown, ordre de la queue de restart, compteurs de métriques non assertés.
3. **La périphérie a dérivé du code** — docs contradictoires, ports de métriques fantômes dans 5 endroits, benchmarks non régénérables avec une comparaison pm2 invalide, smoke test des exemples jamais exécuté (AUDIT-029/030/031/032).

Sécurité: **aucun Critical ni High**; deux Medium d'hygiène CI (actions tag-pinnées, `pnpm dlx publint`) à fermer en 30 minutes.

## Scores

| Domaine | /10 | Justification courte |
|---|---|---|
| Correctness | 7 | Bugs réels mais bénins hors AUDIT-001; guards de course solides |
| Architecture | 9 | Décomposition nette, pas de cycles, plugin system minimal juste |
| Performance | 9 | Core léger; amplification scrape + fuite upstream, plafonnés |
| Scalability | 8 | Linéaire et borné par design (256 workers cap); rolls sérieux |
| Stability | 8 | Timer hygiene presque parfaite; races croisées non testées |
| Resilience | 6.5 | Contrat de shutdown asymétrique; flush perdu; breaker silencieux par défaut |
| Security | 7.5 | Zéro dépendance, OIDC, threat model écrit; hygiène CI à finir |
| Data integrity | 8 | Env des workers: 1 chemin de perte (AUDIT-015); pas d'état persistant |
| Testing | 7 | Unit rigoureuse; chemins croisés et périphérie non exécutés |
| Maintainability | 8 | Petit, lisible, conventionné; docs multi-sources qui dérivent |
| Observability | 6.5 | Par défaut silencieux; événements mensongers possibles; live mort |
| Operations | 7 | Pipeline de release sérieux; runbook et diagnostic à écrire |
| Developer experience | 8.5 | AGENTS.md excellent, turbo/biome/vitest bien réglés |

**Appréciation:** produit fiable pour son coeur, dont la confiance utilisateur est menacée non pas par des crashes mais par des **promesses non tenues** (API morte, docs fausses, données perdues à l'arrêt).

## Top 10 des problèmes

| # | ID | Problème | Sévérité |
|---|---|---|---|
| 1 | AUDIT-001 | `registerOnShutdown` jamais appelé en primaire multi-workers (API documentée morte) | High |
| 2 | AUDIT-033 | 11 mutations dangereuses passent CI (métriques, races croisées, ordre) | Medium |
| 3 | AUDIT-012 | Flush OTLP perdu à chaque déploiement (conséquence #1) | Medium |
| 4 | AUDIT-015 | file-watcher perd le payload `.env` → restart avec env périmé | Medium |
| 5 | AUDIT-014 | file-watcher: watchers redémarrés après cleanup → shutdown qui pend | Medium |
| 6 | AUDIT-013 | signal-restart/file-watcher: détection single-worker cassée avec `auto` → SIGHUP no-op silencieux | Medium |
| 7 | AUDIT-002 | Drain des recyclages SIGKILLé à 7s quel que soit `timeoutMs` configuré | Medium |
| 8 | AUDIT-029 | BENCHMARKS.md non régénérable + comparaison pm2 invalide (bug harness) + p95 mensonger | Medium |
| 9 | AUDIT-023/024 | CI: actions tag-pinnées + `pnpm dlx publint` (supply chain) | Medium |
| 10 | AUDIT-030/031 | Ports de métriques fantômes (NestJS), exemples inertia jamais bootés, smoke test mort | Medium |

## Risques critiques

- **Aucun risque data-loss utilisateur majeur** (le core ne manipule pas de données persistantes). Le risque le plus tangible est la **perte de métriques à chaque déploiement** (post-mortem amputé) et le **restart avec env périmé** (AUDIT-015) — les deux sont des silent failures.

## Recommandations immédiates (≤ 1 jour)

1. Appeler `runShutdownCallbacks` dans `shutdownPrimary` + test d'invariant 3 modes (AUDIT-001/012).
2. SHA-pinner les 4 actions restantes + publint en devDependency (AUDIT-023/024).
3. `unref()` sur le timer de backoff (AUDIT-004) — une ligne.
4. `orchestrator.workerCount === 1` dans signal-restart/file-watcher (AUDIT-013) — deux lignes.

## Ce qui est volontairement NOT changé

Voir `REMEDIATION_PLAN.md` §Do-not-fix et `FINDINGS.md` §Seconde passe — en particulier: pas de split d'`orchestrator.ts`, pas d'allowlist execArgv, pas de logger par défaut, pas d'abstraction de cycle de vie commune, `Math.floor` du sizing (documenté, direction conservatrice correcte).
