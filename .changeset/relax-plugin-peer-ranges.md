---
"@goopil/clusterkit-sizing": minor
"@goopil/clusterkit-prometheus": minor
"@goopil/clusterkit-signal-restart": minor
"@goopil/clusterkit-file-watcher": minor
"@goopil/clusterkit-otlp-meter": minor
---

Relax the `@goopil/clusterkit` peer dependency from an exact version pin to a caret range (`^1.2.0`). Plugins now remain installable with newer core minor releases without requiring a matching plugin upgrade.
