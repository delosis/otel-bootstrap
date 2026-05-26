// @delosis/otel-bootstrap
//
// Required exactly once from a Function App's src/index.js BEFORE any function
// code loads. Sets up:
//
//   - a NodeTracerProvider with the OTLP HTTP trace exporter
//   - a LoggerProvider with the OTLP HTTP log exporter
//   - a MINIMAL set of auto-instrumentations covering only what Delosis Azure
//     Functions actually use
//
// Why minimal: the upstream @opentelemetry/auto-instrumentations-node pulls in
// ~40 instrumentations covering every Node ecosystem (express, mongoose, kafka,
// redis, pg, etc.) we'll never touch — they get require()d at worker startup
// and add measurable cold-start cost. This explicit list trims to:
//
//   - http       : outbound HTTPS — covers Cosmos REST, SendGrid, Microsoft
//                  Entra, Graph, any direct fetch/https request
//   - undici     : modern fetch on Node 18+ — Azure SDK uses this
//   - @azure/sdk : semantic spans for Cosmos / Storage / Identity SDK calls
//   - @azure/functions : worker-side function invocation correlation AND
//                        worker-side log emission (see below)
//
// Add more here only if a real use case appears. Don't reintroduce
// auto-instrumentations-node "just in case" — the cold-start cost is real
// and measurable.
//
// Why we MUST bootstrap a LoggerProvider here:
//
//   AzureFunctionsInstrumentation._patch() sets the host capability
//   WorkerOpenTelemetryEnabled=true, which tells the .NET Functions host to
//   STOP emitting Function.<name>.User ILogger entries itself. In exchange,
//   the instrumentation subscribes to azFunc.app.hook.log and forwards every
//   context.log call to api-logs' global Logger via `this.logger.emit(...)`.
//
//   If no LoggerProvider is registered, the global default is NoopLogger and
//   emit() silently discards everything. Combined with the host now staying
//   quiet, the net effect is that every context.log call falls into a black
//   hole — invisible in App Insights AND Loki. (See LESSONS.md.)
//
//   Pin sdk-logs / api-logs / exporter-logs-otlp-http to ^0.209.0 — the
//   same minor that @azure/functions-opentelemetry-instrumentation@0.3.0
//   uses for api-logs. Otherwise npm hoists two different api-logs versions,
//   each with its own version-scoped global, and our provider is invisible
//   to the instrumentation. We learned this the hard way.
//
// All config is environment-driven via standard OTEL_* variables set on the
// Function App. See the Delosis OTel rollout workbook in Hexis memory for
// the full list.

const _bootstrapStart = process.hrtime.bigint();

const { AzureFunctionsInstrumentation } = require("@azure/functions-opentelemetry-instrumentation");
const { createAzureSdkInstrumentation } = require("@azure/opentelemetry-instrumentation-azure-sdk");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { detectResources, envDetector, processDetector } = require("@opentelemetry/resources");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
const { LoggerProvider, BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { logs } = require("@opentelemetry/api-logs");
const { SpanStatusCode } = require("@opentelemetry/api");

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
  processors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
});
logs.setGlobalLoggerProvider(loggerProvider);

registerInstrumentations({
  tracerProvider,
  instrumentations: [
    new HttpInstrumentation({
      // Cosmos SDK control-flow noise suppression.
      //
      // @azure/cosmos v4 uses its own diagnostics layer rather than
      // @azure/core-tracing, so createAzureSdkInstrumentation() above does
      // NOT intercept Cosmos calls — only the raw HTTP layer sees them.
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
    createAzureSdkInstrumentation(),
    new AzureFunctionsInstrumentation(),
  ],
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
span.end(Date.now());
