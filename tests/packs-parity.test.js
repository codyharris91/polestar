'use strict';
// Lint and the runtime refuse the same guides: for every reason
// Polestar.RegisterGuide refuses a guide (Core/Guides.lua validate() and the
// pack rules), a .guide under tests/fixtures/packs/parity/ that lint rejects,
// and its compiled twin (hand-written below) that the runtime refuses. The
// verb reasons are derived by running the validator over its own verb table
// (Guides.VERBS), so a verb or required field added to Core without a fixture
// here fails this test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runAddon } = require('./helpers/lua');
const { DATA_DIR } = require('./helpers/dsl');
const { polestar } = require('./helpers/cli');

const PARITY = path.join(__dirname, 'fixtures', 'packs', 'parity');
const CONTEXT = path.join(__dirname, 'fixtures', 'packs', 'context');

// The registry's refusal of a guide outside its pack's prefix.
const OUTSIDE = 'Guide forever/parity-outside was refused: its id must start with parity/.';

// The runtime's refusal reasons this test covers: { file (under guides/),
// reason (RegisterGuide's error, "step 1 goal 1: " dropped), lint (a message
// lint gives for the file), goal (the compiled goal, Lua) | def (the whole
// compiled guide, Lua, without id/pack/title) | id }.
const CASES = [
	{ file: 'accept-quest', reason: 'accept needs quest', lint: /`accept` needs a quest id/, goal: '{ t = "accept", title = "A Threat Within" }' },
	{ file: 'accept-title', reason: 'accept needs title', lint: /quest 999999 is not in data/, goal: '{ t = "accept", quest = 999999 }' },
	{ file: 'turnin-quest', reason: 'turnin needs quest', lint: /`turnin` needs a quest id/, goal: '{ t = "turnin", title = "A Threat Within" }' },
	{ file: 'turnin-title', reason: 'turnin needs title', lint: /quest 999999 is not in data/, goal: '{ t = "turnin", quest = 999999 }' },
	{ file: 'abandon-quest', reason: 'abandon needs quest', lint: /`abandon` needs a quest id/, goal: '{ t = "abandon", title = "A Threat Within" }' },
	{ file: 'abandon-title', reason: 'abandon needs title', lint: /quest 999999 is not in data/, goal: '{ t = "abandon", quest = 999999 }' },
	{ file: 'destroy-item', reason: 'destroy needs item', lint: /`destroy` needs an item id/, goal: '{ t = "destroy", itemName = "Hearthstone" }' },
	{ file: 'destroy-itemname', reason: 'destroy needs itemName', lint: /item 999999 is not in data/, goal: '{ t = "destroy", item = 999999 }' },
	{ file: 'complete-quest', reason: 'complete needs quest', lint: /`complete` needs a quest id/, goal: '{ t = "complete", title = "A Threat Within" }' },
	{ file: 'complete-title', reason: 'complete needs title', lint: /quest 999999 is not in data/, goal: '{ t = "complete", quest = 999999 }' },
	{ file: 'kill-target', reason: 'kill needs target', lint: /`kill` needs an npc id or "Target name"/, goal: '{ t = "kill" }' },
	{ file: 'collect-item', reason: 'collect needs item', lint: /`collect` needs an item id/, goal: '{ t = "collect", itemName = "Linen Cloth" }' },
	{ file: 'collect-itemname', reason: 'collect needs itemName', lint: /item 999999 is not in data/, goal: '{ t = "collect", item = 999999 }' },
	{ file: 'goto-map', reason: 'goto needs map', lint: /coordinates need a zone/, goal: '{ t = "goto", x = 50, y = 50 }' },
	{ file: 'goto-x', reason: 'goto needs x', lint: /malformed coordinates ",50"/, goal: '{ t = "goto", map = 1429, y = 50 }' },
	{ file: 'goto-y', reason: 'goto needs y', lint: /malformed coordinates "50,"/, goal: '{ t = "goto", map = 1429, x = 50 }' },
	{ file: 'talk-npc', reason: 'talk needs npc', lint: /`talk` needs an npc id/, goal: '{ t = "talk", npcName = "Marshal McBride" }' },
	{ file: 'talk-npcname', reason: 'talk needs npcName', lint: /npc 999999 is not in data/, goal: '{ t = "talk", npc = 999999 }' },
	{ file: 'interact-object', reason: 'interact needs object', lint: /`interact` needs an object id/, goal: '{ t = "interact", objName = "Kobold Crate" }' },
	{ file: 'interact-objname', reason: 'interact needs objName', lint: /object 999999 is not in data/, goal: '{ t = "interact", object = 999999 }' },
	{ file: 'use-item', reason: 'use needs item', lint: /`use` needs an item id/, goal: '{ t = "use", itemName = "Hearthstone" }' },
	{ file: 'use-itemname', reason: 'use needs itemName', lint: /item 999999 is not in data/, goal: '{ t = "use", item = 999999 }' },
	{ file: 'sethome-location', reason: 'sethome needs location', lint: /`sethome` needs a "Location" or `nearest`/, goal: '{ t = "sethome" }' },
	{ file: 'hearth-location', reason: 'hearth needs location', lint: /`hearth` needs a "Location"/, goal: '{ t = "hearth" }' },
	{ file: 'getfp-location', reason: 'getfp needs location', lint: /`getfp` needs a "Location"/, goal: '{ t = "getfp" }' },
	{ file: 'fly-location', reason: 'fly needs location', lint: /`fly` needs a "Location"/, goal: '{ t = "fly" }' },
	{ file: 'enter-location', reason: 'enter needs location', lint: /`enter` needs a "Location"/, goal: '{ t = "enter" }' },
	{ file: 'buy-item', reason: 'buy needs item', lint: /`buy` needs an item id/, goal: '{ t = "buy", itemName = "Refreshing Spring Water" }' },
	{ file: 'buy-itemname', reason: 'buy needs itemName', lint: /item 999999 is not in data/, goal: '{ t = "buy", item = 999999 }' },
	{ file: 'level-level', reason: 'level needs level', lint: /malformed level ""/, goal: '{ t = "level" }' },
	{ file: 'money-money', reason: 'money needs money', lint: /malformed amount ""/, goal: '{ t = "money" }' },
	{ file: 'task-text', reason: 'task needs text', lint: /`task` needs text/, goal: '{ t = "task" }' },
	{ file: 'note-text', reason: 'note needs text', lint: /`note` needs text/, goal: '{ t = "note" }' },
	{ file: 'skill-skill', reason: 'skill needs skill', lint: /`skill` needs a profession and a rank/, goal: '{ t = "skill", level = 75 }' },
	{ file: 'skill-level', reason: 'skill needs level', lint: /`skill` needs a profession and a rank/, goal: '{ t = "skill", skill = "First Aid" }' },
	{ file: 'learn-spell', reason: 'learn needs spell', lint: /`learn` needs a spell id/, goal: '{ t = "learn", spellName = "First Aid" }' },
	{ file: 'learn-spellname', reason: 'learn needs spellName', lint: /spell 999999 is not in data/, goal: '{ t = "learn", spell = 999999 }' },
	{ file: 'cast-spell', reason: 'cast needs spell', lint: /`cast` needs a spell id/, goal: '{ t = "cast", spellName = "Basic Campfire" }' },
	{ file: 'cast-spellname', reason: 'cast needs spellName', lint: /spell 999999 is not in data/, goal: '{ t = "cast", spell = 999999 }' },
	{ file: 'craft-spell', reason: 'craft needs spell', lint: /`craft` needs a spell id/, goal: '{ t = "craft", spellName = "Linen Bandage" }' },
	{ file: 'craft-spellname', reason: 'craft needs spellName', lint: /spell 999999 is not in data/, goal: '{ t = "craft", spell = 999999 }' },
	{ file: 'rep-faction', reason: 'rep needs faction', lint: /unknown faction "Made Up"/, goal: '{ t = "rep", factionName = "Made Up", standing = 5 }' },
	{ file: 'rep-factionname', reason: 'rep needs factionName', lint: /faction 999999 is not in data/, goal: '{ t = "rep", faction = 999999, standing = 5 }' },
	{ file: 'rep-standing', reason: 'rep needs standing', lint: /`rep` needs a faction and a standing/, goal: '{ t = "rep", faction = 69, factionName = "Darnassus" }' },
	{ file: 'explore-map', reason: 'explore needs map', lint: /coordinates need a zone/, goal: '{ t = "explore", x = 50, y = 50 }' },
	{ file: 'explore-x', reason: 'explore needs x', lint: /malformed coordinates ",50"/, goal: '{ t = "explore", map = 1429, y = 50 }' },
	{ file: 'explore-y', reason: 'explore needs y', lint: /malformed coordinates "50,"/, goal: '{ t = "explore", map = 1429, x = 50 }' },
	{ file: 'achieve-achievement', reason: 'achieve needs achievement', lint: /`achieve` needs an achievement id/, goal: '{ t = "achieve", achievementName = "Level 10" }' },
	{ file: 'achieve-achievementname', reason: 'achieve needs achievementName', lint: /achievement 999999 has no reference data/, goal: '{ t = "achieve", achievement = 999999 }' },
	// Not derived from the verb table: the rest of the runtime's rules.
	{ file: 'unknown-verb', reason: 'unknown verb fish', lint: /unknown verb "fish"/, goal: '{ t = "fish" }' },
	{ file: 'coords-range', reason: 'coordinates outside 0-100', lint: /coordinates 150,50 are outside 0-100/, goal: '{ t = "goto", map = 1429, x = 150, y = 50 }' },
	{ file: 'step-no-goals', reason: 'step 1 has no goals', lint: /step has no goals/, def: '{ steps = { { goals = {} }, { goals = { { t = "level", level = 2 } } } } }' },
	{ file: 'step-image', reason: 'step 1: bad image', lint: /image path "\.\.\/outside\.tga" leaves the pack folder/, def: '{ steps = { { image = { file = "..\\\\outside" }, goals = { { t = "level", level = 2 } } } } }' },
	{ file: 'guide-no-steps', reason: 'no steps', lint: /guide has no steps/, def: '{ steps = {} }' },
	{ file: 'id-outside', reason: OUTSIDE, lint: /is outside pack "parity"/, id: 'forever/parity-outside' },
];

// Generic reasons the runtime gives whatever the verb table holds; every
// other goal-level reason is derived from Guides.VERBS below.
const GENERIC = ['unknown verb fish', 'coordinates outside 0-100', 'step 1 has no goals', 'step 1: bad image', 'no steps', OUTSIDE];

// Lua: the runtime's verb reasons, derived from Guides.VERBS: for each verb a
// goal with every required field filled (its own checker picks a number or
// a string), then that goal without each field in turn; a filled goal that
// still fails gives its own reason (sethome's location rule).
const DERIVE = `
local G = Polestar.Guides
local function wrap(goal) return { id = "parity/x", title = "x", steps = { { goals = { goal } } } } end
local function reasonOf(goal)
	local err = G.Validate(wrap(goal))
	return err and (err:gsub("^step 1 goal 1: ", "")) or nil
end
local out = {}
for verb, rules in pairs(G.VERBS) do
	local filled = { t = verb }
	for field, check in pairs(rules) do filled[field] = check(1) and 1 or "x" end
	local own = reasonOf(filled)
	if own then out[#out + 1] = own end
	for field in pairs(rules) do
		local goal = {}
		for k, v in pairs(filled) do goal[k] = v end
		goal[field] = nil
		out[#out + 1] = reasonOf(goal) or (verb .. " accepts a goal without " .. field)
	end
end
table.sort(out)
emit(out)
`;

function compiledDef(c) {
	if (c.id) return `{ id = "${c.id}", pack = "parity", title = "T", steps = { { goals = { { t = "level", level = 2 } } } } }`;
	const id = `"parity/${c.file}"`;
	if (c.def) return `(function() local d = ${c.def}; d.id = ${id}; d.pack = "parity"; d.title = "T"; return d end)()`;
	return `{ id = ${id}, pack = "parity", title = "T", steps = { { goals = { { t = "level", level = 2 }, ${c.goal} } } } }`;
}

function runtime() {
	const register = CASES.map((c) => `do local ok, err = Polestar.RegisterGuide(${compiledDef(c)}); refused[#refused + 1] = { ok = ok, err = err } end`).join('\n');
	const script = `
assert(Polestar.RegisterPack({ addon = "ParityAddon", id = "parity", format = 1, title = "Parity", author = "Tests", version = "1.0.0", license = "CC0-1.0" }))
${DERIVE}
refused = {}
${register}
emit(refused)
`;
	const [derived, refused] = runAddon({ addons: [{ name: 'Polestar', files: ['Core/Core.xml'] }], login: false, script }).emitted;
	return { derived, refused };
}

test('every refusal reason of the runtime has a parity fixture', () => {
	const { derived } = runtime();
	const covered = new Set(CASES.map((c) => c.reason));
	const missing = [...derived, ...GENERIC].filter((r) => !covered.has(r));
	assert.deepEqual(missing, [], 'Core/Guides.lua refuses guides for these reasons, but tests/fixtures/packs/parity/ has no fixture for them');
	// Every verb case is one the runtime still gives.
	const known = new Set([...derived, ...GENERIC]);
	assert.deepEqual(CASES.filter((c) => !known.has(c.reason)).map((c) => c.reason), []);
});

test('the runtime refuses each compiled twin for its reason', () => {
	const { refused } = runtime();
	assert.equal(refused.length, CASES.length);
	CASES.forEach((c, i) => {
		assert.equal(refused[i].ok, false, `${c.file}: the runtime accepted it`);
		assert.equal(String(refused[i].err).replace(/^step 1 goal \d+: /, ''), c.reason, c.file);
	});
});

test('lint rejects each parity fixture for the matching reason', () => {
	const files = fs.readdirSync(path.join(PARITY, 'guides')).sort();
	assert.deepEqual(files, CASES.map((c) => `${c.file}.guide`).sort(), 'one fixture per case, no strays');
	const r = polestar(['lint', '--pack', PARITY, '--data', DATA_DIR, '--context', CONTEXT, '--context-data', DATA_DIR, '--format', 'json']);
	assert.equal(r.status, 1, r.stderr);
	const doc = JSON.parse(r.stdout);
	for (const c of CASES) {
		const errors = doc.diagnostics.filter((d) => d.severity === 'error' && path.basename(d.file) === `${c.file}.guide`);
		assert.ok(errors.some((d) => c.lint.test(d.message)), `${c.file}.guide: lint gave ${JSON.stringify(errors.map((d) => d.message))}`);
	}
});
