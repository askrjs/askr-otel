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
success or error status, record duration, and end exactly once. Raw exceptions
are never exported by default. Configure `sanitizeException` to return a safe
OpenTelemetry exception when exception capture is required; returning
`undefined` keeps it suppressed.

`extract`, `inject`, and `withContext` expose standard OpenTelemetry context
propagation without choosing an HTTP framework. Adapters supply their carrier
getter and setter.

Only these structured fields cross the boundary: request ID, trace ID, route
pattern, action identity, operation identity, numeric status, and duration.
Do not put raw paths, request data, or user identifiers in those identity fields.
Each allowlisted property read is isolated. A throwing getter or Proxy trap is
dropped as unreadable, and an unreadable `then` or `status` property on a work
result does not turn observability into an application failure.
Use `onDroppedField` for development diagnostics when JavaScript callers may
pass misspelled or non-allowlisted fields. The callback receives only the field
key and is isolated from application work if it throws.

`@opentelemetry/api` is a required peer because the package's root module uses
its context, propagation, and tracing primitives. npm resolves the peer during a
normal install; applications install and configure an SDK/provider separately
when they need exported telemetry instead of the API's no-op provider.

## Field and sink ownership

The logger receives every supported severity (`debug`, `info`, `warn`, `error`).
There is no implicit minimum-level filter; apply filtering in the application
sink. Synchronous throws and rejected returned promises are isolated. Async
sinks are observed without delaying application work, so exporter flushing and
shutdown remain application responsibilities.

Nested values, wrong-type fields and nonfinite numbers are dropped before the
sanitizer runs, and its output must retain the field's type. Identity fields are
strings and status/duration fields are finite numbers. Strings are bounded to
`maxFieldLength` Unicode code points (256 by default), with control characters
removed from input. Choose stable operation identities and route patterns to
control cardinality; this package does not invent a cardinality budget for
application request IDs. The allowlist does not identify secrets embedded in
otherwise valid strings: supply `sanitizeField` and `sanitizeException` for
application-specific redaction. `onDroppedField` is a diagnostic for key names
only, owned by the application's diagnostic policy.

If a tracing provider throws before invoking the callback, work runs once
without a span. If it throws after invoking work, the recorded application
result or original error wins and work is never repeated. Exception inspection
is isolated, and thrown/rejected `undefined` remains an application failure.
