import { readFile } from "node:fs/promises";
import { writeJsonAtomically } from "./json-file.ts";

export type WorkflowRunManifestEvent = {
	readonly at: string;
	readonly type: string;
	readonly [key: string]: unknown;
};

export type WorkflowRunManifest = {
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly runRoot: string;
	readonly workspace: string;
	readonly initialCwd: string;
	readonly startedAt: string;
	readonly events: readonly WorkflowRunManifestEvent[];
};

export class WorkflowRunLogger {
	private readonly events: WorkflowRunManifestEvent[] = [];
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly manifestPath: string,
		private readonly manifest: Omit<WorkflowRunManifest, "events">,
		initialEvents: readonly WorkflowRunManifestEvent[] = [],
	) {
		this.events.push(...initialEvents);
	}

	static async load(manifestPath: string): Promise<WorkflowRunLogger> {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkflowRunManifest;
		const { events, ...manifestHeader } = manifest;
		return new WorkflowRunLogger(manifestPath, manifestHeader, events);
	}

	boundary(): number {
		return this.events.length;
	}

	rollback(boundary: number): void {
		this.events.splice(boundary);
	}

	async record(event: { readonly type: string; readonly [key: string]: unknown }): Promise<void> {
		this.events.push({ at: new Date().toISOString(), ...event });
		this.writeChain = this.writeChain.then(() => writeJsonAtomically(this.manifestPath, { ...this.manifest, events: this.events }));
		await this.writeChain;
	}
}
