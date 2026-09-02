import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import * as typeboxModule from "typebox";
import { z } from "zod";
import * as zodModule from "zod";
import * as palantirApiModule from "./api.ts";
import * as palantirModule from "./index.ts";
import * as palantirSchemaModule from "./schema.ts";
import * as palantirSeerModule from "./seer/index.ts";
import { isWorkflowPlugin, type PalantirJsonSchema, type PalantirProjectPluginInfo, type PalantirWorkflowPlugin, type PalantirWorkflowPluginInfo } from "./api.ts";
import { isNodeError } from "./internal/errors.ts";
import { PalantirMemoryWorkflowState } from "./internal/state-store.ts";
import { PalantirWorkflowRegistry, type PalantirRegisteredWorkflow } from "./internal/workflow-registry.ts";
import { schemaType, unwrapSchema } from "./schema.ts";
import { resolveSeerModeConfig, type PalantirResolvedSeerModeConfig } from "./seer/index.ts";

export const PALANTIR_PROJECT_FILE_NAME = "palantir.project.json";
export const PALANTIR_CONFIG_FILE_NAME = "palantir.json";

const seerModeConfigSchema = z.object({
	writableRoots: z.array(z.string().min(1)).min(1),
});
const palantirConfigSchema = z.object({
	plugins: z.array(z.string().min(1)).default([]),
	includes: z.array(z.string().min(1)).default([]),
	config: z.record(z.string(), z.unknown()).default({}),
});
const palantirProjectConfigSchema = z.object({
	version: z.literal(1).default(1),
	includes: z.array(z.string().min(1)).default([]),
	config: z.record(z.string(), z.unknown()).default({}),
	seerMode: seerModeConfigSchema.optional(),
});

type PalantirConfig = z.output<typeof palantirConfigSchema> & { readonly seerMode?: never };
type PalantirProjectConfig = z.output<typeof palantirProjectConfigSchema>;

type PalantirConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: PalantirConfig;
};

export type PalantirProject = {
	readonly cwd: string;
	readonly projectPath: string;
	readonly projectRoot: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly config: PalantirProjectConfig;
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
	const projectPath = await findNearestPalantirProject(cwd);
	const projectRootConfig = await readPalantirProjectConfigFile(projectPath);
	const configFiles = await loadIncludedPalantirConfigFiles(projectRootConfig, new Set());
	return {
		cwd: resolve(cwd),
		projectPath: projectRootConfig.path,
		projectRoot: projectRootConfig.root,
		configPath: projectRootConfig.path,
		configRoot: projectRootConfig.root,
		config: projectRootConfig.config,
		configFiles,
		projectConfig: mergeProjectConfig(configFiles),
		seerMode: resolveSeerModeConfig({ configPath: projectRootConfig.path, configRoot: projectRootConfig.root, seerMode: projectRootConfig.config.seerMode }),
	};
}

async function findNearestPalantirProject(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		const projectPath = join(current, PALANTIR_PROJECT_FILE_NAME);
		try {
			await access(projectPath);
			return projectPath;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) throw new Error(`Could not find ${PALANTIR_PROJECT_FILE_NAME} from ${cwd}`);
		current = parent;
	}
}

type PalantirProjectConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: PalantirProjectConfig;
};

async function loadIncludedPalantirConfigFiles(projectFile: PalantirProjectConfigFile, visitedPaths: Set<string>): Promise<PalantirConfigFile[]> {
	const includedConfigFiles = await Promise.all(projectFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(projectFile.root, includePath);
		return Promise.all(configPaths.map(readPalantirConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadPalantirConfigTree(includedConfigFile, visitedPaths)));
	return [projectConfigFile(projectFile), ...descendants.flat()];
}

async function loadPalantirConfigTree(configFile: PalantirConfigFile, visitedPaths: Set<string>): Promise<PalantirConfigFile[]> {
	if (visitedPaths.has(configFile.path)) return [];
	visitedPaths.add(configFile.path);
	const includedConfigFiles = await Promise.all(configFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(configFile.root, includePath);
		return Promise.all(configPaths.map(readPalantirConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadPalantirConfigTree(includedConfigFile, visitedPaths)));
	return [configFile, ...descendants.flat()];
}

async function readPalantirProjectConfigFile(path: string): Promise<PalantirProjectConfigFile> {
	const config = palantirProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
	return { path, root: dirname(path), config };
}

async function readPalantirConfigFile(path: string): Promise<PalantirConfigFile> {
	const config = palantirConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
	return { path, root: dirname(path), config };
}

function projectConfigFile(projectFile: PalantirProjectConfigFile): PalantirConfigFile {
	return {
		path: projectFile.path,
		root: projectFile.root,
		config: {
			plugins: [],
			includes: projectFile.config.includes,
			config: projectFile.config.config,
		},
	};
}

async function loadWorkflowPlugins(project: PalantirProject): Promise<LoadedPalantirWorkflowPlugin[]> {
	const plugins: LoadedPalantirWorkflowPlugin[] = [];
	const pluginIds = new Set<string>();
	for (const configFile of project.configFiles) {
		const jiti = createJiti(pathToFileURL(configFile.path).href, { moduleCache: false, virtualModules: palantirWorkflowVirtualModules() });
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

function palantirWorkflowVirtualModules(): Record<string, unknown> {
	return {
		palantir: palantirModule,
		"palantir/api": palantirApiModule,
		"palantir/schema": palantirSchemaModule,
		"palantir/seer": palantirSeerModule,
		typebox: typeboxModule,
		zod: zodModule,
	};
}

function mergeProjectConfig(configFiles: readonly PalantirConfigFile[]): Record<string, unknown> {
	const [projectFile, ...reusableConfigFiles] = configFiles;
	let reusableConfig: Record<string, unknown> = {};
	for (const configFile of reusableConfigFiles) {
		reusableConfig = mergeReusableConfigObjects(reusableConfig, configFile.config.config, ["config"]);
	}
	return mergeProjectConfigObjects(reusableConfig, projectFile?.config.config ?? {});
}

function mergeReusableConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = Object.prototype.hasOwnProperty.call(result, key)
			? mergeReusableConfigValue(result[key], overrideValue, [...path, key])
			: overrideValue;
	}
	return result;
}

function mergeReusableConfigValue(base: unknown, override: unknown, path: readonly string[]): unknown {
	if (isPlainObject(base) && isPlainObject(override)) return mergeReusableConfigObjects(base, override, path);
	if (JSON.stringify(base) === JSON.stringify(override)) return base;
	throw new Error(`Conflicting Palantir reusable config at ${path.join(".")}`);
}

function mergeProjectConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = isPlainObject(result[key]) && isPlainObject(overrideValue)
			? mergeProjectConfigObjects(result[key], overrideValue)
			: overrideValue;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
