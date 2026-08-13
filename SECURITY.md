# Security Policy

## Supported Versions

Only the latest published version of each package receives security fixes:

| Package                         | Supported    |
| ------------------------------- | ------------ |
| `@goopil/clusterkit`            | latest minor |
| `@goopil/clusterkit-prometheus` | latest minor |
| `@goopil/clusterkit-sizing`     | latest minor |

## Reporting a Vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report them privately via [GitHub Security Advisories](https://github.com/Goopil/clusterkit/security/advisories/new).

You can expect an acknowledgement within 7 days. Once a fix is available, the
vulnerability will be disclosed in the release notes with credit to the
reporter (unless you prefer to stay anonymous).

## Deployment recommendations

- Do not expose the Prometheus metrics endpoint of your host app publicly:
  bind it to a private interface and/or protect it with authentication. Every
  uncached scrape fans out IPC requests to all workers.
- The orchestrator trusts its configuration (`workerEnv`, `execArgv`,
  `NODE_OPTIONS`). Treat orchestrator config as code — never build it from
  untrusted input.
