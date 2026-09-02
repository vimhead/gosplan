import type { NornBuildInfo } from "./build-info.ts";

export const NORN_GENERATED_BUILD_INFO = {
	kind: "unknown",
	version: "0.1.0",
	commit: null,
	upgrade: {
		supported: false,
		reason: "This Norn build does not include upgrade metadata.",
	},
} as const satisfies NornBuildInfo;
