import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/index";

describe("package surface", () => {
  it("should expose only the function-first telemetry factory at runtime", () => {
    expect(Object.keys(api).sort()).toEqual(["createTelemetry"]);
  });

  it("should keep OpenTelemetry optional and publish no backend entrypoints", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, unknown>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
      publishConfig: { access: string };
    };

    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./package.json"]);
    expect(manifest.peerDependenciesMeta["@opentelemetry/api"].optional).toBe(true);
    expect(manifest.publishConfig.access).toBe("public");
  });
});
