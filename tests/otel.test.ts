import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type ContextManager,
  type Link,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TimeInput,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTelemetry, type TelemetryFields } from '../src/index';

type CapturedSpan = {
  name: string;
  parentSpanId?: string;
  context: SpanContext;
  attributes: Record<string, unknown>;
  status?: SpanStatus;
  exceptions: unknown[];
  ended: number;
};

const captured: CapturedSpan[] = [];
let nextSpan = 1;

function validSpanContext(): SpanContext {
  const suffix = String(nextSpan++).padStart(16, '0');
  return {
    traceId: '10000000000000000000000000000001',
    spanId: suffix,
    traceFlags: 1,
  };
}

function createSpan(name: string, options: SpanOptions, parent: Context): Span {
  const record: CapturedSpan = {
    name,
    parentSpanId: trace.getSpanContext(parent)?.spanId,
    context: validSpanContext(),
    attributes: { ...options.attributes },
    exceptions: [],
    ended: 0,
  };
  captured.push(record);

  return {
    spanContext: () => record.context,
    setAttribute(key: string, value: unknown) {
      record.attributes[key] = value;
      return this;
    },
    setAttributes(attributes: Attributes) {
      Object.assign(record.attributes, attributes);
      return this;
    },
    addEvent() {
      return this;
    },
    addLink(_link: Link) {
      return this;
    },
    addLinks(_links: Link[]) {
      return this;
    },
    setStatus(status: SpanStatus) {
      record.status = status;
      return this;
    },
    updateName(nextName: string) {
      record.name = nextName;
      return this;
    },
    end(_endTime?: TimeInput) {
      record.ended += 1;
    },
    isRecording: () => true,
    recordException(error: unknown) {
      record.exceptions.push(error);
    },
  };
}

function createTracer(): Tracer {
  const startSpan = (name: string, options: SpanOptions = {}, parent = context.active()) =>
    createSpan(name, options, parent);

  return {
    startSpan,
    startActiveSpan<T>(
      name: string,
      optionsOrWork: SpanOptions | ((span: Span) => T),
      contextOrWork?: Context | ((span: Span) => T),
      possibleWork?: (span: Span) => T,
    ): T {
      const options = typeof optionsOrWork === 'function' ? {} : optionsOrWork;
      const parent =
        contextOrWork && typeof contextOrWork !== 'function'
          ? contextOrWork
          : context.active();
      const work =
        typeof optionsOrWork === 'function'
          ? optionsOrWork
          : typeof contextOrWork === 'function'
            ? contextOrWork
            : possibleWork!;
      const span = startSpan(name, options, parent);
      return context.with(trace.setSpan(parent, span), () => work(span));
    },
  } as Tracer;
}

beforeAll(() => {
  let activeContext = ROOT_CONTEXT;
  const contextManager: ContextManager = {
    active: () => activeContext,
    with: <A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      value: Context,
      work: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> => {
      const previous = activeContext;
      activeContext = value;
      try {
        return Reflect.apply(work, thisArg, args) as ReturnType<F>;
      } finally {
        activeContext = previous;
      }
    },
    bind: (_value, target) => target,
    enable() {
      return this;
    },
    disable() {
      activeContext = ROOT_CONTEXT;
      return this;
    },
  };
  context.setGlobalContextManager(contextManager);

  const tracer = createTracer();
  trace.setGlobalTracerProvider({ getTracer: () => tracer } as TracerProvider);
  propagation.setGlobalPropagator({
    fields: () => ['x-trace-id'],
    inject(value, carrier, setter) {
      const spanContext = trace.getSpanContext(value);
      if (spanContext) setter.set(carrier, 'x-trace-id', spanContext.traceId);
    },
    extract(value, carrier, getter) {
      const traceId = getter.get(carrier, 'x-trace-id');
      const normalized = Array.isArray(traceId) ? traceId[0] : traceId;
      if (!normalized) return value;
      return trace.setSpanContext(value, {
        traceId: normalized,
        spanId: '2000000000000001',
        traceFlags: 1,
        isRemote: true,
      });
    },
  });
});

describe('createTelemetry', () => {
  it('should preserve nested span identity and record status and duration', async () => {
    captured.length = 0;
    let time = 10;
    const logs: Array<{ event: string; fields: Readonly<TelemetryFields> }> = [];
    const telemetry = createTelemetry({
      now: () => time++,
      logger: (_level, event, fields) => logs.push({ event, fields }),
    });

    const result = await telemetry.request({ requestId: 'req-1', route: '/items/:id' }, () =>
      telemetry.loader({ route: '/items/:id' }, async () => 'loaded'),
    );

    expect(result).toBe('loaded');
    expect(captured.map((entry) => entry.name)).toEqual(['askr.request', 'askr.loader']);
    expect(captured[1].parentSpanId).toBe(captured[0].context.spanId);
    expect(captured.every((entry) => entry.status?.code === SpanStatusCode.OK)).toBe(true);
    expect(captured.every((entry) => entry.ended === 1)).toBe(true);
    expect(logs.every((entry) => entry.fields.traceId === captured[0].context.traceId)).toBe(true);
    expect(logs.every((entry) => typeof entry.fields.durationMs === 'number')).toBe(true);
  });

  it('should record rejected operations without changing their rejection', async () => {
    captured.length = 0;
    const telemetry = createTelemetry();
    const failure = new Error('loader failed');

    await expect(
      telemetry.loader({ route: '/failure' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(captured[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(captured[0].exceptions).toEqual([failure]);
    expect(captured[0].ended).toBe(1);
  });

  it('should preserve synchronous operations as synchronous values', () => {
    const telemetry = createTelemetry();
    expect(telemetry.ssrRender({ status: 200 }, () => 'html')).toBe('html');
  });

  it('should isolate logger failures and still end each span exactly once', async () => {
    captured.length = 0;
    const telemetry = createTelemetry({
      logger: () => {
        throw new Error('observer failed');
      },
    });

    expect(telemetry.apiOperation({}, () => 'ok')).toBe('ok');
    const failure = new Error('application failed');
    await expect(telemetry.loader({}, async () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(captured).toHaveLength(2);
    expect(captured.every((entry) => entry.ended === 1)).toBe(true);
  });

  it('should derive HTTP status from response-like results without logging response data', async () => {
    captured.length = 0;
    const logs: Array<{
      level: string;
      fields: Readonly<TelemetryFields>;
    }> = [];
    const telemetry = createTelemetry({
      logger: (level, _event, fields) => logs.push({ level, fields }),
    });

    const unavailable = await telemetry.request({ requestId: 'req-503' }, async () => ({
      status: 503,
      body: 'sensitive',
    }));
    const notFound = telemetry.apiOperation({ operation: 'inventory.read' }, () => ({
      status: 404,
      body: 'not logged',
    }));

    expect(unavailable.status).toBe(503);
    expect(notFound.status).toBe(404);
    expect(captured[0].attributes['askr.status']).toBe(503);
    expect(captured[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(captured[1].attributes['askr.status']).toBe(404);
    expect(captured[1].status?.code).toBe(SpanStatusCode.OK);
    expect(logs).toEqual([
      {
        level: 'error',
        fields: expect.objectContaining({ requestId: 'req-503', status: 503 }),
      },
      {
        level: 'info',
        fields: expect.objectContaining({ operation: 'inventory.read', status: 404 }),
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('sensitive');
    expect(JSON.stringify(logs)).not.toContain('not logged');
  });

  it('should allowlist structured fields and drop sensitive request data', () => {
    let written: Readonly<TelemetryFields> | undefined;
    const telemetry = createTelemetry({
      logger: (_level, _event, fields) => {
        written = fields;
      },
    });

    telemetry.log('info', 'askr.action', {
      requestId: 'req-2',
      action: 'save-profile',
      body: { email: 'person@example.com' },
      cookie: 'session=secret',
      authorization: 'Bearer secret',
      token: 'secret',
    } as TelemetryFields);

    expect(written).toEqual({ requestId: 'req-2', action: 'save-profile' });
    expect(JSON.stringify(written)).not.toContain('secret');
    expect(Object.isFrozen(written)).toBe(true);
  });

  it('should inject and extract trace identity through caller-owned carriers', () => {
    const telemetry = createTelemetry();
    const getter = {
      keys: (carrier: Record<string, string>) => Object.keys(carrier),
      get: (carrier: Record<string, string>, key: string) => carrier[key],
    };
    const setter = {
      set: (carrier: Record<string, string>, key: string, value: string) => {
        carrier[key] = value;
      },
    };
    const incoming = telemetry.extract(
      { 'x-trace-id': '30000000000000000000000000000003' },
      getter,
    );
    const carrier: Record<string, string> = {};

    telemetry.withContext(incoming, () => {
      expect(telemetry.traceId()).toBe('30000000000000000000000000000003');
      telemetry.inject(carrier, setter);
    });

    expect(carrier).toEqual({ 'x-trace-id': '30000000000000000000000000000003' });
    expect(trace.getSpanContext(ROOT_CONTEXT)).toBeUndefined();
  });
});
