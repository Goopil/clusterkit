# Sécurité — Audit clusterkit 2026-08-31

Verdict: **pas de Critical ni High**. La posture est nettement au-dessus de la moyenne pour un package npm: zéro dépendance runtime dans le core, publish OIDC sans token long-vie, threat model écrit, garde prototype-pollution en profondeur. Les deux Medium sont de l'hygiène CI (pinning). Les gaps restants sont des garde-fous de configuration, pas des frontières de sécurité.

## Théorie des menaces (telle que posée par le repo)

`SECURITY.md:28-30`: la configuration de l'orchestrateur est du code de confiance. Toute la sécurité des options (`execArgv`, `workers.env`) est donc un garde-fou anti-erreur, pas un boundary contre un attaquant. L'audit l'applique tel quel — un flag non bloqué n'est High que s'il est atteignable depuis une input non fiable (il ne l'est pas).

## Findings sécurité (références vers FINDINGS.md)

| ID | Titre | Severity | Confiance |
|---|---|---|---|
| AUDIT-023 | Actions tierces tag-pinnées (`codecov-action@v7`, `upload-artifact@v4`, trio `@v4` de cq.yml) mélangées aux SHA-pinnées | Medium | Confirmed |
| AUDIT-024 | `pnpm dlx publint` — RCE non-pinné à chaque CI | Medium | Confirmed |
| AUDIT-025 | Blocklist execArgv: `--tls-keylog`, `--cpu-prof/--heap-prof`, `--report-on-*`, `--redirect-warnings`, `--diagnostic-dir` passent; NODE_OPTIONS warn-only (délibéré) | Low | Confirmed |
| AUDIT-026 | Exemples: metrics sans auth sur 0.0.0.0; `METRICS_HOST` documenté mais inexistant | Low | Confirmed |
| AUDIT-027 | Images flottantes (`otel collector:latest`, node tag-only) | Low | Confirmed |
| AUDIT-028 | SECURITY.md: 3 packages publiés absents de la politique; `release.yml` pousse tous les tags | Low | Confirmed |
| AUDIT-021 | Amplification IPC par scrape `/metrics` public (recoupe SECURITY.md:25-27) | Low | Confirmed |
| AUDIT-016/parse-env | Clés `__proto__`/`constructor` du `.env`: no-op inoffensif / rejet par `assertSafeEnvObject` — pas d'escalade (spread ne copie que les clés propres) | — | Confirmed (sain) |

## Ce qui est fait correctement (vérifié, pas supposé)

- **Chaîne de publication:** `publish-with-oidc.mjs` publie le tarball qu'il vient de pack (`pnpm pack` → `npm publish <tarball>`), pas de fenêtre TOCTOU build↔publish; provenance npm OIDC liée à `Goopil/clusterkit` + `release.yml`; garde fork `release.yml:35`; **aucun `npm publish` manuel**; pas de token npm long-vie dans le repo.
- **Workflows:** pas de `pull_request_target`, pas d'injection de workflow (aucune interpolation de `github.event.*` dans `run:`), `permissions: contents: read` minimal, escalade uniquement dans release.yml où nécessaire.
- **Docker:** `cap_drop: ALL` + `no-new-privileges` + `USER app` sur les trois images; pas de docker-socket monté; pas de secrets dans les images; corepack pinné.
- **Secrets:** scan du tree + historique git: rien de compromis; un seul `.env.example` avec valeur factice; endpoints OTLP par défaut localhost.
- **Supply chain des packages:** core réellement sans `dependencies`; plugins en peerDependencies (pattern paresseux-correct); aucun lifecycle script suspect; pnpm 10 bloque les scripts d'install non approuvés; smoke test consommateur avec `--ignore-scripts`.
- **Prototype pollution:** rejet des clés interdites à la validation (`validation.ts:44-59`) **et** re-vérification des deux sources d'env au fork (`worker-manager.ts:77-78`); le blind spot de l'objet-littéral `__proto__` est documenté comme le cas sûr; aucun sink `x[k] =` dans le core.

## Scénario d'attaque le plus réaliste aujourd'hui

Compromission de l'image/tag d'une action CI flottante ou de `publint` (AUDIT-023/024) → exécution de code dans CI. Impact plafonné (tokens faibles, GITHUB_TOKEN read-only, publish séparé OIDC), mais c'est le seul chemin qui ne passe pas par le vol d'une session mainteneur. Fermer ces deux trous coûte ~30 min.

## Recommandations hors-scope findings

Aucune. Pas de SAST/DAST supplémentaire à ajouter pour un projet de cette taille; Dependabot est déjà configuré; les overrides pnpm ciblent les vraies gammes vulnérables (le résidu ws@7/js-yaml@3 vient des deps privées de benchmarks — acceptable, documenté).
