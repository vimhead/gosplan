import { readFile } from "node:fs/promises";
import type { PalantirWorkflowStateDefinition, PalantirWorkflowState } from "../api.ts";
import { isNodeError } from "./errors.ts";
import { writeJsonAtomically } from "./json-file.ts";

export class PalantirMemoryWorkflowState implements PalantirWorkflowState {
	private readonly data = new Map<string, unknown>();

	async get<T>(state: PalantirWorkflowStateDefinition<T>): Promise<T> {
		const value = await this.getOptional(state);
		if (value === undefined) throw new Error(`Missing workflow state: ${state.id}`);
		return value;
	}

	async getOptional<T>(state: PalantirWorkflowStateDefinition<T>): Promise<T | undefined> {
		if (!this.data.has(state.id)) return undefined;
		return state.schema.parse(this.data.get(state.id));
	}

	async set<T>(state: PalantirWorkflowStateDefinition<T>, value: T): Promise<void> {
		this.data.set(state.id, state.schema.parse(value));
	}
}

export class PalantirJsonWorkflowState implements PalantirWorkflowState {
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly stateFile: string) {}

	async get<T>(state: PalantirWorkflowStateDefinition<T>): Promise<T> {
		const value = await this.getOptional(state);
		if (value === undefined) throw new Error(`Missing workflow state: ${state.id}`);
		return value;
	}

	async getOptional<T>(state: PalantirWorkflowStateDefinition<T>): Promise<T | undefined> {
		const data = await this.readStateFile();
		if (!Object.prototype.hasOwnProperty.call(data, state.id)) return undefined;
		return state.schema.parse(data[state.id]);
	}

	async set<T>(state: PalantirWorkflowStateDefinition<T>, value: T): Promise<void> {
		const parsedValue = state.schema.parse(value);
		this.writeChain = this.writeChain.then(async () => {
			const data = await this.readStateFile();
			data[state.id] = parsedValue;
			await writeJsonAtomically(this.stateFile, data);
		});
		await this.writeChain;
	}

	private async readStateFile(): Promise<Record<string, unknown>> {
		try {
			const content = await readFile(this.stateFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
			return {};
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return {};
			throw error;
		}
	}
}
