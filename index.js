// @delosis/otel-bootstrap
//
// Required exactly once from a Function App's src/index.js BEFORE any function
// code loads. Sets up:
//
//   - a NodeTracerProvider with the OTLP HTTP trace exporter
//   - a LoggerProvider with the OTLP HTTP log exporter
//   - a MINIMAL set of auto-instrumentations covering only what Delosis Azure
//     Functions actually use
//   - the two Azure Functions worker hooks that used to come from
//     @azure/functions-opentelemetry-instrumentation (see below)
//
// Why minimal: the upstream @opentelemetry/auto-instrumentations-node pulls in
// ~40 instrumentations covering every Node ecosystem (express, mongoose, kafka,
// redis, pg, etc.) we'll never touch — they get require()d at worker startup
// and add measurable cold-start cost. This explicit list trims to:
//
//   - http       : outbound HTTPS via Node http/https — covers @azure/cosmos
//                  (core-rest-pipeline), node-fetch v2, axios, SendGrid, Graph
//   - undici     : global fetch() on Node 18+ — used directly across the fleet
//                  for Montreal / Shlink calls. diagnostics_channel based,
//                  no require hook.
//
// v2.0.0 — what was removed and why (measured 2026-09-21, see LESSONS.md #13):
//
//   - @azure/opentelemetry-instrumentation-azure-sdk: hooks @azure/core-tracing,
//     which @azure/cosmos v4 does not use (it has its own diagnostics layer).
//     Produced zero spans on any Delosis service in 72h. Pure load cost.
//   - @azure/functions-opentelemetry-instrumentation: Microsoft's latest (0.3.0)
//     still depends on @opentelemetry/instrumentation ^0.52 and api-logs ^0.209,
//     forcing nested duplicate copies of both (four api-logs versions in one
//     prod tree) and pinning the whole fleet to an old OTel chain. Its useful
//     content is ~30 lines of public @azure/functions hook calls, reproduced
//     below without the InstrumentationBase wrapper. It creates no spans — the
//     per-invocation server spans and the "init" span are the .NET host's.
//
//   Net: one consistent OTel version set, no pnpm overrides needed downstream,
//   ~two-thirds fewer files under @opentelemetry.
//
// Why we MUST bootstrap a LoggerProvider here:
//
//   Setting the host capability WorkerOpenTelemetryEnabled=true tells the .NET
//   Functions host to STOP emitting Function.<name>.User ILogger entries itself.
//   In exchange we subscribe to app.hook.log and forward every context.log call
//   to api-logs' global Logger. If no LoggerProvider is registered, the global
//   default is NoopLogger and emit() silently discards everything. Combined with
//   the host now staying quiet, every context.log call falls into a black hole —
//   invisible in App Insights AND Loki. (See LESSONS.md #6.)
//
// All config is environment-driven via standard OTEL_* variables set on the
// Function App. See the Delosis OTel rollout workbook in Hexis memory for
// the full list.

const _bootstrapStart = process.hrtime.bigint();

const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { detectResources, envDetector, processDetector } = require("@opentelemetry/resources");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
const { LoggerProvider, BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
const { context: otelContext, propagation, SpanStatusCode } = require("@opentelemetry/api");

// Cosmos-host hostname pattern. @azure/cosmos v4 issues HTTP requests
// against {account}.documents.azure.com (and {account}-{region}.documents.azure.com
// for multi-region accounts). Both shapes end in .documents.azure.com.
const COSMOS_HOST_RE = /\.documents\.azure\.com$/i;

// Detect resources from env (picks up OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES)
// and process info (pid, runtime version). Skip the heavier auto-detectors that
// auto-instrumentations-node was pulling in.
const resource = detectResources({ detectors: [envDetector, processDetector] });

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
tracerProvider.register();

const loggerProvider = new LoggerProvider({
  resource,
  // sdk-logs >=0.222: options object, not a positional exporter (silent no-op
  // otherwise — the processor's _exporter is undefined and every export throws
  // inside a promise nobody awaits).
  processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
});
logs.setGlobalLoggerProvider(loggerProvider);

registerInstrumentations({
  tracerProvider,
  instrumentations: [
    new HttpInstrumentation({
      // Drop the Cosmos SDK's background account-metadata read. @azure/cosmos'
      // GlobalEndpointManager re-reads GET https://<account>.documents.azure.com/
      // every 300000 ms. The module-scope client arms that timer during
      // whichever invocation first uses it, so every refresh inherits that
      // invocation's trace context and parents under it — a 200 ms timer run
      // shows as a 20-minute trace, poisoning spanmetrics p99 for timers.
      // Path "/" on a documents.azure.com host is only ever this read (the
      // warmup's getDatabaseAccount() is the same call); nothing useful lost.
      ignoreOutgoingRequestHook: (request) => {
        const host = String(
          request.host || request.hostname || (request.getHeader && request.getHeader("host")) || ""
        ).split(":")[0];
        const path = String(request.path || "/").split("?")[0];
        return COSMOS_HOST_RE.test(host) && path === "/";
      },
      // Cosmos SDK control-flow noise suppression.
      //
      // Cross-partition queries (ORDER BY, fan-out reads, paginated
      // continuations) routinely receive 4xx responses from individual
      // partitions as part of normal SDK control flow — partition map
      // staleness, empty-partition rejections, continuation-token
      // refreshes. The SDK absorbs these and retries silently; the app
      // never sees them. But @opentelemetry/instrumentation-http marks
      // every >=400 response as ERROR span status by default, which then
      // inflates spanmetrics err% for Cosmos POSTs to ~25–30% on healthy
      // services. Documented in LESSONS.md ("400s mid-query") as known.
      //
      // Downgrade to OK only for 4xx from a Cosmos host. 5xx is left
      // ERROR — those WOULD indicate real Cosmos service issues we
      // want surfaced.
      applyCustomAttributesOnSpan: (span, request, response) => {
        if (!response || typeof response.statusCode !== "number") return;
        if (response.statusCode < 400 || response.statusCode >= 500) return;
        const host = String(
          request.host || (request.getHeader && request.getHeader("host")) || ""
        ).split(":")[0];
        if (COSMOS_HOST_RE.test(host)) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
      },
    }),
    new UndiciInstrumentation(),
  ],
});

// ---------------------------------------------------------------------------
// Azure Functions worker hooks (replaces @azure/functions-opentelemetry-instrumentation)
//
// @azure/functions is a peer dependency: with a hoisted node_modules this
// resolves to the SAME module instance the app registers its functions on,
// which is required — the hook registry is module-scoped.
// ---------------------------------------------------------------------------
const azFunc = require("@azure/functions");

// Tell the host we emit function logs ourselves (so it doesn't duplicate).
// Must run during app load, before the worker answers FunctionsMetadataRequest;
// that is guaranteed by this file being the first line of src/index.js.
azFunc.app.setup({ capabilities: { WorkerOpenTelemetryEnabled: true } });

const SEVERITY = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  information: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  critical: SeverityNumber.FATAL,
};

const logger = logs.getLogger("@delosis/otel-bootstrap");

// Forward context.log (category "user") and anything the worker says at
// warning or above. Drop worker system chatter at debug/information —
// "Loading entry point file", "Worker … received FunctionInvocationRequest",
// "FunctionLoadRequest" — which was ~70% of the Node-side log volume in Loki
// and carries nothing the .NET host doesn't already log.
azFunc.app.hook.log((ctx) => {
  if (ctx.category === "system" && (ctx.level === "debug" || ctx.level === "information")) return;
  logger.emit({
    body: ctx.message,
    severityNumber: SEVERITY[ctx.level] ?? SeverityNumber.UNSPECIFIED,
    severityText: ctx.level,
    attributes: { CategoryName: ctx.category },
  });
});

// Join the host's trace: bind the handler to the W3C context the host passed
// in, so worker-side client spans (Cosmos, fetch) parent under the invocation.
azFunc.app.hook.preInvocation((ctx) => {
  const tc = ctx.invocationContext.traceContext;
  if (!tc) return;
  ctx.functionHandler = otelContext.bind(
    propagation.extract(otelContext.active(), {
      traceparent: tc.traceParent,
      tracestate: tc.traceState,
    }),
    ctx.functionHandler
  );
});

// Self-timing — emitted as a span on the just-registered tracer so it lands
// in Tempo (look under service.name=<your app>, name="otel-bootstrap").
// console.log from this file is too early in worker startup to be captured
// by the Functions host stdout pipeline, so the span path is the only one
// that actually surfaces the timing.
const _bootstrapEnd = process.hrtime.bigint();
const _bootstrapMs = Number(_bootstrapEnd - _bootstrapStart) / 1e6;
const _startTimeMs = Date.now() - _bootstrapMs;
const tracer = tracerProvider.getTracer("@delosis/otel-bootstrap");
const span = tracer.startSpan("otel-bootstrap", { startTime: _startTimeMs });
span.setAttribute("bootstrap.duration_ms", _bootstrapMs);
span.setAttribute("bootstrap.node_version", process.version);
span.setAttribute("bootstrap.pid", process.pid);
span.setAttribute("bootstrap.version", require("./package.json").version);
span.end(Date.now());
