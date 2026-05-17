// @delosis/otel-bootstrap
//
// Required exactly once from a Function App's src/index.js BEFORE any function
// code loads. Sets up a NodeTracerProvider with the OTLP HTTP trace exporter,
// then registers a MINIMAL set of auto-instrumentations covering only what
// Delosis Azure Functions actually use.
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
//   - @azure/functions : worker-side function invocation correlation
//
// Add more here only if a real use case appears. Don't reintroduce
// auto-instrumentations-node "just in case" — the cold-start cost is real
// and measurable.
//
// Logs are intentionally NOT bootstrapped here — the Functions host already
// captures worker stdout (context.log) and ships it via its own OTLP logs
// exporter when telemetryMode=OpenTelemetry. Duplicating the path from the
// worker would produce double log records in Loki.
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
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { detectResources, envDetector, processDetector } = require("@opentelemetry/resources");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");

// Detect resources from env (picks up OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES)
// and process info (pid, runtime version). Skip the heavier auto-detectors that
// auto-instrumentations-node was pulling in.
const resource = detectResources({ detectors: [envDetector, processDetector] });

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
tracerProvider.register();

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
