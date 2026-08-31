# palantir

Typed, resumable workflow plugins for coding agents.

`palantir` owns the workflow API and daemonless run engine. The engine is executed
through the JSON-native `palantir` CLI; host applications embed `palantir/client`,
not the scheduler.

```bash
npm install github:vimhead/palantir
```

## Features

- Typed plugin manifests and executable plugins.
- Project plugin discovery through `palantir.json`.
- Detached workflow execution with `palantir execute-run <run-id>`.
- JSON command output and NDJSON log/event streams.
- Human-readable run names such as `quiet-river-lantern`.
- Explicit workflow controls: `run.next`, `run.complete`, `run.fail`.
- Resumable runs under `.palantir/runs/<run-id>`.
- CAS checkpoints for rollback and resume.
- Workspace-only access through `run.workspace`, `run.cwd`, and `run.path(...)`.
- Typed state, artifacts, command logs, and Pi SDK agent calls.
- Gates that pause before a target workflow and edit normal params.

## Register plugins

Create `palantir.json` in the project:

```json
{
  "plugins": ["./palantir/plugin.ts"],
  "config": {
    "example": {}
  }
}
```

Plugin paths are resolved relative to `palantir.json`. Project config is keyed by
plugin id and validated against each plugin manifest config schema. Each plugin
module must default-export the plugin.

For multiple plugin packages, keep package-local configs and aggregate them with
explicit includes:

```json
{
  "includes": ["./packages/*/palantir.json"]
}
```

Included configs can declare their own `plugins` and `includes`. `*` matches one
directory segment; Palantir does not perform blind downward scanning.

## Examples

The repository includes runnable examples under `examples/`, including
`examples/worktree-development-loop`.

```bash
cd examples/worktree-development-loop
palantir project inspect
palantir workflows inspect worktreeDevelopmentLoop.developmentLoop
```

## Seer mode config

Projects can declare a Seer mode write boundary in their nearest `palantir.json`.
Palantir resolves each writable root relative to that config file and rejects roots
that escape the project root.

```json
{
  "includes": ["./packages/workflows/palantir.json"],
  "seerMode": {
    "writableRoots": ["./workflow-sources"]
  }
}
```

Inspect the resolved config with:

```bash
palantir seer inspect
```

## Define workflows

Workflow files export plain objects. The manifest key becomes the default fully
qualified id.

```ts
import { z } from "zod";
import type { PalantirWorkflowDefinition } from "palantir";

export const planWorkflow = {
  title: "Plan",
  isEntrypoint: true,
  params: z.object({ task: z.string() }),
} as const satisfies PalantirWorkflowDefinition;
```

Explicit ids are allowed only when fully qualified with the plugin id.

```ts
export const legacyWorkflow = {
  id: "example.oldPlan",
  title: "Plan",
  isEntrypoint: true,
  params,
} as const satisfies PalantirWorkflowDefinition;
```

## Define a manifest

State leaves can be raw Zod schemas. State ids are derived from the tree path.

```ts
import { definePluginManifest, workflowArtifactRefSchema } from "palantir";
import { z } from "zod";
import { planWorkflow } from "./workflows/plan.ts";

export const manifest = definePluginManifest({
  id: "example",
  config: z.object({ repositoryRoot: z.string() }),
  workflows: {
    plan: planWorkflow,
  },
  states: {
    planning: {
      planArtifact: workflowArtifactRefSchema,
    },
  },
});

manifest.workflows.plan.id; // "example.plan"
manifest.states.planning.planArtifact.id; // "example.planning.planArtifact"
```

## Bind implementations

```ts
import { definePlugin } from "palantir";
import { manifest } from "./manifest.ts";

export default definePlugin(manifest, {
  workflows: {
    plan: {
      async execute(run, params, config) {
        const ref = await run.with({ cwd: config.repositoryRoot }).artifacts.write("plan.md", params.task);
        await run.state.set(manifest.states.planning.planArtifact, ref);
        return run.complete({
          summary: "Plan created.",
          artifacts: { plan: ref },
        });
      },
    },
  },
});
```

## Chain workflows

Workflows never call each other directly. They return scheduler controls.

```ts
return run.next(manifest.workflows.implement, {
  task: params.task,
  iteration: 1,
});

return run.complete({ summary: "Accepted after review." });

return run.fail({ summary: "Blocked by missing credentials." });
```

Outcome metadata is persisted in `current/run-state.json`. Keep it small:
use it as a table of contents for artifacts, logs, and state.

## Run workflows

The CLI is JSON-native.

```bash
palantir project inspect

palantir workflows list

palantir workflows list --all

palantir workflows inspect example.plan

echo '{"params":{"task":"Add tests"}}' | palantir runs start example.plan

palantir runs list

palantir runs wait quiet-river-lantern

palantir runs logs quiet-river-lantern --follow

palantir runs metrics quiet-river-lantern

palantir runs stop quiet-river-lantern

palantir runs delete quiet-river-lantern

echo '{"params":{"decision":"accept"}}' | palantir runs resume quiet-river-lantern
```

`project inspect` returns resolved config files, plugin config schemas, plugin config values, and Seer mode. `workflows list` returns entrypoint workflows by default; pass `--all` to include internal workflow steps. `workflows inspect <id>` returns params JSON Schema, gate, and plugin source info. `start` reads `{"params":{...},"config":{"pluginId":{...}}}` from stdin and `resume` reads `{"params":{...}}` from stdin; no-params workflows can omit stdin. `start` and `resume` start detached execution and return immediately with run JSON.
Use `runs wait` to block until a run is no longer active; it returns the same run shape as `runs inspect`. Interrupted runs include `run.interruption` with the paused workflow id, editable params, description, and fields. Completed or failed runs include `run.outcome`; failed runs also include `run.failed`. Use the stable id, generated name, or run path for later commands. `runs metrics` reports run totals plus per-workflow, per-agent, and per-command timing, token usage, and cost. Delete is allowed only after a run is no longer running.

## TypeScript client

```ts
import { createPalantirClient } from "palantir/client";

const client = createPalantirClient({ spawnCwd: process.cwd() });
const workflows = await client.workflows.list();
const run = await client.runs.start({
  workflowId: "example.plan",
  params: { task: "Add tests" },
});

for await (const event of client.runs.logs(run.name, { follow: true })) {
  console.log(event);
}
```

## Gates

A target workflow can mark normal params as editable before execution.
`fields` is typed to top-level params. If omitted, all params are editable.

```ts
const reviewRouterParamsSchema = z.object({
  decision: z.enum(["accept", "revise", "blocked"]),
  notes: z.string(),
  diffArtifact: workflowArtifactRefSchema,
});

export const reviewRouterWorkflow = {
  isEntrypoint: false,
  gate: {
    enabled: true,
    fields: ["decision", "notes"] as const,
  },
  params: reviewRouterParamsSchema,
} as const satisfies PalantirWorkflowDefinition;
```

Dynamic gate descriptions live in the implementation and are persisted when the
run pauses.

```ts
reviewRouter: {
  gate: {
    async describe(run, params) {
      const ref = await run.state.get(manifest.states.planning.planArtifact);
      return `Review ${params.diffArtifact.path} against ${ref.path}.`;
    },
  },
  execute: executeReviewRouter,
}
```

## Run storage

Each run is split into immutable CAS storage and the current materialized state.

```text
.palantir/runs/<run-id>/
  active.lock/
    owner.json
  store/
    objects/sha256/.../*.gz
    snapshots/<checkpoint-id>.json
    refs/current
  current/
    checkpoints.json
    run-state.json
    manifest.json
    state.json
    logs/
    artifacts/
    sessions/
    workspace/
```

The engine snapshots all of `current/` at boundaries. Rollback restores the
saved snapshot exactly, including nested repositories inside `workspace/`.
