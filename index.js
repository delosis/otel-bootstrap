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
    new HttpInstrumentation(),
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
