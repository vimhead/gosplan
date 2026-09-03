import { readFile } from "node:fs/promises";
import { writeJsonAtomically } from "./json-file.ts";

export type NornRunManifestEvent = {
	readonly at: string;
	readonly type: string;
	readonly [key: string]: unknown;
};

export type NornRunManifest = {
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly runRoot: string;
	readonly workspace: string;
	readonly initialCwd: string;
	readonly startedAt: string;
	readonly events: readonly NornRunManifestEvent[];
};

export class NornRunLogger {
	private readonly events: NornRunManifestEvent[] = [];
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly manifestPath: string,
		private readonly manifest: Omit<NornRunManifest, "events">,
		initialEvents: readonly NornRunManifestEvent[] = [],
	) {
		this.events.push(...initialEvents);
	}

	static async load(manifestPath: string): Promise<NornRunLogger> {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as NornRunManifest;
		const { events, ...manifestHeader } = manifest;
		return new NornRunLogger(manifestPath, manifestHeader, events);
	}


	async record(event: { readonly type: string; readonly [key: string]: unknown }): Promise<void> {
		this.events.push({ at: new Date().toISOString(), ...event });
		this.writeChain = this.writeChain.then(() => writeJsonAtomically(this.manifestPath, { ...this.manifest, events: this.events }));
		await this.writeChain;
	}
}
