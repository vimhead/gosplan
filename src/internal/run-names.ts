const ADJECTIVES = [
	"able", "amber", "brave", "bright", "calm", "clever", "crisp", "daring", "eager", "fair",
	"fast", "fresh", "gentle", "golden", "grand", "happy", "honest", "jolly", "kind", "lively",
	"lucky", "merry", "nimble", "noble", "patient", "peaceful", "proud", "quiet", "rapid", "ready",
	"royal", "sharp", "silent", "silver", "simple", "steady", "sunny", "swift", "tidy", "vivid",
];

const MODIFIERS = [
	"anchor", "autumn", "brook", "cedar", "cloud", "copper", "dawn", "ember", "field", "forest",
	"harbor", "hazel", "hill", "island", "ivory", "jade", "lake", "maple", "meadow", "moon",
	"north", "ocean", "olive", "pearl", "pine", "rain", "river", "rose", "shadow", "snow",
	"solar", "spring", "stone", "summer", "thunder", "timber", "valley", "violet", "willow", "winter",
];

const NOUNS = [
	"badger", "beacon", "bison", "canvas", "comet", "falcon", "fjord", "fox", "garden", "glade",
	"grove", "heron", "lantern", "lynx", "marker", "otter", "panda", "planet", "prairie", "raven",
	"rocket", "sail", "signal", "sparrow", "summit", "tiger", "trail", "voyage", "whale", "wolf",
	"zephyr", "orchid", "bridge", "castle", "harvest", "mirror", "needle", "quartz", "ripple", "signal",
];

export function generateWorkflowRunName(existingNames: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const name = `${pick(ADJECTIVES)}-${pick(MODIFIERS)}-${pick(NOUNS)}`;
		if (!existingNames.has(name)) return name;
	}
	while (true) {
		const suffix = Math.random().toString(36).slice(2, 6);
		const name = `${pick(ADJECTIVES)}-${pick(MODIFIERS)}-${pick(NOUNS)}-${suffix}`;
		if (!existingNames.has(name)) return name;
	}
}

function pick(values: readonly string[]): string {
	return values[Math.floor(Math.random() * values.length)] ?? values[0];
}
