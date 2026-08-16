# AGENTS.md

Operational guide for `@askrjs/otel`, which owns telemetry instrumentation while
applications own SDKs, exporters, processors, and vendor backends.

## Askr North Star

Keep each operation's telemetry path narratable from explicit input through
span, metric, or log emission. Enforce invalid configuration and attribute
contracts with actionable errors, and test thrown, canceled, redacted, and
disabled paths. Preserve the seam between Askr instrumentation and the
application's OpenTelemetry composition root. Prefer explicit providers,
redaction, limits, and naming over ambient discovery. Add instruments or options
only for demonstrated operational needs.

Run `npm run check` before declaring a change ready.

## Optimization Gate

A benchmark number is only half of an optimization's success criterion. The
change must also preserve a causal path that a human or agent can narrate in one
sentence.

Every benchmark-driven change must include:

1. the one-sentence causal description of the optimized path;
2. the exact fallback trigger and proof that optimized and fallback paths have
   identical observable behavior and error surfaces;
3. an explicit legibility-cost statement, including `none` when no new path or
   concept is introduced; and
4. evidence that a measured bottleneck in a real application justifies the
   optimization now.

Prefer making the existing single path faster. New caches, inference,
memoization, shortcuts, fast paths, or scheduler states require an explicit
legibility decision; a speedup alone does not justify them.
