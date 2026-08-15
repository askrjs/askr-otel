import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is required for the installed-package smoke test.");
}

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
  const [{ filename }] = JSON.parse(packOutput);
  const packageJson = {
    name: "askrjs-otel-installed-smoke",
    private: true,
    type: "module",
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
  if (installedManifest.version !== "0.0.6") {
    throw new Error(`Expected packed @askrjs/otel@0.0.6, received ${installedManifest.version}.`);
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const { createTelemetry } = await import("@askrjs/otel"); if (createTelemetry().request({}, () => "ok") !== "ok") process.exit(1);',
    ],
    { cwd: consumer, stdio: "pipe" },
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
