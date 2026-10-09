# Changelog

## Unreleased

### Breaking changes

- Keep the root factory `createTelemetry` and configuration `TelemetryOptions`.
  Move `Telemetry`, `TelemetryLevel`, `TelemetryOperation`, `TelemetryFields`,
  and `TelemetryLogger` into private ownership. Use
  `ReturnType<typeof createTelemetry>` for an instance, `TelemetryOptions['logger']`
  for a sink, and method parameter types for levels, operations, and fields.
- Drop nonfinite numeric fields, nested values, and values of the wrong field
  type before/after custom sanitization. Status/duration fields require finite
  numbers; identity fields require strings.

### Fixes

- Isolate rejected async loggers without awaiting them or replacing application
  results/errors.
- Preserve exact-once work and its result/error if the tracing provider throws
  before or after the span callback.
- Mark undefined throws/rejections as errors and isolate hostile exception
  inspection so it cannot replace the original failure or skip span cleanup.
