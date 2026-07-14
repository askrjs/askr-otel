# @askrjs/otel

OpenTelemetry instrumentation for Askr platform operations. The package talks
directly to the optional `@opentelemetry/api` peer and never bundles an SDK,
processor, exporter, vendor backend, or transport.

```ts
import { createTelemetry } from '@askrjs/otel';

const telemetry = createTelemetry({
  logger(level, event, fields) {
    applicationLogger[level]({ event, ...fields });
  },
});

const response = await telemetry.request(
  { requestId, route: '/projects/:projectId' },
  () => telemetry.loader({ route: '/projects/:projectId' }, loadProject),
);
```

Install and configure an OpenTelemetry provider in the application composition
root. Without a provider, the standard API supplies its no-op implementation.

The field contract is allowlisted. Request bodies, submitted values, cookies,
authorization values, tokens, and arbitrary user attributes are never forwarded
to spans or structured logs. Route fields should contain route patterns, not raw
user-controlled URLs.

See [the instrumentation contract](docs/instrumentation.md).
