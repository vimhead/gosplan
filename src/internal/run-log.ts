import { readFile } from "node:fs/promises";
import { writeJsonAtomically } from "./json-file.ts";

export type PalantirRunManifestEvent = {
	readonly at: string;
	readonly type: string;
	readonly [key: string]: unknown;
};

export type PalantirRunManifest = {
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly runRoot: string;
	readonly workspace: string;
	readonly initialCwd: string;
	readonly startedAt: string;
	readonly events: readonly PalantirRunManifestEvent[];
};

export class PalantirRunLogger {
	private readonly events: PalantirRunManifestEvent[] = [];
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly manifestPath: string,
		private readonly manifest: Omit<PalantirRunManifest, "events">,
		initialEvents: readonly PalantirRunManifestEvent[] = [],
	) {
		this.events.push(...initialEvents);
	}

	static async load(manifestPath: string): Promise<PalantirRunLogger> {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PalantirRunManifest;
		const { events, ...manifestHeader } = manifest;
		return new PalantirRunLogger(manifestPath, manifestHeader, events);
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
