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
// Function App. See the Delosis OTel rollout workbook memory for the full
// list (signal-specific log endpoint, generic trace endpoint, basic-auth
// header with W3C-Baggage percent-encoding, etc.).

const { AzureFunctionsInstrumentation } = require("@azure/functions-opentelemetry-instrumentation");
const { createAzureSdkInstrumentation } = require("@azure/opentelemetry-instrumentation-azure-sdk");
const { getNodeAutoInstrumentations, getResourceDetectors } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { detectResourcesSync } = require("@opentelemetry/resources");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");

const resource = detectResourcesSync({ detectors: getResourceDetectors() });

const tracerProvider = new NodeTracerProvider({ resource });
tracerProvider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
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
