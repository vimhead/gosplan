import { NORN_GENERATED_BUILD_INFO } from "./generated-build-info.ts";

export type NornBuildInfo = NornUnknownBuildInfo | NornNpmGitGlobalBuildInfo | NornGithubReleaseBinaryBuildInfo;

export type NornUnknownBuildInfo = {
	readonly kind: "unknown";
	readonly version: string;
	readonly commit: string | null;
	readonly upgrade: {
		readonly supported: false;
		readonly reason: string;
	};
};

export type NornNpmGitGlobalBuildInfo = {
	readonly kind: "npm-git-global";
	readonly version: string;
	readonly commit: string | null;
	readonly repository: string;
	readonly packageSpec: string;
	readonly upgradeCommand: readonly string[];
};

export type NornGithubReleaseBinaryBuildInfo = {
	readonly kind: "github-release-binary";
	readonly version: string;
	readonly commit: string | null;
	readonly repository: string;
	readonly releaseTag: string;
	readonly assetName: string;
	readonly checksumAssetName: string;
};

export const NORN_BUILD_INFO: NornBuildInfo = NORN_GENERATED_BUILD_INFO;
