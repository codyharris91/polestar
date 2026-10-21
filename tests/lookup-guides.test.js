'use strict';
// Guides Lookup builds on the spot (Lookup.Guide) are played to the end in
// the real engine with the shared guide simulator (tools/lib/playtest.js):
// a vendor mount, a drop, a treasure, a dungeon drop, a quest reward behind a
// prerequisite chain, a craft, a reputation reward, and the NPC, quest and
// dungeon kinds. Every one must finish without a stuck step and without an
// accept or turn-in that has no location.
//
// The Codex is the synthetic tests/fixtures/codex/lookup.json. With
// data/forever/map-frames.json present its three maps are moved onto real
// maps with their Era frames (Elwynn Forest, Westfall, Teldrassil); without
// it the fixture's own synthetic frames are used.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runAddon, ROOT } = require('./helpers/lua');
const { writeCodexPack } = require('./helpers/codex');
const { SIMULATE, luaValue } = require('../tools/lib/playtest');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex', 'lookup.json');
const FRAMES = path.join(ROOT, 'data', 'forever', 'map-frames.json');
const REAL = { 9001: 1429, 9002: 1436, 9003: 1438 };

// The fixture, with its maps moved onto real ones when their frames exist.
function loadCodex() {
	const codex = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	let era = null;
	if (fs.existsSync(FRAMES)) era = JSON.parse(fs.readFileSync(FRAMES, 'utf8')).era || null;
	if (!era || !Object.values(REAL).every((id) => era[id])) return codex;
	const moved = (id) => REAL[id] || id;
	const walk = (v) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (v && typeof v === 'object') {
			if (typeof v.map === 'number') v.map = moved(v.map);
			Object.values(v).forEach(walk);
		}
	};
	walk(codex.npcs);
	walk(codex.objects);
	walk(codex.instances);
	walk(codex.quests);
	for (const q of Object.values(codex.quests)) q.zone = moved(q.zone);
	codex.frames = Object.fromEntries(Object.keys(codex.frames).map((id) => [moved(Number(id)), era[moved(Number(id))]]));
	codex.zones = Object.fromEntries(Object.values(codex.zones).map((z) => [moved(z.id), { id: moved(z.id), name: z.name }]));
	return codex;
}

const codex = loadCodex();
const HOME = Object.keys(codex.frames).map(Number).sort((a, b) => a - b)[0];
// #610: a mob spawning at three places far apart, near the giver and across the map.
const CREEPERS = [[50, 52], [20, 70], [24, 78]];
codex.npcs[5014] = { id: 5014, name: 'Marsh Creeper', level: 19, levelMax: 20, faction: null, rare: false, elite: false, boss: false, instance: null, roles: [],
	spawns: CREEPERS.map(([x, y]) => ({ map: HOME, x, y, f: 'e' })) };
codex.quests[7010] = { id: 7010, title: 'Creepers in the Marsh', level: 18, minLevel: 15, faction: 'A', races: null, classes: null,
	start: { npc: [5008], object: [], item: [] }, end: { npc: [5008], object: [] },
	objectives: [{ type: 'kill', id: 5014, count: 6, text: 'Marsh Creeper' }], pre: [], preAny: [], zone: HOME, rewards: [], choices: [] };
const MAPS = Object.entries(codex.frames)
	.map(([id, f]) => `w.addMap(${id}, { name = ${JSON.stringify(codex.zones[id].name)}, c = ${f.c}, left = ${f.left}, right = ${f.right}, top = ${f.top}, bottom = ${f.bottom} })`)
	.join('\n');

let pack;
before(() => {
	pack = writeCodexPack(codex);
});
after(() => pack && pack.cleanup());

// Builds and opens the guide, describes it, then plays it to the end.
function play(kind, id, { level = 20, setup = '' } = {}) {
	const [built, out] = runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = ${level}
w.moveTo(${HOME}, 50, 50)
${setup}`,
		addons: ['Polestar'],
		script: `
stub.login()
Polestar.Set("behavior.autoNextGuide", false)
local id, why = Polestar.Lookup.Guide(${luaValue(kind)}, ${luaValue(id)})
local g = id and Polestar.Guides.Get(id)
local steps = {}
if g then
	for i, s in ipairs(g.steps) do
		local verbs = {}
		for j, goal in ipairs(s.goals) do verbs[j] = goal.t end
		steps[i] = { title = s.title, goals = table.concat(verbs, " ") }
	end
end
emit({ id = id or false, why = why or false, active = Polestar.Engine.GetGuide() and Polestar.Engine.GetGuide().id or false, steps = steps })
stub.advance(0.6)
${SIMULATE}`,
	}).emitted;
	return { built, out };
}

function assertPlays(kind, id, steps, opts) {
	const { built, out } = play(kind, id, opts);
	const gid = `lookup/${kind}/${id}`;
	assert.deepEqual({ id: built.id, active: built.active }, { id: gid, active: gid }, `guide built (${built.why})`);
	assert.deepEqual(built.steps, steps);
	assert.ok(!out.stuck, `stuck: ${JSON.stringify(out.stuck)}`);
	assert.equal(out.done, true);
	assert.deepEqual(out.missing, {}, 'every accept and turn-in has a location');
	assert.equal(out.visited, steps.length);
}

test('a vendor mount: go to the vendor and buy it', () => {
	assertPlays('mount', 8000, [{ title: 'Mira Saddler', goals: 'goto buy' }]);
});

test('a drop: go to the mob, kill it, loot the item', () => {
	assertPlays('item', 8004, [{ title: 'Bristle Boar', goals: 'goto kill collect' }]);
});

test('a treasure: go to the chest and loot it', () => {
	assertPlays('item', 8009, [{ title: 'Weathered Chest', goals: 'goto interact collect' }]);
});

test('a dungeon drop: the entrance first, then the boss', () => {
	assertPlays('item', 8008, [
		{ title: 'Ashen Crypt', goals: 'goto' },
		{ title: 'Lord Ashcroft', goals: 'kill collect' },
	]);
});

test('a quest reward: every prerequisite, one of the any-of ones this character can take, then the quest', () => {
	assertPlays('item', 8001, [
		{ title: 'Trouble in the Vale', goals: 'accept kill collect turnin' },
		{ title: 'Alliance Errand', goals: 'accept turnin' },
		{ title: "The Saddler's Request", goals: 'accept interact complete turnin collect' },
	]);
	// Finished prerequisites are left out.
	assertPlays('item', 8001, [
		{ title: 'Alliance Errand', goals: 'accept turnin' },
		{ title: "The Saddler's Request", goals: 'accept interact complete turnin collect' },
	], { setup: 'w.complete({ 7001 })' });
});

test('an event objective (explore, report) is placed where the data puts it, not at the giver (#515)', () => {
	const [goal] = runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = 20
w.moveTo(${HOME}, 50, 50)`,
		addons: ['Polestar'],
		script: `
stub.login()
local id = Polestar.Lookup.Guide("item", 8001)
for _, s in ipairs(Polestar.Guides.Get(id).steps) do
	for _, g in ipairs(s.goals) do
		if g.t == "complete" and g.quest == 7002 then emit({ map = g.map or false, x = g.x or false, y = g.y or false, f = g.f or false }) end
	end
end`,
	}).emitted;
	assert.deepEqual(goal, { map: codex.quests[7002].objectives[1].map, x: 66, y: 40, f: 'e' });
});

test('a beast to tame (Taming the Beast) reads "Tame", not "Kill", and still plays (#565)', () => {
	assertPlays('quest', 7009, [{ title: 'Taming the Beast', goals: 'accept kill turnin' }]);
	const texts = (quest) => runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = 20
w.moveTo(${HOME}, 50, 50)`,
		addons: ['Polestar'],
		script: `
stub.login()
Polestar.Set("behavior.autoNextGuide", false)
Polestar.Lookup.Guide("quest", ${quest})
local view = Polestar.Engine.GetStepView(1)
for _, g in ipairs(view.goals) do
	if g.t == "kill" then emit(g.text) end
end`,
	}).emitted;
	assert.deepEqual(texts(7009), ['Tame Bristle Boar']);
	assert.deepEqual(texts(7001), ['Kill Kobold Digger'], 'a plain kill objective still reads "Kill"');
});

test('a craft: learn the profession at its trainer, skill up, learn the recipe, craft', () => {
	assertPlays('item', 8005, [{ title: 'Tailoring', goals: 'train skill learn craft' }]);
	assertPlays('item', 8005, [{ title: 'Tailoring', goals: 'learn craft' }], { setup: 'w.learnSkill(197, "Tailoring", 120, 150)' });
});

test('a reputation reward: reach the standing, then buy it from the quartermaster', () => {
	assertPlays('tabard', 8006, [
		{ title: 'Vale Wardens', goals: 'rep' },
		{ title: 'Quartermaster Ilsa', goals: 'goto buy' },
	]);
});

test('a vendor item behind a standing or a skill rank: reach it first, then buy', () => {
	assertPlays('mount', 8016, [
		{ title: 'Vale Wardens', goals: 'rep' },
		{ title: 'Quartermaster Ilsa', goals: 'goto buy' },
	]);
	assertPlays('recipe', 8017, [
		{ title: 'Tailoring', goals: 'skill' },
		{ title: 'Mira Saddler', goals: 'goto buy' },
	], { setup: 'w.learnSkill(197, "Tailoring", 60, 150)' });
});

test('NPC, quest and dungeon lookups lead there', () => {
	assertPlays('rare', 5011, [{ title: 'Gnash the Unseen', goals: 'goto kill' }]);
	assertPlays('quest', 7001, [{ title: 'Trouble in the Vale', goals: 'accept kill collect turnin' }]);
	assertPlays('instance', 'ashen_crypt', [{ title: 'Ashen Crypt', goals: 'goto' }]);
});

// Tazul (#610): a Lookup quest step sent the arrow for a kill objective to the
// one spawn nearest the giver, with no other places to move on to, while most
// of the mobs were elsewhere. Its kill, collect and interact goals now carry
// every Codex spawn of the target as spawn areas (`spots`), as compiled guide
// goals do, so the arrow takes the place where the player is.
test("Tazul's report (#610): a Lookup quest objective lists every place its mob spawns, and the arrow takes the one the player is at", () => {
	const [out] = runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = 20
w.onQuest(7010, { { text = "Marsh Creeper slain: 0/6", required = 6 } }, "Creepers in the Marsh")
w.moveTo(${HOME}, 21, 71)`,
		addons: ['Polestar'],
		script: `
stub.login()
Polestar.Set("behavior.autoNextGuide", false)
local id = Polestar.Lookup.Guide("quest", 7010)
local kill
for _, s in ipairs(Polestar.Guides.Get(id).steps) do
	for _, g in ipairs(s.goals) do
		if g.t == "kill" and g.npc == 5014 then kill = g end
	end
end
stub.advance(0.6)
local p = Polestar.Engine.GetWaypoint()
local spots = {}
for i, s in ipairs(kill.spots or {}) do spots[i] = { x = s.x, y = s.y } end
emit({ x = kill.x, y = kill.y, spread = kill.spread or false, spots = spots, arrow = p and { kind = p.kind, x = p.x, y = p.y } or false })`,
	}).emitted;
	assert.deepEqual({ x: out.x, y: out.y }, { x: 50, y: 52 }, 'the goal keeps the spawn nearest the giver as its point');
	const key = ({ x, y }) => `${x},${y}`;
	const spots = Array.isArray(out.spots) ? out.spots : []; // an empty Lua table comes back as {}
	assert.deepEqual(spots.map(key).sort(), CREEPERS.map(([x, y]) => key({ x, y })).sort(), 'every place the mob spawns is a spot');
	assert.equal(key(spots[0]), '50,52', 'the search starts at the goal point');
	assert.equal(out.spread, true, 'places this far apart are searched one after another');
	assert.deepEqual(out.arrow, { kind: 'kill', x: 20, y: 70 }, 'the arrow takes the place the player stands at');
});
