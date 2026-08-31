# Performance — Audit clusterkit 2026-08-31

Contexte: bibliothèque d'orchestration de process. Pas de DB, pas de réseau applicatif propre; les hot paths sont le fork, l'IPC, et les scrapes de métriques. Pas de micro-optimisation valable ici — les constats qui suivent ont un impact mesurable.

## Score performance: 9/10

Le core est léger et bien comporté. Les problèmes trouvés sont périphériques ou upstream.

## Bottlenecks et constats

### 1. Amplification IPC par scrape `/metrics` (AUDIT-021)

- **Coût actuel:** chaque scrape avec cache expiré (défaut 1000ms) diffuse un message IPC vers chaque worker et agrège les réponses. N workers = N messages + agrégation par scrape.
- **Facteur d'aggravation:** endpoint public sans auth dans les exemples (AUDIT-026); les scrapers Prometheus par défaut vont toutes les 15s — un scraper agressif multiplie.
- **10× trafic:** linéaire en requêtes, mais chaque requête coûte O(workers) IPC. 1 scrape/s × 256 workers = 256 msg/s soutenus — négligeable pour un usage normal, DoS-able si public.
- **10× workers:** O(n) par scrape, linéaire — tient.
- **Sous concurrence:** les scrapes simultanés sont dédupliqués par prom-client (in-flight dedup, vérifié) — bien.
- **Remédiation:** bind loopback (AUDIT-026), cache déjà configurable. Pas de changement core nécessaire.

### 2. Fuite mémoire `AggregatorRegistry` (AUDIT-019, upstream)

- **Coût actuel:** une entrée de Map par scrape en timeout (worker unreachable), jamais supprimée (prom-client 15.1.3).
- **10× / 10 heures:** croissance lente, proportionnelle aux scrapes échoués. Scenario réaliste: incident + monitoring qui scrape → fuite pendant l'incident, persistée après.
- **Impact financier:** nul en soi; RSS du primaire croissant peut déclencher des OOMKills en conteneur à limite mémoire serrée.
- **Remédiation:** upstream PR (une ligne); plugin: documenter le symptôme.

### 3. Restart série avec backoff (conception, pas un bug)

- **Comportement:** les restarts sont traités **un par un** (`processRestartQueue`), avec backoff exponentiel 1s→30s partagé à la flotte.
- **10× données/trafic:** sans objet. **Mass crash (OOM killer tue 4 workers):** capacité restaurée à ~1s+2s+4s+8s d'écart (backoff croissant), plafonnée par le breaker à 5 crashes/60s.
- **Tradeoff correct:** protège d'un fork bomb; le coût est une reconstruction de capacité plus lente qu'un restart parallèle. Ne pas changer sans mesure.

### 4. Rolling restart linéaire (plafond documenté)

- `restartWorkers` avec `staggerMs` 1000ms: 256 workers → ≥ 256s par roll complet (+ temps de drain par worker). Acceptable pour du hot-restart; **ne pas scaler le stagger avec la flotte** sans besoin réel.

### 5. Ce qui est propre (constaté, non à changer)

- `getCgroupCpuLimit` en sync fs: appelé une fois, mis en cache (`cachedAutoWorkerCount`) — coût event loop négligeable.
- `CrashTracker`: prune O(n) borné par `max(threshold×2, 100)` — négligeable.
- Sonde reuseport: 2 binds éphémères au plus une fois par process.
- `getActiveWorkers`/`getWorkerAge`: O(workers), appelés à fréquence faible (events/60s).
- Benchmarks: le harness est extérieur au produit; les problèmes de méthodologie sont dans AUDIT-029 (validité des conclusions, pas perf du produit).

## Benchmarks recommandés (produit)

1. **Scrape storm:** 10 scrapes/s × 16 workers, mesurer CPU primaire + latence p99 des scrapes (valider le cache + dedup).
2. **Fork rate:** 100 forks/min soutenus (recycle maxAge agressif) — overhead primaire.
3. **Shutdown avec 256 workers:** temps total SIGTERM→exit, distribution ACK.
Aucun n'existe; les gates de perf en CI n'existent pas non plus (AUDIT-031). Ordre de priorité bas — le produit n'a pas de hot path suspect.
