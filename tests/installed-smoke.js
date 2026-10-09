import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is required for the installed-package smoke test.");
}

const { version: expectedVersion } = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
);

const temporaryRoot = mkdtempSync(join(tmpdir(), "askrjs-otel-installed-"));
const packed = join(temporaryRoot, "packed");
const consumer = join(temporaryRoot, "consumer");
mkdirSync(packed);
mkdirSync(consumer);

try {
  const packOutput = execFileSync(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", packed],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const packResult = JSON.parse(packOutput);
  // npm has returned both an array and a name-keyed object from `pack --json`.
  const { filename } = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  const packageJson = {
    name: "askrjs-otel-installed-smoke",
    private: true,
    type: "module",
    dependencies: { "@opentelemetry/api": "1.9.1" },
  };
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  execFileSync(
    process.execPath,
    [npmCli, "install", "--ignore-scripts", "--package-lock=false", join(packed, filename)],
    { cwd: consumer, stdio: "pipe" },
  );
  execFileSync(process.execPath, [npmCli, "ls", "@opentelemetry/api", "--all"], {
    cwd: consumer,
    stdio: "pipe",
  });
  const installedManifest = JSON.parse(
    readFileSync(join(consumer, "node_modules", "@askrjs", "otel", "package.json"), "utf8"),
  );
  if (installedManifest.version !== expectedVersion) {
    throw new Error(
      `Expected packed @askrjs/otel@${expectedVersion}, received ${installedManifest.version}.`,
    );
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import * as api from "@askrjs/otel";
import manifest from "@askrjs/otel/package.json" with { type: "json" };
assert.equal(manifest.version, ${JSON.stringify(expectedVersion)});
assert.deepEqual(Object.keys(api), ["createTelemetry"]);
const response = { status: 200 };
const telemetry = api.createTelemetry({ logger: async () => { throw new Error("sink rejection"); } });
assert.equal(telemetry.request({}, () => response), response);
const failure = new Error("original application error");
await assert.rejects(telemetry.loader({}, async () => { throw failure; }), (error) => error === failure);
await assert.rejects(import("@askrjs/otel/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
await new Promise((resolve) => setTimeout(resolve, 0));
`,
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  writeFileSync(
    join(consumer, "types.ts"),
    `
import { createTelemetry, type TelemetryOptions } from "@askrjs/otel";
const options: TelemetryOptions = { logger: async (level, event, fields) => { void level; void event; void fields.route; } };
const telemetry: ReturnType<typeof createTelemetry> = createTelemetry(options);
const value: number = telemetry.request({}, () => 42);
const pending: Promise<string> = telemetry.loader({}, async () => "loaded");
${["Telemetry", "TelemetryLevel", "TelemetryOperation", "TelemetryFields", "TelemetryLogger"]
  .map(
    (name) => `// @ts-expect-error ${name} is inferred from the factory/options in 0.5
import type { ${name} } from "@askrjs/otel";`,
  )
  .join("\n")}
// @ts-expect-error operation names remain a closed set
telemetry.span("custom-operation", {}, () => undefined);
// @ts-expect-error arbitrary fields are not public
telemetry.log("info", "askr.request", { token: "secret" });
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: ["types.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [resolve("node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
    { stdio: "inherit" },
  );
  console.log("Packed telemetry runtime/types, minimum peer, failures, and private paths passed.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
