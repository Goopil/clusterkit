# Operations — Audit clusterkit 2026-08-31

## Score observabilité: 6.5/10 · Opérations: 7/10

## Le scénario 3h du matin

> Crash loop à 3h. Qu'est-ce qui me le dit ?

1. **Si un logger est configuré** (pino/winston): logs structurés "Crash loop detected — stopping restarts", readiness flippée. ✔
2. **Sinon (défaut):** rien. Zéro sortie, `getHealth().ready` interne, seul signal = les requêtes échouent. ✘ (AUDIT-010)
3. **Métriques:** rien n'est exposé par défaut — prometheus/otlp sont opt-in, correct pour une lib. Mais l'utilisateur qui n'a câblé ni les événements ni un endpoint a un système cassé qui ne le dit pas.
4. **Métriques à l'arrêt:** perdues à chaque déploiement (AUDIT-001/012) — les dashboards autour d'un incident de déploiement montrent un trou.
5. **Exit codes:** un shutdown "réussi" peut finir en SIGKILL (137) à cause d'un timer backoff non unref (AUDIT-004) — fausse piste garantie en investigation.
6. **`restart:complete`** émis après un roll abandonné (AUDIT-003) — un dashboard "last restart OK" ment.
7. **`health.live`** toujours true (AUDIT-006) — aucun signal liveness exploitable du produit.

## Inventaire observabilité

| Signal | État |
|---|---|
| Logs | Structurés (Logger iface), composants préfixés, opt-in (défaut null) |
| Métriques orchestrator | Via plugins (prometheus/otlp), bien faites |
| Correlation IDs | N/A (pas de requête applicative; les `reason` des restarts jouent ce role — bien) |
| Health/readiness | `getHealth()` interne, jamais exposé par le produit; `live` mort |
| Alertes | À construire par le consommateur sur les événements (`circuit-breaker:tripped`, `worker:crash`) — la surface d'événements est complète et typée ✔ |
| Diagnostic post-mortem | `worker:exit` (code, signal, graceful) + `metrics` snapshot — suffisant |

## Déploiement & release

- **Pipeline:** lint → build → test (Node 22/24/26 × ubuntu/macos) → docker Linux → packaging publint → publish OIDC sur merge main. Sérieux, ordre correct, publish testé-avant-publish. ✔
- **Versioning:** changesets + OIDC trusted publishing, pas de token long-vie. ✔ (RELEASING.md périmé, AUDIT-032.)
- **Zero-downtime:** le produit EST le zero-downtime mechanism (reuseport + rolling restart + drain). Les exemples démontrent le pattern. ✔
- **"Que se passe-t-il si la nouvelle version tourne avec l'ancienne ?"** — cas nominal couvert (recycle/hot-restart, env overlay). Cas dégradé: crash du primaire en bare-metal → workers orphelins d'une ancienne version continuent de servir (voir RELIABILITY §5). Documenter la limitation.
- **Rollback:** n/a (lib). Les exemples n'ont pas de stratégie documentée de rollback après hot-restart avec env overlay — le overlay env ne survit pas au restart des workers (par design, documenté ?). Vérifier la doc (mineur).

## Incidents — diagnostic

- La fenêtre de fuite prom-client (AUDIT-019) se manifestera comme "RSS du primaire qui monte pendant les incidents" — à connaître avant de regarder la mémoire.
- Les workers SIGKILLés à 7s au lieu de 12s (AUDIT-002) se manifestent comme "mes drains longs meurent au recycle mais pas au shutdown" — piège de diagnostic classique.
- Le hot-reload Docker no-op (AUDIT-032) — "le watcher ne fait rien en conteneur" coûtera une heure à quelqu'un.

## Runbook minimum (à ajouter au README, 10 lignes)

1. Flotte qui ne redémarre plus → chercher `circuit-breaker:tripped`; remediation `resetCircuitBreaker()` après fix.
2. Primaire qui ne sort pas au SIGTERM → vérifier timers backoff (AUDIT-004), watchers file-watcher post-delay (AUDIT-014).
3. `/metrics` à zéro → getMetrics() appelé dans un worker (AUDIT-022).
4. Env des workers périmé après édition .env → AUDIT-015 (payload coalescing).
