import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmpPath, path);
}
