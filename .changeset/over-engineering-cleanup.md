---
"@goopil/clusterkit": patch
"@goopil/clusterkit-prometheus": patch
"@goopil/clusterkit-sizing": patch
---

Over-engineering cleanup: remove dead methods and flags (`bypassCache`, `memory-first` strategy, `clusterRecommended`), simplify internals. The shutdown non-ACK warn (previously unreachable) now fires with a worker count.
