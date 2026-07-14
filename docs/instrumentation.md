# Instrumentation contract

`createTelemetry()` exposes one function for each platform boundary:

- `request`
- `routeMatch`
- `loader`
- `action`
- `apiOperation`
- `queryPrefetch`
- `ssrRender`
- `viteDocument`

Every function preserves synchronous work as synchronous work and keeps promise
work asynchronous. Nested calls use the active OpenTelemetry context, record
success or error status, capture exceptions, record duration, and end exactly
once.

`extract`, `inject`, and `withContext` expose standard OpenTelemetry context
propagation without choosing an HTTP framework. Adapters supply their carrier
getter and setter.

Only these structured fields cross the boundary: request ID, trace ID, route
pattern, action identity, operation identity, numeric status, and duration.
Do not put raw paths, request data, or user identifiers in those identity fields.
