// @delosis/otel-bootstrap
//
// Required exactly once from a Function App's src/index.js BEFORE any function
// code loads. Sets up a NodeTracerProvider with the OTLP HTTP trace exporter,
// then registers auto-instrumentations so outbound calls (Cosmos, SendGrid,
// any other http/https client work) produce child spans correctly parented
// under the host's per-invocation request span.
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
const { getNodeAutoInstrumentations, getResourceDetectors } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { detectResources } = require("@opentelemetry/resources");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");

const resource = detectResources({ detectors: getResourceDetectors() });

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
tracerProvider.register();

registerInstrumentations({
  tracerProvider,
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs is off by default in auto-instrumentations-node; leaving it that
      // way (otherwise every file read becomes a span — pure noise).
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
    createAzureSdkInstrumentation(),
    new AzureFunctionsInstrumentation(),
  ],
});

// Self-timing — logged to stdout, captured by the Functions host and
// shipped to Loki (look for log lines tagged scope_name="@delosis/otel-bootstrap").
// This is the bootstrap's own load + register cost; useful for spotting whether
// OTel itself is responsible for slow cold starts vs. legitimate Azure work.
const _bootstrapMs = Number(process.hrtime.bigint() - _bootstrapStart) / 1e6;
console.log(
  `[@delosis/otel-bootstrap] initialized in ${_bootstrapMs.toFixed(1)}ms ` +
    `(service.name=${process.env.OTEL_SERVICE_NAME || "?"}, ` +
    `node=${process.version}, pid=${process.pid})`
);
