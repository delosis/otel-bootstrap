# Lessons Learned — Delosis Azure Functions OTel Rollout

Captured 2026-05-17 after rolling OTel observability + a CosmosClient singleton fix across the six Delosis Azure Function apps (coventure10, pass, relmed, univenture-flex, pradam, webhook-service). These projects evolved at different times by different hands and exhibit subtly different patterns that need to be accommodated rather than assumed.

## Per-project shape variations

Don't assume any project matches another's structure.

| | shared/ dir location | host.json `main` field | Deploy mechanism |
|---|---|---|---|
| coventure10 | `src/functions/shared/` | `src/functions/*.js` | `azure_functions/scripts/deploy-with-tests.sh` |
| pass | `src/shared/` (sibling of `src/functions/`) | `src/functions/*.js` | `deploy-azure-functions.sh` (gated on clean git) |
| relmed | `src/functions/shared/` | `src/functions/*.js` | GH Actions on push to **release** branch |
| univenture | `src/functions/shared/` | `src/functions/*.js` | GH Actions on push to **master**, paths filter `azure_functions/**` |
| pradam | `src/functions/shared/` | `src/functions/*.js` | GH Actions on **v\*.\*.\* tag** push |
| webhook-service | `shared/` (no `src/`) | `functions/*.js` | `scripts/deploy.sh` (bash, `func` CLI) |

Implication: the canonical `src/{index.js,functions/*.js}` glob from the workbook **doesn't apply uniformly** — webhook-service needed `{index.js,functions/*.js}` (no `src/`) and PASS needed special care because its `shared/` is one level up from `functions/`.

## Pre-existing patterns that bit during refactor

### 1. `CosmosClient` per-call was universal

Every project had each function file do `const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)` either at module top *or* inside the request handler. Some files did it at module top thinking they were caching — but each file had its own distinct instance, so a worker process running N functions had N CosmosClient instances, each with its own HTTPS connection pool, each paying its own TLS handshake.

**Fix:** one shared `shared/cosmosClient.js` factory with `let _client = null; if (_client) return _client;` lazy singleton. Every function file imports from that.

Measured impact on coventure10: warm-worker API calls dropped from 1500-2400ms → 99-150ms. ~15-20× speedup.

### 2. Multiple env-var conventions for Cosmos auth

Pradam uses **both** `COSMOS_CONNECTION_STRING` (most files) and `COSMOS_DB_ENDPOINT` + `COSMOS_DB_KEY` (in-handler requires in ~12 files). The factory needs to accept either:

```js
if (process.env.COSMOS_CONNECTION_STRING) {
  _client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
} else if (process.env.COSMOS_DB_ENDPOINT && process.env.COSMOS_DB_KEY) {
  _client = new CosmosClient({
    endpoint: process.env.COSMOS_DB_ENDPOINT,
    key: process.env.COSMOS_DB_KEY,
  });
}
```

Webhook-service uses a **third** pattern: `DefaultAzureCredential` + hardcoded endpoint + `aadAudience`. Factory there is project-specific.

### 3. Multi-imports from `@azure/cosmos`

UniVenture and Pradam have files importing both `CosmosClient` and `PartitionKeyBuilder` from `@azure/cosmos`. A perl `s/^const \{ CosmosClient \} = .../const { getCosmosClient } = .../` regex *won't match* these — the import statement has more than one symbol. Treat as a separate refactor pass:

```js
// before
const { CosmosClient, PartitionKeyBuilder } = require("@azure/cosmos");
// after
const { PartitionKeyBuilder } = require("@azure/cosmos");
const { getCosmosClient } = require("./shared/cosmosClient");
```

### 4. Lazy-init inside helpers

Several projects had patterns like:

```js
let cosmosClient = null;
let usersContainer = null;
function getCosmosContainers() {
  if (!cosmosClient) {
    cosmosClient = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
    const database = cosmosClient.database("...");
    usersContainer = database.container("users");
  }
  return { usersContainer };
}
```

This is half-right — the container handle caching is fine, but the `cosmosClient` construction should defer to the shared factory. Strip it down to:

```js
let usersContainer = null;
function getCosmosContainers() {
  if (!usersContainer) {
    const database = getCosmosClient().database("...");
    usersContainer = database.container("users");
  }
  return { usersContainer };
}
```

### 5. Aliased imports

Pradam's `user.js` had `const { CosmosClient: CosmosClientRewards } = require("@azure/cosmos")` to dodge a local naming conflict. Refactor to use the factory and the alias becomes redundant.

## OTel-specific gotchas

### 6. The Functions OTel docs are misleading on logs

Microsoft docs only mention the *generic* `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`. That's enough for traces and metrics, but the .NET Functions host **does not** wire up the OTLP logs exporter from generic env vars alone. You must explicitly set:

- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_HEADERS`
- `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`

Set these *in addition to* the generic forms.

### 7. `Authorization=Basic xxx` must be percent-encoded

The space between `Basic` and the token in the basic-auth header must be `%20` (W3C Baggage encoding), not a literal space. A literal space causes the SDK to silently truncate the header value at the space and ship a broken `Authorization: Basic` (no token) — Loki returns 401 and nothing surfaces. Failure is completely silent; no error in App Insights either.

### 8. `OTEL_TRACES_EXPORTER=none` and `OTEL_METRICS_EXPORTER=none` are ignored

The .NET Functions host ships traces and metrics regardless of these settings. If your receiver isn't routed (e.g. no Tempo, no Prom OTLP receiver), expect 302s at your nginx edge for `/otlp/v1/traces` and `/otlp/v1/metrics`. Harmless but noisy.

### 9. OTel `service.name` → Prometheus `job` label

The OTel-to-Prom translation maps `service.name` resource attribute to Prometheus's `job` label, NOT preserved as `service_name`. Querying Prom as `{service_name="my-app"}` returns nothing. Use `{job="my-app"}`. All other resource attributes land on the `target_info` metric only — join via:

```promql
http_server_request_duration_seconds_count * on(job) group_left(deployment_environment, project) target_info
```

### 10. Eager validation in the factory breaks tests

DON'T do this in the singleton factory:

```js
if (!process.env.COSMOS_CONNECTION_STRING) {
  throw new Error("COSMOS_CONNECTION_STRING not set");
}
```

Test suites mock `CosmosClient` but don't set the env var. The eager `throw` fires at module-load time during `jest`, before mocks can intervene. Match the previous behaviour — pass the env value through to `CosmosClient` as-is, let the SDK handle undefined (it only fails on first network use, which mocks intercept).

### 11. OTel adds cold-start overhead

The OTel bootstrap loads ~190 npm packages and registers monkey-patch hooks across http, https, azure-sdk, etc. Estimated cold-start cost: **500-1000ms per worker spin-up**. Once warm: ~7ms overhead per invocation.

This is the cost of doing business for the visibility you get. Cold start was always slow (Flex Consumption cost) — OTel adds maybe 25-30% to that, and tools you to see the real cause of the rest.

### 12. The "app appears to be unhealthy" warning is OTel-related

When `func azure functionapp publish` ends with "app appears to be unhealthy", check `az functionapp config appsettings list --query "[?starts_with(name,'OTEL')]"` — if empty AND `host.json` has `telemetryMode: OpenTelemetry`, the OTel SDK is hanging on default localhost:4317. Set the OTLP env vars before deploying.

The `deploy-with-tests.sh` script skips the git tag step on this warning, so absent tag + warning = OTel misconfiguration (almost always).

## Project deploy mechanism variations

### Pradam: tag-triggered

Push to `main` doesn't deploy. `git tag vX.Y.Z && git push origin vX.Y.Z` triggers the workflow. Must bump version each time.

### Relmed: release-branch-triggered

Push to `release` branch triggers. To advance: `git checkout release && git merge --ff-only main && git push origin release`.

Has a `npm run test` step in the deploy workflow — if you broke a test, the deploy fails before reaching Azure. Mind this when changing shared code.

### UniVenture: master-paths-triggered

Push to `master` triggers IF paths under `azure_functions/**` changed. No test gate in the workflow. Resource name is **`univenture-flex`** (not `univenture`, which is the old non-flex app — different RG behaviour, deferred).

### PASS: bash script

`bash deploy-azure-functions.sh` from the `passAdmin` root. Gated on a clean working tree — if unrelated React frontend changes are dirty, you need to `git stash` them or commit elsewhere first.

### Webhook-service: bash + `func` CLI

`bash scripts/deploy.sh` from the `webhook-service/` directory inside the coventure10 repo. Uses `func azure functionapp publish`. No test gate.

### Coventure10: bash with test gate + manual tag-on-warning

`bash scripts/deploy-with-tests.sh` from `azure_functions/`. Test gate + auto-tag with `functions-YYYYMMDD-HHMM` IF `func` exits 0. On the "app unhealthy" warning, no tag is created — manually `git tag functions-... && git push --tags` if the deploy actually succeeded (verify with `az functionapp list --query "...state"`).

## SSH cheat sheet (since this came up)

Production server (where Loki/Prom/Tempo run): **`ssh root@www.delosis.com`** (hostname on box: `delosis-ldn`; `new.delosis.com` is a legacy alias that resolves to the same box). NEVER try `john@` or `columbo@` for this box.

Canada server (Coventure10 frontend + API gateway): **`columbo@canada.psytools.com`** — pubkey not present on every machine; usually needs interactive password or pre-shared key.

## Things worth doing next (deferred)

1. **Tail-sampling collector** (memory `1cc0e27e`) — before onboarding any Psytools app. Without it, multi-tenant Psytools traffic will swamp Tempo.
2. **`graphClient` singleton refactor** — same anti-pattern as `getCosmosClient()` was. Each cold worker pays ~1.4s of Microsoft Entra discovery + token + servicePrincipals lookup. Likely a 1-line module-level cache fix per app.
3. **Cosmos query pagination** — `fetchAll()` does N round-trips for large result sets. Either bump `maxItemCount` or paginate from the frontend.
4. **`nginx-otel` on canada.psytools.com** — `/api/*` is a real reverse proxy hot-path for coventure10 (and likely other studies). Would give end-to-end trace correlation from edge to backend. Wait for tail-sampling first.
5. **Audit Pradam/Relmed/UniVenture for other Azure SDK clients constructed per-call** — `@azure/identity`, `@microsoft/microsoft-graph-client`, etc. Same singleton pattern applies.
6. **DEPLOYMENT.md cleanup** — coventure10's is stale (describes old Azure Storage flow; actual is rsync to canada). Probably others have similar drift.

## Anti-patterns surfaced by traces (worth investigating across the fleet)

- **N+1-shaped traces on list endpoints** — the trace shows many small DB calls in a tight cluster. Sometimes legitimate Cosmos pagination, sometimes a real loop. Look at the source code of the handler to distinguish.
- **400s mid-query** — Cosmos returns 400 to partition fan-out queries when partitions have no matching documents. The SDK retries silently. OTel surfaces these as `Status: error` spans; not actually broken but worth knowing they happen.
- **Cold-start prefix before first traced call** — anything over ~500ms of unaccounted time at the top of a trace is cold-worker activity. Cumulative effect of OTel bootstrap + your application's `require` chain + JIT.
