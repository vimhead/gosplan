# norn

Reusable, harness-agnostic workflows powered by Pi agents.

Norn lets a project package agent workflows once and run them from any harness
that can call the Norn CLI or client. Workflows combine Pi agent calls, shell
commands, artifacts, state, gates, checkpoints, and resume into one reusable
project capability.

Contents:

- [Setting up a Norn project](#setting-up-a-norn-project)
- [Writing workflows](#writing-workflows)
- [Using the CLI](#using-the-cli)

## Setting up a Norn project

Install the CLI from the rolling `tip` release:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | sh
norn version
```

Use `NORN_INSTALL_DIR` when the binary should be installed somewhere other than
`~/.local/bin`:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | NORN_INSTALL_DIR=/usr/local/bin sh
```

You can also install from GitHub with npm:

```bash
npm install github:vimhead/norn
# or
npm install -g github:vimhead/norn
```

Create a project marker:

```bash
norn project init
```

This creates `norn.project.json` and `.norn/runs/`. Norn finds a project by
walking up to the nearest `norn.project.json`.

A project file includes reusable workflow configs and owns project-specific
plugin config:

```json
{
  "version": 1,
  "includes": ["./packages/workflows/norn.json"],
  "config": {
    "example": {
      "repositoryRoot": "."
    }
  }
}
```

A reusable `norn.json` lists plugin modules:

```json
{
  "plugins": ["./plugin.ts"]
}
```

Plugin paths are resolved relative to the `norn.json` that declares them. Project
config is keyed by plugin id and validated by the plugin manifest.

For multiple packages, include package-local configs explicitly:

```json
{
  "version": 1,
  "includes": ["./packages/*/norn.json"]
}
```

`*` matches one directory segment. Norn does not scan the whole tree by default.

Projects that use Seer mode can declare writable project-relative roots:

```json
{
  "version": 1,
  "includes": ["./packages/workflows/norn.json"],
  "seerMode": {
    "writableRoots": ["./workflow-sources"]
  }
}
```

Inspect the resolved project before running workflows:

```bash
norn project inspect
norn workflows list
```

## Writing workflows

A workflow is a declaration object with params, entrypoint visibility, and an
optional isolation mode.

```ts
import { z } from "zod";
import type { NornWorkflowDefinition } from "norn";

export const planWorkflow = {
  title: "Plan",
  description: "Create an implementation plan for a coding task.",
  isEntrypoint: true,
  params: z.object({ task: z.string() }),
} as const satisfies NornWorkflowDefinition;
```

A manifest gives the plugin an id, binds workflow declarations, and can define
state shared between workflow steps:

```ts
import { definePluginManifest, artifactRefSchema } from "norn";
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
      planArtifact: artifactRefSchema,
    },
  },
});
```

A plugin binds each manifest workflow to an implementation:

```ts
import { definePlugin } from "norn";
import { manifest } from "./manifest.ts";

export default definePlugin(manifest, {
  workflows: {
    plan: {
      async execute(run, params, config) {
        const status = await run.commands.run({
          label: "status",
          cwd: run.path(config.repositoryRoot),
          command: "git status --short",
        });

        const plan = await run.artifacts.write("plan.md", params.task);
        await run.state.set(manifest.states.planning.planArtifact, plan);

        return run.complete({
          summary: "Plan created.",
          artifacts: { plan },
          logs: { status: status.stdoutLog },
        });
      },
    },
  },
});
```

Workflow implementations return run controls instead of calling other workflows
directly:

```ts
return run.complete({ summary: "Accepted after review." });

return run.fail({ summary: "Blocked by missing credentials." });
```

### Chaining workflows

Use `run.next(...)` to continue with another workflow. Pass a workflow declaration
when the target is known in code:

```ts
return run.next(manifest.workflows.implement, {
  task: params.task,
  iteration: 1,
});
```

Reusable workflows can accept a workflow reference for their next step:

```ts
import { artifactRefSchema, workflowRefSchema } from "norn";
import { z } from "zod";

const planningParamsSchema = z.object({
  task: z.string(),
  nextWorkflow: workflowRefSchema(z.object({
    planArtifact: artifactRefSchema,
    summary: z.string(),
  })).nullable(),
});

return params.nextWorkflow
  ? run.next(params.nextWorkflow, { planArtifact, summary })
  : run.complete({ summary, artifacts: { plan: planArtifact } });
```

Caller side:

```ts
return run.next(reusableManifest.workflows.plan, {
  task: params.task,
  nextWorkflow: projectManifest.workflows.receivePlan,
});
```

Use the default `runWorkspace` isolation for workflows that should operate inside
a per-run workspace. Use `project` isolation only for workflows that must inspect
or verify files in the project root:

```ts
export const verifyWorkflow = {
  title: "Verify",
  description: "Run project verification.",
  isEntrypoint: true,
  isolation: { mode: "project" },
  params,
} as const satisfies NornWorkflowDefinition;
```

A gate pauses before a workflow and lets selected top-level params be edited
before execution:

```ts
export const reviewWorkflow = {
  title: "Review",
  description: "Approve, revise, or block a proposed change.",
  isEntrypoint: false,
  gate: {
    enabled: true,
    fields: ["decision", "notes"] as const,
  },
  params: reviewParamsSchema,
} as const satisfies NornWorkflowDefinition;
```

## Using the CLI

Norn commands produce JSON unless they are help commands.

```bash
norn help
norn help runs start
norn commands list
norn commands inspect runs.start
```

Discover the current project and available workflows:

```bash
norn project inspect
norn workflows list
norn workflows list --all
norn workflows inspect example.plan
```

Start a workflow by passing params through stdin:

```bash
printf '{"params":{"task":"Add tests"}}' | norn runs start example.plan
```

The start command returns a run id and generated name. Use either value in later
commands:

```bash
norn runs list
norn runs inspect quiet-river-lantern
norn runs wait quiet-river-lantern
norn runs logs quiet-river-lantern
norn runs logs quiet-river-lantern --follow
norn runs metrics quiet-river-lantern
```

Resume an interrupted run by passing the updated params through stdin:

```bash
printf '{"params":{"decision":"accept","notes":"Looks good"}}' | norn runs resume quiet-river-lantern
```

Use checkpoints when a run needs to retry from earlier evidence:

```bash
norn runs checkpoints quiet-river-lantern
norn runs rollback quiet-river-lantern checkpoint-1
```

Stop or delete inactive runs explicitly:

```bash
norn runs stop quiet-river-lantern
norn runs kill quiet-river-lantern
norn runs delete quiet-river-lantern
```

Check the installed version and supported upgrade path:

```bash
norn version
norn upgrade --dry-run
```
