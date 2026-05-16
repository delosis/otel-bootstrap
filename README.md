# @delosis/otel-bootstrap

OpenTelemetry bootstrap for Delosis Azure Functions (Node.js v4 programming model).

Sets up the worker-side TracerProvider with auto-instrumentations for outbound HTTP, `@azure/cosmos`, and other Node libraries. Exports OTLP traces to the endpoint configured via the standard `OTEL_*` environment variables.

This package exists so every Delosis Function App can opt into the same trace pipeline with one dependency line and a one-line require — no per-app boilerplate, central version control.

## Install

In the target Function App repo:

```bash
npm install --save github:delosis/otel-bootstrap#v1.0.0
```

Pin to a specific tag — never `main` — so production behaviour can't drift unexpectedly.

## Wire it in

Create `src/index.js` in the Function App project:

```javascript
require('@delosis/otel-bootstrap');
```

Then update the `"main"` field in `package.json` so the bootstrap loads before any function:

```json
{
  "main": "src/{index.js,functions/*.js}"
}
```

## Environment variables

This package reads only the standard OpenTelemetry env vars — set them on the Function App via App Settings:

| Variable | Example value |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` *(or generic `OTEL_EXPORTER_OTLP_ENDPOINT`)* | `https://grafana.delosis.com/otlp/v1/traces` (or base `…/otlp` for generic — SDK appends `/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` *(or generic `…_HEADERS`)* | `Authorization=Basic%20<base64-of-user:pass>` (W3C-Baggage percent-encoded — literal spaces will silently truncate the header) |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/protobuf` |
| `OTEL_SERVICE_NAME` | The Function App name (e.g. `pradam-api`) |
| `OTEL_RESOURCE_ATTRIBUTES` | `deployment.environment=production,project=<key>` |

For the full multi-signal recipe (logs + metrics + traces, all going to the Delosis Loki/Prometheus/Tempo stack behind `grafana.delosis.com`), see the OTel rollout workbook in Hexis memory.

## What this package does NOT do

- **Does not bootstrap logs.** The Functions host already captures `context.log()` via stdout and ships it through its own OTLP logs exporter when `telemetryMode: OpenTelemetry` is in `host.json`. Duplicating that path from the worker would cause double-counted log records in Loki.
- **Does not bootstrap metrics.** Same reasoning — the host emits its own metrics over OTLP.
- **Does not set the Function App's `host.json` or App Settings** — those are per-app deploy concerns. See the workbook.

## Versioning

Tag releases as `v1.X.Y`. Function Apps pin to a specific tag and opt-in to upgrades by bumping the `#v…` suffix in their `package.json`.

Breaking changes (e.g. removing an instrumentation, switching exporter protocol, changing the batch processor) bump the major. Additive (new instrumentations, dependency upgrades) bump the minor.

## License

MIT.
