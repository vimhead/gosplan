# Workspace development loop example

A minimal Palantir workflow plugin for one Git repository.

It registers an entrypoint workflow named **Workspace development loop**. The
workflow:

1. clones the configured repository into `run.workspace/repo`;
2. stores the repository path in workflow state;
3. passes explicit cwd values to agents and commands;
4. plans once, then loops through implementation and automated review;
5. routes automated review through a gated review router;
6. completes on `accept`, fails cleanly on `blocked`, and fails cleanly when the
   max iteration count is reached.

The example is structured like a real workflow package:

```text
manifest.ts
plugin.ts
state.ts
workflows/
  development-loop/
    schema.ts
    declaration.ts
    execute.ts
  planning/
    schema.ts
    declaration.ts
    execute.ts
  implementation/
    schema.ts
    declaration.ts
    execute.ts
  review/
    schema.ts
    declaration.ts
    execute.ts
  review-router/
    schema.ts
    declaration.ts
    execute.ts
```

Best practices shown:

- local workflow declarations are plain objects;
- manifest keys derive fully qualified workflow ids;
- state leaves are Zod schemas and derive ids from the state tree;
- `plugin.ts` binds implementations and dynamic gate descriptions;
- workflows only route with `run.next(...)`;
- runs finish explicitly with `run.complete(...)` or
  `run.fail(...)`;
- final details are persisted as small outcome metadata pointing to artifacts;
- the workspace may contain a nested `.git/` because Palantir snapshots with CAS.

Set `config.worktreeDevelopmentLoop.repositoryRoot` in `palantir.project.json`
to the repository you want the workflow to clone.

```bash
palantir project inspect
palantir workflows inspect worktreeDevelopmentLoop.developmentLoop
printf '{"params":{"task":"Add tests"}}' | palantir runs start worktreeDevelopmentLoop.developmentLoop
```
