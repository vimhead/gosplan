import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NornLogRef } from "../api.ts";

export type NornLogWriteStream = {
	readonly log: NornLogRef;
	readonly stream: WriteStream;
};

export class NornRunLogs {
	constructor(private readonly logsRoot: string) {}

	async write(path: string, content: string): Promise<void> {
		const absolutePath = this.resolveLogPath(path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf8");
	}

	async read(log: NornLogRef): Promise<string> {
		return readFile(this.resolveLogPath(`${log.id}.log`), "utf8");
	}

	async createWriteStream(log: NornLogRef): Promise<NornLogWriteStream> {
		const absolutePath = this.resolveLogPath(`${log.id}.log`);
		await mkdir(dirname(absolutePath), { recursive: true });
		return {
			log,
			stream: createWriteStream(absolutePath, { encoding: "utf8" }),
		};
	}

	private resolveLogPath(path: string): string {
		if (isAbsolute(path)) throw new Error(`Log path must be relative: ${path}`);
		const resolvedPath = resolve(this.logsRoot, path);
		const relativePath = relative(this.logsRoot, resolvedPath);
		if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error(`Log path escapes logs directory: ${path}`);
		}
		return resolvedPath;
	}
}
