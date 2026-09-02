import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NornWorkflowArtifactRef } from "../api.ts";

export class NornArtifacts {
	constructor(private readonly artifactsRoot: string) {}

	async write(path: string, content: string): Promise<NornWorkflowArtifactRef> {
		await writeTextFile(this.resolveArtifactPath(path), content);
		return { path };
	}

	async read(ref: NornWorkflowArtifactRef): Promise<string> {
		return readFile(this.resolveArtifactPath(ref.path), "utf8");
	}

	private resolveArtifactPath(path: string): string {
		if (isAbsolute(path)) throw new Error(`Artifact path must be relative: ${path}`);
		const resolvedPath = resolve(this.artifactsRoot, path);
		const relativePath = relative(this.artifactsRoot, resolvedPath);
		if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error(`Artifact path escapes artifacts directory: ${path}`);
		}
		return resolvedPath;
	}
}

async function writeTextFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}
