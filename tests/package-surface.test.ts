import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/index";

describe("package surface", () => {
  it("should expose only the function-first telemetry factory at runtime", () => {
    expect(Object.keys(api).sort()).toEqual(["createTelemetry"]);
  });

  it("should require the runtime OpenTelemetry API peer and publish no backend entrypoints", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, unknown>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      publishConfig: { access: string };
    };

    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./package.json"]);
    expect(manifest.peerDependencies["@opentelemetry/api"]).toBe("^1.9.1");
    expect(manifest.peerDependenciesMeta?.["@opentelemetry/api"]?.optional).not.toBe(true);
    expect(manifest.publishConfig.access).toBe("public");
  });
});
