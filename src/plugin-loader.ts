import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import { isWorkflowPlugin, type PalantirJsonSchema, type PalantirProjectPluginInfo, type PalantirWorkflowPlugin, type PalantirWorkflowPluginInfo } from "./api.ts";
import { isNodeError } from "./internal/errors.ts";
import { PalantirMemoryWorkflowState } from "./internal/state-store.ts";
import { PalantirWorkflowRegistry, type PalantirRegisteredWorkflow } from "./internal/workflow-registry.ts";
import { schemaType, unwrapSchema } from "./schema.ts";
import { resolveSeerModeConfig, type PalantirResolvedSeerModeConfig } from "./seer/index.ts";

const PALANTIR_CONFIG_FILE_NAME = "palantir.json";
const seerModeConfigSchema = z.object({
	writableRoots: z.array(z.string().min(1)).min(1),
});
const palantirConfigSchema = z.object({
	plugins: z.array(z.string().min(1)).default([]),
	includes: z.array(z.string().min(1)).default([]),
	config: z.record(z.string(), z.unknown()).default({}),
	seerMode: seerModeConfigSchema.optional(),
});

type PalantirConfig = z.output<typeof palantirConfigSchema>;

type PalantirConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: PalantirConfig;
};

export type PalantirProject = {
	readonly cwd: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly config: PalantirConfig;
	readonly configFiles: readonly PalantirConfigFile[];
	readonly projectConfig: Record<string, unknown>;
	readonly seerMode?: PalantirResolvedSeerModeConfig;
};

export type PalantirLoadedProject = PalantirProject & {
	readonly plugins: readonly PalantirWorkflowPlugin[];
	readonly pluginInfos: readonly PalantirProjectPluginInfo[];
	readonly registry: PalantirWorkflowRegistry;
	readonly workflows: readonly PalantirRegisteredWorkflow[];
	readonly state: PalantirMemoryWorkflowState;
};

type LoadedPalantirWorkflowPlugin = {
	readonly plugin: PalantirWorkflowPlugin;
	readonly info: PalantirProjectPluginInfo;
};

export async function loadPalantirProject(cwd: string): Promise<PalantirLoadedProject> {
	const project = await findPalantirProject(cwd);
	const loadedPlugins = await loadWorkflowPlugins(project);
	const registry = new PalantirWorkflowRegistry();
	const state = new PalantirMemoryWorkflowState();
	for (const { plugin, info } of loadedPlugins) {
		const implementation = typeof plugin.implementation === "function"
			? plugin.implementation({ cwd: project.cwd, state })
			: plugin.implementation;
		for (const [key, workflow] of Object.entries(plugin.manifest.workflows)) {
			const workflowImplementation = implementation.workflows[key];
			if (!workflowImplementation) throw new Error(`Missing implementation for workflow ${plugin.manifest.id}.${key}`);
			registry.register(workflow, workflowImplementation, { plugin: workflowPluginInfo(info), configSchema: plugin.manifest.config, config: info.config });
		}
	}
	return { ...project, plugins: loadedPlugins.map(({ plugin }) => plugin), pluginInfos: loadedPlugins.map(({ info }) => info), registry, workflows: registry.launchableEntries(), state };
}

export async function findPalantirProject(cwd: string): Promise<PalantirProject> {
	const configPath = await findNearestPalantirConfig(cwd);
	const rootConfig = await readPalantirConfigFile(configPath);
	const configFiles = await loadIncludedPalantirConfigFiles(rootConfig, new Set());
	return {
		cwd: resolve(cwd),
		configPath: rootConfig.path,
		configRoot: rootConfig.root,
		config: rootConfig.config,
		configFiles,
		projectConfig: mergeProjectConfig(configFiles),
		seerMode: resolveSeerModeConfig({ configPath: rootConfig.path, configRoot: rootConfig.root, seerMode: rootConfig.config.seerMode }),
	};
}

async function findNearestPalantirConfig(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		const configPath = join(current, PALANTIR_CONFIG_FILE_NAME);
		try {
			await access(configPath);
			return configPath;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) throw new Error(`Could not find ${PALANTIR_CONFIG_FILE_NAME} from ${cwd}`);
		current = parent;
	}
}

async function loadIncludedPalantirConfigFiles(configFile: PalantirConfigFile, visitedPaths: Set<string>): Promise<PalantirConfigFile[]> {
	if (visitedPaths.has(configFile.path)) return [];
	visitedPaths.add(configFile.path);
	const includedConfigFiles = await Promise.all(configFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(configFile.root, includePath);
		return Promise.all(configPaths.map(readPalantirConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadIncludedPalantirConfigFiles(includedConfigFile, visitedPaths)));
	return [configFile, ...descendants.flat()];
}

async function readPalantirConfigFile(path: string): Promise<PalantirConfigFile> {
	const config = palantirConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
	return { path, root: dirname(path), config };
}

async function loadWorkflowPlugins(project: PalantirProject): Promise<LoadedPalantirWorkflowPlugin[]> {
	const plugins: LoadedPalantirWorkflowPlugin[] = [];
	const pluginIds = new Set<string>();
	for (const configFile of project.configFiles) {
		const jiti = createJiti(pathToFileURL(configFile.path).href, { moduleCache: false });
		for (const pluginPath of configFile.config.plugins) {
			const resolvedPluginPath = resolveConfigPath(configFile.root, pluginPath);
			const module = await jiti.import(pathToFileURL(resolvedPluginPath).href) as { default?: unknown };
			if (!isWorkflowPlugin(module.default)) throw new Error(`Palantir plugin must be the default export: ${resolvedPluginPath}`);
			if (pluginIds.has(module.default.manifest.id)) throw new Error(`Duplicate Palantir plugin id: ${module.default.manifest.id}`);
			pluginIds.add(module.default.manifest.id);
			const configInput = project.projectConfig[module.default.manifest.id];
			if (!module.default.manifest.config && configInput !== undefined) throw new Error(`Palantir config provided for plugin without config schema: ${module.default.manifest.id}`);
			const config = module.default.manifest.config ? module.default.manifest.config.parse(defaultConfigInput(module.default.manifest.config, configInput)) : undefined;
			plugins.push({
				plugin: module.default,
				info: {
					id: module.default.manifest.id,
					path: resolvedPluginPath,
					configPath: configFile.path,
					configSchema: module.default.manifest.config ? z.toJSONSchema(module.default.manifest.config, { io: "input" }) as PalantirJsonSchema : null,
					config,
				},
			});
		}
	}
	return plugins;
}

function workflowPluginInfo(info: PalantirProjectPluginInfo): PalantirWorkflowPluginInfo {
	return { id: info.id, path: info.path, configPath: info.configPath };
}

function mergeProjectConfig(configFiles: readonly PalantirConfigFile[]): Record<string, unknown> {
	let result: Record<string, unknown> = {};
	for (const configFile of configFiles) {
		result = mergeConfigObjects(result, configFile.config.config, ["config"]);
	}
	return result;
}

function mergeConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = Object.prototype.hasOwnProperty.call(result, key)
			? mergeConfigValue(result[key], overrideValue, [...path, key])
			: overrideValue;
	}
	return result;
}

function mergeConfigValue(base: unknown, override: unknown, path: readonly string[]): unknown {
	if (isPlainObject(base) && isPlainObject(override)) return mergeConfigObjects(base, override, path);
	if (jsonValuesEqual(base, override)) return base;
	throw new Error(`Conflicting Palantir project config at ${path.join(".")}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function defaultConfigInput(configSchema: z.ZodType, config: unknown): unknown {
	if (config !== undefined) return config;
	return schemaType(unwrapSchema(configSchema)) === "object" ? {} : undefined;
}

async function expandIncludePath(configRoot: string, includePath: string): Promise<string[]> {
	const resolvedIncludePath = resolveConfigPath(configRoot, includePath);
	if (!hasGlobSegment(includePath)) return [resolvedIncludePath];
	return expandGlobSegments(isAbsolute(includePath) ? sep : configRoot, splitPathSegments(includePath));
}

async function expandGlobSegments(root: string, segments: readonly string[]): Promise<string[]> {
	if (segments.length === 0) return [root];
	const [segment, ...remainingSegments] = segments;
	if (segment === "*") {
		const entries = await readdir(root, { withFileTypes: true });
		const expanded = await Promise.all(entries
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((entry) => expandGlobSegments(join(root, entry.name), remainingSegments)));
		return expanded.flat();
	}
	return expandGlobSegments(join(root, segment), remainingSegments);
}

function resolveConfigPath(configRoot: string, path: string): string {
	if (path.length === 0) throw new Error("Palantir path must not be empty");
	return isAbsolute(path) ? path : resolve(configRoot, path);
}

function hasGlobSegment(path: string): boolean {
	return splitPathSegments(path).includes("*");
}

function splitPathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}
