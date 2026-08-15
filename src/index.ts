import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Exception,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
  type Tracer,
} from "@opentelemetry/api";

/** Severity of a telemetry log line, mirrored from common structured-logging conventions. */
export type TelemetryLevel = "debug" | "info" | "warn" | "error";

/** The set of Askr lifecycle stages that {@link Telemetry} can wrap with a span. */
export type TelemetryOperation =
  | "askr.request"
  | "askr.route.match"
  | "askr.loader"
  | "askr.action"
  | "askr.api.operation"
  | "askr.query.prefetch"
  | "askr.ssr.render"
  | "askr.vite.document";

/**
 * Structured fields attached to a span or log line. Only these known keys are
 * ever sanitized and forwarded; unknown keys on a passed-in object are dropped.
 */
export interface TelemetryFields {
  requestId?: string;
  traceId?: string;
  route?: string;
  action?: string;
  operation?: string;
  status?: number;
  durationMs?: number;
}

/** Callback invoked with each sanitized telemetry log line. */
export type TelemetryLogger = (
  level: TelemetryLevel,
  event: TelemetryOperation,
  fields: Readonly<TelemetryFields>,
) => void;

/**
 * Function-first bridge to the application's installed OpenTelemetry provider.
 * Every method wraps a unit of work in a span (or emits a log line) and never
 * throws on account of tracing/logging failures — application behavior is
 * always isolated from observability failures.
 */
export interface Telemetry {
  /** Wraps `work` in a span for the given `operation`, recording `fields` as attributes. */
  span<T>(operation: TelemetryOperation, fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.request"`. */
  request<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.route.match"`. */
  routeMatch<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.loader"`. */
  loader<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.action"`. */
  action<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.api.operation"`. */
  apiOperation<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.query.prefetch"`. */
  queryPrefetch<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.ssr.render"`. */
  ssrRender<T>(fields: TelemetryFields, work: () => T): T;
  /** Convenience wrapper for {@link Telemetry.span} with operation `"askr.vite.document"`. */
  viteDocument<T>(fields: TelemetryFields, work: () => T): T;
  /** Emits a single sanitized log line without opening a span. */
  log(level: TelemetryLevel, event: TelemetryOperation, fields?: TelemetryFields): void;
  /** Extracts a trace {@link Context} from a carrier (e.g. incoming request headers) using `getter`. */
  extract<Carrier>(carrier: Carrier, getter: TextMapGetter<Carrier>): Context;
  /** Injects the active (or given) {@link Context} into `carrier` using `setter`, returning the carrier. */
  inject<Carrier>(carrier: Carrier, setter: TextMapSetter<Carrier>, value?: Context): Carrier;
  /** Runs `work` with `value` as the active OpenTelemetry context. */
  withContext<T>(value: Context, work: () => T): T;
  /** Returns the trace ID of the currently active span, if any and if valid. */
  traceId(): string | undefined;
}

/** Configuration accepted by {@link createTelemetry}. */
export interface TelemetryOptions {
  /** Name passed to `trace.getTracer`. Defaults to `"@askrjs/otel"`. */
  tracerName?: string;
  /** Version passed to `trace.getTracer`. */
  tracerVersion?: string;
  /** Sink for sanitized log lines. Defaults to a no-op. */
  logger?: TelemetryLogger;
  /** Clock used for span durations. Defaults to `performance.now`. */
  now?: () => number;
  /** Maximum length, in characters, retained for any string field. Defaults to 256. */
  maxFieldLength?: number;
  /** Per-field hook to redact or transform a field before it is logged or attached to a span; return `undefined` to drop it. */
  sanitizeField?: (
    name: keyof TelemetryFields,
    value: string | number,
  ) => string | number | undefined;
  /** Exceptions are not exported unless this hook returns a sanitized value. */
  sanitizeException?: (error: Error) => Exception | undefined;
}

const FIELD_NAMES = [
  "requestId",
  "traceId",
  "route",
  "action",
  "operation",
  "status",
  "durationMs",
] as const;

function readProperty(source: unknown, key: PropertyKey): unknown {
  if ((typeof source !== "object" && typeof source !== "function") || source === null) {
    return undefined;
  }

  try {
    return Reflect.get(source, key);
  } catch {
    return undefined;
  }
}

function sanitizeFields(
  fields: TelemetryFields,
  maxLength = 256,
  sanitizer?: TelemetryOptions["sanitizeField"],
): TelemetryFields {
  const safe: TelemetryFields = {};

  for (const key of FIELD_NAMES) {
    const value = readProperty(fields, key);
    if (typeof value === "string" || typeof value === "number") {
      let bounded: string | number = value;
      if (typeof value === "string") {
        let result = "";
        for (const character of value) {
          const code = character.codePointAt(0)!;
          if (code > 31 && code !== 127) result += character;
          if (result.length >= maxLength) break;
        }
        bounded = result.slice(0, maxLength);
      }
      let sanitized: string | number | undefined;
      try {
        sanitized = sanitizer ? sanitizer(key, bounded) : bounded;
      } catch {
        continue;
      }
      if (typeof sanitized === "string" || typeof sanitized === "number")
        (safe as Record<string, unknown>)[key] =
          typeof sanitized === "string" ? sanitized.slice(0, maxLength) : sanitized;
    }
  }

  return safe;
}

function spanAttributes(fields: TelemetryFields): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      attributes[`askr.${key}`] = value;
    }
  }
  return attributes;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof readProperty(value, "then") === "function";
}

function responseStatus(value: unknown): number | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }

  const status = readProperty(value, "status");
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function activeTraceId(): string | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) {
    return undefined;
  }
  return spanContext.traceId;
}

/**
 * Creates a function-first bridge to the application's installed OpenTelemetry
 * provider. This package never installs an SDK, processor, backend, or exporter.
 */
export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const maxFieldLength = options.maxFieldLength ?? 256;
  if (!Number.isInteger(maxFieldLength) || maxFieldLength <= 0)
    throw new TypeError("Telemetry maxFieldLength must be a positive integer.");
  const tracer: Tracer = trace.getTracer(
    options.tracerName ?? "@askrjs/otel",
    options.tracerVersion,
  );
  const logger = options.logger ?? (() => undefined);
  const now = options.now ?? (() => performance.now());
  const emit = (
    level: TelemetryLevel,
    event: TelemetryOperation,
    fields: Readonly<TelemetryFields>,
  ): void => {
    try {
      logger(level, event, fields);
    } catch {
      // Application observers are isolated from instrumented work.
    }
  };
  const clock = (): number => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const observe = (work: () => void): void => {
    try {
      work();
    } catch {
      // OpenTelemetry observers must not alter application behavior.
    }
  };

  const log = (
    level: TelemetryLevel,
    event: TelemetryOperation,
    fields: TelemetryFields = {},
  ): void => {
    emit(
      level,
      event,
      Object.freeze(sanitizeFields(fields, maxFieldLength, options.sanitizeField)),
    );
  };

  const span = <T>(
    operation: TelemetryOperation,
    inputFields: TelemetryFields,
    work: () => T,
  ): T => {
    const fields = sanitizeFields(inputFields, maxFieldLength, options.sanitizeField);
    return tracer.startActiveSpan(
      operation,
      { kind: SpanKind.INTERNAL, attributes: spanAttributes(fields) },
      (activeSpan: Span) => {
        const started = clock();
        let finished = false;
        const finish = (result?: unknown, error?: unknown): void => {
          if (finished) return;
          finished = true;
          const durationMs = Math.max(0, clock() - started);
          const status = responseStatus(result) ?? fields.status;
          const failed = error !== undefined || (status !== undefined && status >= 500);
          observe(() => activeSpan.setAttribute("askr.durationMs", durationMs));

          if (status !== undefined) {
            observe(() => activeSpan.setAttribute("askr.status", status));
          }

          if (failed) {
            observe(() => activeSpan.setStatus({ code: SpanStatusCode.ERROR }));
            if (error instanceof Error && options.sanitizeException) {
              observe(() => {
                const sanitized = options.sanitizeException?.(error);
                if (sanitized !== undefined) activeSpan.recordException(sanitized);
              });
            }
          } else {
            observe(() => activeSpan.setStatus({ code: SpanStatusCode.OK }));
          }

          try {
            let observedTraceId = fields.traceId;
            observe(() => {
              const spanContext = activeSpan.spanContext();
              if (trace.isSpanContextValid(spanContext)) observedTraceId = spanContext.traceId;
            });
            log(failed ? "error" : "info", operation, {
              ...fields,
              status,
              traceId: observedTraceId,
              durationMs,
            });
          } finally {
            observe(() => activeSpan.end());
          }
        };

        try {
          const result = work();
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then(
              (value) => {
                finish(value);
                return value;
              },
              (error: unknown) => {
                finish(undefined, error);
                throw error;
              },
            ) as T;
          }

          finish(result);
          return result;
        } catch (error) {
          finish(undefined, error);
          throw error;
        }
      },
    );
  };

  const bind =
    (operation: TelemetryOperation) =>
    <T>(fields: TelemetryFields, work: () => T): T =>
      span(operation, fields, work);

  return Object.freeze({
    span,
    request: bind("askr.request"),
    routeMatch: bind("askr.route.match"),
    loader: bind("askr.loader"),
    action: bind("askr.action"),
    apiOperation: bind("askr.api.operation"),
    queryPrefetch: bind("askr.query.prefetch"),
    ssrRender: bind("askr.ssr.render"),
    viteDocument: bind("askr.vite.document"),
    log,
    extract: <Carrier>(carrier: Carrier, getter: TextMapGetter<Carrier>): Context =>
      propagation.extract(context.active(), carrier, getter),
    inject: <Carrier>(
      carrier: Carrier,
      setter: TextMapSetter<Carrier>,
      value: Context = context.active(),
    ): Carrier => {
      propagation.inject(value, carrier, setter);
      return carrier;
    },
    withContext: <T>(value: Context, work: () => T): T => context.with(value, work),
    traceId: activeTraceId,
  });
}
