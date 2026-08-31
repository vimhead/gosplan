# palantir

Typed, resumable workflow plugins for coding agents.

`palantir` owns the workflow API and daemonless runtime. The runtime is executed
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
- Explicit workflow controls: `runtime.next`, `runtime.complete`, `runtime.fail`.
- Resumable runs under `.palantir/runs/<run-id>`.
- CAS checkpoints for rollback and resume.
- Workspace-only access through `runtime.workspace`, `runtime.cwd`, and `runtime.path(...)`.
- Typed state, artifacts, command logs, and Pi SDK agent calls.
- Gates that pause before a target workflow and edit normal params.

## Register plugins

Create `palantir.json` in the project:

```json
{
  "plugins": ["./palantir/plugin.ts"]
}
```

Plugin paths are resolved relative to `palantir.json`. Each plugin module must
default-export the plugin.

For multiple plugin packages, keep package-local configs and aggregate them with
explicit includes:

```json
{
  "includes": ["./packages/*/palantir.json"]
}
```

Included configs can declare their own `plugins` and `includes`. `*` matches one
directory segment; Palantir does not perform blind downward scanning.

## Define workflows

Workflow files export plain objects. The manifest key becomes the default fully
qualified id.

```ts
import { z } from "zod";
import type { WorkflowDefinition } from "palantir";

export const planWorkflow = {
  displayTitle: "Plan",
  params: z.object({ task: z.string() }),
} as const satisfies WorkflowDefinition;
```

Explicit ids are allowed only when fully qualified with the plugin id.

```ts
export const legacyWorkflow = {
  id: "example.oldPlan",
  displayTitle: "Plan",
  params,
} as const satisfies WorkflowDefinition;
```

## Define a manifest

State leaves can be raw Zod schemas. State ids are derived from the tree path.

```ts
import { definePluginManifest, workflowArtifactRefSchema } from "palantir";
import { planWorkflow } from "./workflows/plan.ts";

export const manifest = definePluginManifest({
  id: "example",
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
      async execute(runtime, params) {
        const ref = await runtime.artifacts.write("plan.md", params.task);
        await runtime.state.set(manifest.states.planning.planArtifact, ref);
        return runtime.complete({
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
return runtime.next(manifest.workflows.implement, {
  task: params.task,
  iteration: 1,
});

return runtime.complete({ summary: "Accepted after review." });

return runtime.fail({ summary: "Blocked by missing credentials." });
```

Outcome metadata is persisted in `current/runtime-state.json`. Keep it small:
use it as a table of contents for artifacts, logs, and state.

## Run workflows

The CLI is JSON-native.

```bash
palantir workflows list

palantir runs start example.plan --params '{"task":"Add tests"}'

palantir runs list

palantir runs logs quiet-river-lantern --follow

palantir runs metrics quiet-river-lantern

palantir runs stop quiet-river-lantern

palantir runs delete quiet-river-lantern

palantir runs resume quiet-river-lantern --params '{"decision":"accept"}'
```

`run` and `resume` start detached execution and return immediately with run JSON.
Use the stable id, generated name, or run path for later commands. `runs metrics` reports run totals plus per-workflow, per-agent, and per-command timing, token usage, and cost. Delete is allowed only after a run is no longer running.

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
  displayTitle: null,
  gate: {
    enabled: true,
    fields: ["decision", "notes"] as const,
  },
  params: reviewRouterParamsSchema,
} as const satisfies WorkflowDefinition;
```

Dynamic gate descriptions live in the implementation and are persisted when the
run pauses.

```ts
reviewRouter: {
  gate: {
    async describe(runtime, params) {
      const ref = await runtime.state.get(manifest.states.planning.planArtifact);
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
    runtime-state.json
    manifest.json
    state.json
    logs/
    artifacts/
    sessions/
    workspace/
```

The engine snapshots all of `current/` at boundaries. Rollback restores the
saved snapshot exactly, including nested repositories inside `workspace/`.
