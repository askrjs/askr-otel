import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
  type Tracer,
} from '@opentelemetry/api';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';
export type TelemetryOperation =
  | 'askr.request'
  | 'askr.route.match'
  | 'askr.loader'
  | 'askr.action'
  | 'askr.api.operation'
  | 'askr.query.prefetch'
  | 'askr.ssr.render'
  | 'askr.vite.document';

export interface TelemetryFields {
  requestId?: string;
  traceId?: string;
  route?: string;
  action?: string;
  operation?: string;
  status?: number;
  durationMs?: number;
}

export type TelemetryLogger = (
  level: TelemetryLevel,
  event: TelemetryOperation,
  fields: Readonly<TelemetryFields>,
) => void;

export interface Telemetry {
  span<T>(
    operation: TelemetryOperation,
    fields: TelemetryFields,
    work: () => T,
  ): T;
  request<T>(fields: TelemetryFields, work: () => T): T;
  routeMatch<T>(fields: TelemetryFields, work: () => T): T;
  loader<T>(fields: TelemetryFields, work: () => T): T;
  action<T>(fields: TelemetryFields, work: () => T): T;
  apiOperation<T>(fields: TelemetryFields, work: () => T): T;
  queryPrefetch<T>(fields: TelemetryFields, work: () => T): T;
  ssrRender<T>(fields: TelemetryFields, work: () => T): T;
  viteDocument<T>(fields: TelemetryFields, work: () => T): T;
  log(
    level: TelemetryLevel,
    event: TelemetryOperation,
    fields?: TelemetryFields,
  ): void;
  extract<Carrier>(carrier: Carrier, getter: TextMapGetter<Carrier>): Context;
  inject<Carrier>(carrier: Carrier, setter: TextMapSetter<Carrier>, value?: Context): Carrier;
  withContext<T>(value: Context, work: () => T): T;
  traceId(): string | undefined;
}

export interface TelemetryOptions {
  tracerName?: string;
  tracerVersion?: string;
  logger?: TelemetryLogger;
  now?: () => number;
}

const FIELD_NAMES = [
  'requestId',
  'traceId',
  'route',
  'action',
  'operation',
  'status',
  'durationMs',
] as const;

function sanitizeFields(fields: TelemetryFields): TelemetryFields {
  const source = fields as Record<string, unknown>;
  const safe: TelemetryFields = {};

  for (const key of FIELD_NAMES) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') {
      (safe as Record<string, unknown>)[key] = value;
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
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function responseStatus(value: unknown): number | undefined {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return undefined;
  }

  try {
    const status = (value as { status?: unknown }).status;
    return typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
      ? status
      : undefined;
  } catch {
    return undefined;
  }
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
  const tracer: Tracer = trace.getTracer(
    options.tracerName ?? '@askrjs/otel',
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
    emit(level, event, Object.freeze(sanitizeFields(fields)));
  };

  const span = <T>(
    operation: TelemetryOperation,
    inputFields: TelemetryFields,
    work: () => T,
  ): T => {
    const fields = sanitizeFields(inputFields);
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
          observe(() => activeSpan.setAttribute('askr.durationMs', durationMs));

          if (status !== undefined) {
            observe(() => activeSpan.setAttribute('askr.status', status));
          }

          if (failed) {
            observe(() => activeSpan.setStatus({ code: SpanStatusCode.ERROR }));
            if (error instanceof Error) {
              observe(() => activeSpan.recordException(error));
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
            log(failed ? 'error' : 'info', operation, {
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
    request: bind('askr.request'),
    routeMatch: bind('askr.route.match'),
    loader: bind('askr.loader'),
    action: bind('askr.action'),
    apiOperation: bind('askr.api.operation'),
    queryPrefetch: bind('askr.query.prefetch'),
    ssrRender: bind('askr.ssr.render'),
    viteDocument: bind('askr.vite.document'),
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
