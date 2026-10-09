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
} from "@opentelemetry/api";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTelemetry } from "../src/index";
type TelemetryFields = Parameters<ReturnType<typeof createTelemetry>["request"]>[0];

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
  const suffix = String(nextSpan++).padStart(16, "0");
  return {
    traceId: "10000000000000000000000000000001",
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
      const options = typeof optionsOrWork === "function" ? {} : optionsOrWork;
      const parent =
        contextOrWork && typeof contextOrWork !== "function" ? contextOrWork : context.active();
      const work =
        typeof optionsOrWork === "function"
          ? optionsOrWork
          : typeof contextOrWork === "function"
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
    fields: () => ["x-trace-id"],
    inject(value, carrier, setter) {
      const spanContext = trace.getSpanContext(value);
      if (spanContext) setter.set(carrier, "x-trace-id", spanContext.traceId);
    },
    extract(value, carrier, getter) {
      const traceId = getter.get(carrier, "x-trace-id");
      const normalized = Array.isArray(traceId) ? traceId[0] : traceId;
      if (!normalized) return value;
      return trace.setSpanContext(value, {
        traceId: normalized,
        spanId: "2000000000000001",
        traceFlags: 1,
        isRemote: true,
      });
    },
  });
});

describe("createTelemetry", () => {
  it("should preserve nested span identity and record status and duration", async () => {
    captured.length = 0;
    let time = 10;
    const logs: Array<{ event: string; fields: Readonly<TelemetryFields> }> = [];
    const telemetry = createTelemetry({
      now: () => time++,
      logger: (_level, event, fields) => logs.push({ event, fields }),
    });

    const result = await telemetry.request({ requestId: "req-1", route: "/items/:id" }, () =>
      telemetry.loader({ route: "/items/:id" }, async () => "loaded"),
    );

    expect(result).toBe("loaded");
    expect(captured.map((entry) => entry.name)).toEqual(["askr.request", "askr.loader"]);
    expect(captured[1].parentSpanId).toBe(captured[0].context.spanId);
    expect(captured.every((entry) => entry.status?.code === SpanStatusCode.OK)).toBe(true);
    expect(captured.every((entry) => entry.ended === 1)).toBe(true);
    expect(logs.every((entry) => entry.fields.traceId === captured[0].context.traceId)).toBe(true);
    expect(logs.every((entry) => typeof entry.fields.durationMs === "number")).toBe(true);
  });

  it("should isolate overlapping nested spans, attributes, and sanitized exceptions", async () => {
    captured.length = 0;
    const telemetry = createTelemetry({
      sanitizeException: (error) => ({ name: "Error", message: error.message }),
    });
    const failures = Array.from({ length: 12 }, (_, index) => {
      const requestId = `req-${index}`;
      const route = `/route-${index}`;
      return telemetry.request({ requestId }, () =>
        telemetry.loader({ route }, async () => {
          await Promise.resolve();
          throw new Error(`safe-${index}`);
        }),
      );
    });

    await expect(Promise.allSettled(failures)).resolves.toHaveLength(12);
    const requests = captured.filter((entry) => entry.name === "askr.request");
    const loaders = captured.filter((entry) => entry.name === "askr.loader");
    expect(requests).toHaveLength(12);
    expect(loaders).toHaveLength(12);
    for (let index = 0; index < 12; index += 1) {
      expect(requests[index].attributes).toMatchObject({ "askr.requestId": `req-${index}` });
      expect(loaders[index].attributes).toMatchObject({ "askr.route": `/route-${index}` });
      expect(loaders[index].parentSpanId).toBe(requests[index].context.spanId);
      expect(loaders[index].exceptions).toEqual([{ name: "Error", message: `safe-${index}` }]);
    }
  });

  it("should not export raw rejected exceptions without an explicit sanitizer", async () => {
    captured.length = 0;
    const telemetry = createTelemetry();
    const failure = new Error("loader failed");

    await expect(
      telemetry.loader({ route: "/failure" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(captured[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(captured[0].exceptions).toEqual([]);
    expect(captured[0].ended).toBe(1);
  });

  it("should cap and redact fields and export only sanitized exceptions", async () => {
    captured.length = 0;
    const logs: TelemetryFields[] = [];
    const telemetry = createTelemetry({
      maxFieldLength: 8,
      sanitizeField: (name, value) => (name === "requestId" ? undefined : value),
      sanitizeException: () => ({ name: "Error", message: "operation failed" }),
      logger: (_level, _event, fields) => logs.push(fields),
    });
    await expect(
      telemetry.loader({ requestId: "secret", route: "/items/{id}\nprivate" }, async () => {
        throw new Error("database password");
      }),
    ).rejects.toThrow("database password");
    expect(captured[0].attributes["askr.requestId"]).toBeUndefined();
    expect(captured[0].attributes["askr.route"]).toBe("/items/{");
    expect(captured[0].exceptions).toEqual([{ name: "Error", message: "operation failed" }]);
    expect(logs[0].requestId).toBeUndefined();
  });

  it("should truncate string fields without splitting Unicode characters", () => {
    const logs: TelemetryFields[] = [];
    const telemetry = createTelemetry({
      maxFieldLength: 1,
      logger: (_level, _event, fields) => logs.push(fields),
    });

    telemetry.log("info", "askr.request", { route: "😀x" });
    expect(logs[0].route).toBe("😀");
  });

  it("should preserve randomly sampled astral code points at every truncation boundary", () => {
    let sample = 0x12345678;
    for (let index = 0; index < 256; index += 1) {
      sample = (sample * 1664525 + 1013904223) >>> 0;
      const codePoint = 0x10000 + (sample % (0x10ffff - 0x10000 + 1));
      const character = String.fromCodePoint(codePoint);
      const logs: TelemetryFields[] = [];
      const telemetry = createTelemetry({
        maxFieldLength: 1,
        logger: (_level, _event, fields) => logs.push(fields),
      });

      telemetry.log("info", "askr.request", { route: `${character}suffix` });
      expect(logs[0].route).toBe(character);
    }
  });

  it("should preserve synchronous operations as synchronous values", () => {
    const telemetry = createTelemetry();
    expect(telemetry.ssrRender({ status: 200 }, () => "html")).toBe("html");
  });

  it("should preserve response identity and thrown errors exactly", async () => {
    const telemetry = createTelemetry({ sanitizeException: () => ({ message: "safe" }) });
    const response = { status: 201, headers: { location: "/items/1" }, body: "created" };
    expect(telemetry.apiOperation({}, () => response)).toBe(response);

    const failure = new TypeError("application contract");
    expect(() =>
      telemetry.action({}, () => {
        throw failure;
      }),
    ).toThrow(failure);
    await expect(
      telemetry.loader({}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("should isolate logger failures and still end each span exactly once", async () => {
    captured.length = 0;
    const telemetry = createTelemetry({
      logger: () => {
        throw new Error("observer failed");
      },
    });

    expect(telemetry.apiOperation({}, () => "ok")).toBe("ok");
    const failure = new Error("application failed");
    await expect(
      telemetry.loader({}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(captured).toHaveLength(2);
    expect(captured.every((entry) => entry.ended === 1)).toBe(true);
  });

  it("should derive HTTP status from response-like results without logging response data", async () => {
    captured.length = 0;
    const logs: Array<{
      level: string;
      fields: Readonly<TelemetryFields>;
    }> = [];
    const telemetry = createTelemetry({
      logger: (level, _event, fields) => logs.push({ level, fields }),
    });

    const unavailable = await telemetry.request({ requestId: "req-503" }, async () => ({
      status: 503,
      body: "sensitive",
    }));
    const notFound = telemetry.apiOperation({ operation: "inventory.read" }, () => ({
      status: 404,
      body: "not logged",
    }));

    expect(unavailable.status).toBe(503);
    expect(notFound.status).toBe(404);
    expect(captured[0].attributes["askr.status"]).toBe(503);
    expect(captured[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(captured[1].attributes["askr.status"]).toBe(404);
    expect(captured[1].status?.code).toBe(SpanStatusCode.OK);
    expect(logs).toEqual([
      {
        level: "error",
        fields: expect.objectContaining({ requestId: "req-503", status: 503 }),
      },
      {
        level: "info",
        fields: expect.objectContaining({ operation: "inventory.read", status: 404 }),
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("sensitive");
    expect(JSON.stringify(logs)).not.toContain("not logged");
  });

  it("should allowlist structured fields and drop sensitive request data", () => {
    let written: Readonly<TelemetryFields> | undefined;
    const telemetry = createTelemetry({
      logger: (_level, _event, fields) => {
        written = fields;
      },
    });

    telemetry.log("info", "askr.action", {
      requestId: "req-2",
      action: "save-profile",
      body: { email: "person@example.com" },
      cookie: "session=secret",
      authorization: "Bearer secret",
      token: "secret",
    } as TelemetryFields);

    expect(written).toEqual({ requestId: "req-2", action: "save-profile" });
    expect(JSON.stringify(written)).not.toContain("secret");
    expect(Object.isFrozen(written)).toBe(true);
  });

  it("should apply caller redaction to embedded sensitive text and omit object values", () => {
    const logs: TelemetryFields[] = [];
    const telemetry = createTelemetry({
      sanitizeField: (_name, value) =>
        typeof value === "string" && /password|authorization|token/iu.test(value)
          ? "[REDACTED]"
          : value,
      logger: (_level, _event, fields) => logs.push(fields),
    });

    telemetry.log("info", "askr.request", {
      requestId: '{"password":"hunter2"}',
      route: new Error("token=secret"),
      action: { circular: undefined },
    } as unknown as TelemetryFields);
    expect(logs).toEqual([{ requestId: "[REDACTED]" }]);
    expect(JSON.stringify(logs)).not.toContain("hunter2");
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("should read each allowlisted getter at most once", () => {
    let reads = 0;
    const logs: TelemetryFields[] = [];
    const fields = {} as TelemetryFields;
    Object.defineProperty(fields, "requestId", {
      enumerable: true,
      get: () => `value-${++reads}`,
    });
    createTelemetry({ logger: (_level, _event, value) => logs.push(value) }).log(
      "info",
      "askr.request",
      fields,
    );
    expect(reads).toBe(1);
    expect(logs).toEqual([{ requestId: "value-1" }]);
  });

  it("should diagnose unknown fields without exposing values or changing work", () => {
    const dropped: PropertyKey[] = [];
    const telemetry = createTelemetry({
      onDroppedField: (name) => dropped.push(name),
    });
    const secret = Symbol("secret-field");

    expect(
      telemetry.action(
        { requestId: "req-3", resuestId: "typo-value", [secret]: "hidden" } as TelemetryFields,
        () => "saved",
      ),
    ).toBe("saved");
    expect(dropped).toEqual(["resuestId", secret]);

    const isolated = createTelemetry({
      onDroppedField: () => {
        throw new Error("diagnostic failed");
      },
    });
    expect(
      isolated.log("debug", "askr.request", { typo: "secret" } as TelemetryFields),
    ).toBeUndefined();
  });

  it("should isolate poisoned field getters and Proxy traps from application work", () => {
    const telemetry = createTelemetry();
    const poisonedGetter = {} as TelemetryFields;
    Object.defineProperty(poisonedGetter, "route", {
      get() {
        throw new Error("poisoned route getter");
      },
    });
    const poisonedProxy = new Proxy({} as TelemetryFields, {
      get(_target, property) {
        if (property === "requestId") {
          throw new Error("poisoned requestId trap");
        }
        return undefined;
      },
    });

    expect(() => telemetry.log("info", "askr.request", poisonedGetter)).not.toThrow();
    expect(telemetry.request(poisonedProxy, () => "request completed")).toBe("request completed");
    expect(telemetry.span("askr.loader", poisonedGetter, () => "loader completed")).toBe(
      "loader completed",
    );
  });

  it("should return a result with an unreadable then property without failing application work", () => {
    const telemetry = createTelemetry();
    const result = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            throw new Error("poisoned then trap");
          }
          return undefined;
        },
      },
    );

    expect(telemetry.request({}, () => result)).toBe(result);
  });

  it("should inject and extract trace identity through caller-owned carriers", () => {
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
      { "x-trace-id": "30000000000000000000000000000003" },
      getter,
    );
    const carrier: Record<string, string> = {};

    telemetry.withContext(incoming, () => {
      expect(telemetry.traceId()).toBe("30000000000000000000000000000003");
      telemetry.inject(carrier, setter);
    });

    expect(carrier).toEqual({ "x-trace-id": "30000000000000000000000000000003" });
    expect(trace.getSpanContext(ROOT_CONTEXT)).toBeUndefined();
  });
  it("should isolate rejected async sinks without replacing application results or failures", async () => {
    captured.length = 0;
    const sinkError = new Error("async sink rejected");
    const originalError = new Error("application rejected");
    const telemetry = createTelemetry({
      logger: async () => {
        throw sinkError;
      },
    });
    const response = { status: 200 };
    expect(telemetry.request({}, () => response)).toBe(response);
    await expect(
      telemetry.loader({}, async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured).toHaveLength(2);
    expect(captured.every((span) => span.ended === 1)).toBe(true);
  });

  it("should mark undefined throws and rejections as failures", async () => {
    captured.length = 0;
    const telemetry = createTelemetry();
    let caught = false;
    try {
      telemetry.action({}, () => {
        throw undefined;
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    await expect(telemetry.loader({}, () => Promise.reject(undefined))).rejects.toBeUndefined();
    expect(captured.map((span) => span.status?.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
    expect(captured.every((span) => span.ended === 1)).toBe(true);
  });

  it("should preserve a hostile thrown value when exception inspection fails", () => {
    captured.length = 0;
    const original = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("poisoned prototype");
        },
      },
    );
    const telemetry = createTelemetry({ sanitizeException: () => ({ message: "safe" }) });
    let caught: unknown;
    try {
      telemetry.action({}, () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught === original).toBe(true);
    expect(captured[0].ended).toBe(1);
    expect(captured[0].exceptions).toEqual([]);
  });

  it.each(["before", "after"] as const)(
    "should preserve exact-once application work when the tracer fails %s invoking it",
    (stage) => {
      const tracer = trace.getTracer("@askrjs/otel");
      const originalStart = tracer.startActiveSpan.bind(tracer);
      const spy = vi.spyOn(tracer, "startActiveSpan").mockImplementation(((...args: unknown[]) => {
        if (stage === "before") throw new Error("provider failure before work");
        Reflect.apply(originalStart, undefined, args);
        throw new Error("provider failure after work");
      }) as typeof tracer.startActiveSpan);
      try {
        const work = vi.fn(() => ({ status: 201 }));
        const result = createTelemetry().request({}, work);
        expect(result).toBe(work.mock.results[0].value);
        expect(work).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("should preserve the original application failure when the provider replaces it", () => {
    const tracer = trace.getTracer("@askrjs/otel");
    const originalStart = tracer.startActiveSpan.bind(tracer);
    const spy = vi.spyOn(tracer, "startActiveSpan").mockImplementation(((...args: unknown[]) => {
      try {
        Reflect.apply(originalStart, undefined, args);
      } catch {
        throw new Error("provider replaced error");
      }
    }) as typeof tracer.startActiveSpan);
    const failure = new Error("original app error");
    const work = vi.fn(() => {
      throw failure;
    });
    try {
      expect(() => createTelemetry().action({}, work)).toThrow(failure);
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("should drop nested, nonfinite and mismatched field values before invoking the sanitizer", () => {
    const logs: TelemetryFields[] = [];
    const sanitizer = vi.fn((_key, value) => value);
    const telemetry = createTelemetry({
      logger: (_level, _event, fields) => {
        logs.push(fields);
      },
      sanitizeField: sanitizer,
    });
    const nested: { password: string; self?: unknown } = { password: "secret" };
    nested.self = nested;
    telemetry.log("warn", "askr.request", {
      route: nested,
      requestId: 42,
      status: NaN,
      durationMs: Infinity,
      body: nested,
    } as unknown as TelemetryFields);
    expect(logs).toEqual([{}]);
    expect(sanitizer).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("should drop invalid transformed fields and retain bounded valid values", () => {
    const logs: TelemetryFields[] = [];
    const telemetry = createTelemetry({
      maxFieldLength: 4,
      sanitizeField: (key) =>
        key === "status" ? "invalid" : key === "durationMs" ? NaN : "😀😀😀😀😀",
      logger: (_level, _event, fields) => {
        logs.push(fields);
      },
    });
    telemetry.log("info", "askr.action", { route: "/valid", status: 200, durationMs: 1 });
    expect(logs).toEqual([{ route: "😀😀😀😀" }]);
  });

  it("should forward every supported severity and repeated calls without implicit filtering", () => {
    const records: string[] = [];
    const telemetry = createTelemetry({
      logger: (level, event) => {
        records.push(`${level}:${event}`);
      },
    });
    for (let count = 0; count < 25; count += 1) {
      for (const level of ["debug", "info", "warn", "error"] as const)
        telemetry.log(level, "askr.request");
    }
    expect(records).toHaveLength(100);
    expect(records.slice(0, 4)).toEqual([
      "debug:askr.request",
      "info:askr.request",
      "warn:askr.request",
      "error:askr.request",
    ]);
  });

  it.each([0, -1, 0.5, Infinity, NaN])(
    "should reject an invalid maxFieldLength %s before work starts",
    (maxFieldLength) => {
      expect(() => createTelemetry({ maxFieldLength })).toThrow("positive integer");
    },
  );

  it("should preserve rejected async work when the provider throws after its callback returns", async () => {
    const tracer = trace.getTracer("@askrjs/otel");
    const originalStart = tracer.startActiveSpan.bind(tracer);
    const spy = vi.spyOn(tracer, "startActiveSpan").mockImplementation(((...args: unknown[]) => {
      Reflect.apply(originalStart, undefined, args);
      throw new Error("post-callback provider failure");
    }) as typeof tracer.startActiveSpan);
    const failure = new Error("original async failure");
    const work = vi.fn(() => Promise.reject(failure));
    try {
      await expect(createTelemetry().loader({}, work)).rejects.toBe(failure);
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
