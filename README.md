# @askrjs/otel

[![CI](https://github.com/askrjs/askr-otel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/askrjs/askr-otel/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40askrjs%2Fotel.svg)](https://www.npmjs.com/package/@askrjs/otel)

OpenTelemetry instrumentation for Askr platform operations. The package talks
directly to the required `@opentelemetry/api` peer and never bundles an SDK,
processor, exporter, vendor backend, or transport.

```sh
npm install @askrjs/otel @opentelemetry/api
```

Modern npm installs the required peer automatically. Declaring it explicitly in
an application keeps the telemetry composition root and version policy visible.

```ts
import { createTelemetry } from "@askrjs/otel";

const telemetry = createTelemetry({
  logger(level, event, fields) {
    applicationLogger[level]({ event, ...fields });
  },
});

const response = await telemetry.request({ requestId, route: "/projects/:projectId" }, () =>
  telemetry.loader({ route: "/projects/:projectId" }, loadProject),
);
```

Install and configure an OpenTelemetry provider in the application composition
root. Without a provider, the standard API supplies its no-op implementation.

The field contract is allowlisted. Request bodies, submitted values, cookies,
authorization values, tokens, and arbitrary user attributes are never forwarded
to spans or structured logs. Route fields should contain route patterns, not raw
user-controlled URLs. Unreadable allowlisted properties, including throwing
getters and Proxy traps, are treated as absent so instrumentation cannot crash
application work.

See [the instrumentation contract](docs/instrumentation.md).
