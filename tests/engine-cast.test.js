'use strict';
// `cast <spellId>` during play (addon/Polestar/Core/Engine.lua,
// Own.latchCast): the player's own successful cast of that spell
// (UNIT_SPELLCAST_SUCCEEDED) ticks the goal while it is open, in the step
// the guide is at or an along step listed under it. A cast before that, or
// of another spell, or by another unit, does not count. Real Core manifest,
// stub world (a level 1 Human Warrior in Elwynn Forest), as
// tests/engine-when-dungeon.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');
const { TEST_PACK, TEST_SOURCE } = require('./helpers/packs');

const CORE = { name: 'Polestar', files: ['Core/Core.xml'] };

const WORLD = `
local w = stub.world
w.addMap(1429, { name = "Elwynn Forest", c = 0, left = 1500, right = -1500, top = 500, bottom = -1500 })
w.moveTo(1429, 48, 42)
w.titles[783] = "A Threat Within"
w.onQuest(783, {})
`;

// Step 1 waits on a task, step 2 is the campfire, step 3 hands in A Threat Within.
const GUIDE = `
Polestar.RegisterGuide({
	id = "test/cast", pack = "test", title = "Cast", minLevel = 1, maxLevel = 10,
	steps = {
		{ title = "First", goals = { { t = "task", text = "Gather wood" } } },
		{ title = "Campfire", goals = { { t = "cast", spell = 818, spellName = "Basic Campfire" } } },
		{ title = "Marshal McBride", goals = {
			{ t = "turnin", quest = 783, title = "A Threat Within", npc = 197, npcName = "Marshal McBride", map = 1429, x = 48.9, y = 41.6 },
		} },
	},
})
`;

function run({ guide = GUIDE, script }) {
	return runAddon({
		stubs: ['stub_world.lua'],
		before: WORLD,
		addons: [CORE],
		saved: { Polestar: 'PolestarCharDB = { schema = 1, guide = "test/cast" }' },
		script: `${TEST_PACK}
${TEST_SOURCE}\n${guide}\nE = Polestar.Engine\nfunction flush() stub.advance(0.25) end\nstub.login()\nstub.fire("QUEST_LOG_UPDATE"); stub.advance(0.6)\n${script}`,
	}).emitted;
}

test('a cast before the goal is open does not count; once open, only that spell by the player ticks it', () => {
	const [rows] = run({ script: `
		local out = {}
		stub.world.cast(818); flush()
		out.early = { E.GetLiveStep() }
		E.ToggleGoal(1, 1); flush()
		out.open = E.GetLiveStep()
		stub.world.cast(133); flush()
		stub.fire("UNIT_SPELLCAST_SUCCEEDED", "target", "Cast-3-0-0-0-818-0", 818); flush()
		out.other = E.GetLiveStep()
		local text = E.GetStepView(2).goals[1]
		out.text = { text.verb, text.subject }
		stub.world.cast(818); flush()
		out.cast = E.GetLiveStep()
		stub.fire("PLAYER_LOGOUT")
		out.saved = PolestarCharDB.manual["test/cast"]["2:1"] or false
		emit(out)
	` });
	assert.deepEqual(rows.early, [1], 'step 1 still waits: the early cast did not tick step 2');
	assert.equal(rows.open, 2);
	assert.equal(rows.other, 2, 'another spell, or another unit, does not count');
	assert.deepEqual(rows.text, ['Cast', 'Basic Campfire']);
	assert.equal(rows.cast, 3);
	assert.equal(rows.saved, true, 'the tick is kept per character');
});

test('an along step listed under the live step is ticked by the cast too', () => {
	// Step 1 (the campfire, along until step 3) is listed under step 2, where the guide is.
	const guide = `
Polestar.RegisterGuide({
	id = "test/cast", pack = "test", title = "Cast", minLevel = 1, maxLevel = 10,
	steps = {
		{ title = "Campfire", along = "end", goals = { { t = "cast", spell = 818, spellName = "Basic Campfire" } } },
		{ title = "First", goals = { { t = "task", text = "Gather wood" } } },
		{ title = "Marshal McBride", label = "end", goals = {
			{ t = "turnin", quest = 783, title = "A Threat Within", npc = 197, npcName = "Marshal McBride", map = 1429, x = 48.9, y = 41.6 },
		} },
	},
})
`;
	const [rows] = run({ guide, script: 'local before = E.GetStepView(1).goals[1].status; stub.world.cast(818); flush(); emit({ before, after = E.GetStepView(1).goals[1].status })' });
	assert.notEqual(rows.before, 'done');
	assert.equal(rows.after, 'done');
});

test('Guides.Validate takes `cast` with a spell and a name, and refuses one without', () => {
	const [rows] = runAddon({
		stubs: ['stub_world.lua'],
		addons: [CORE],
		script: `
			local V = Polestar.Guides.Validate
			local function g(goal) return { id = "t/v", pack = "test", title = "V", minLevel = 1, maxLevel = 10, steps = { { goals = { goal } } } } end
			emit({ ok = V(g({ t = "cast", spell = 818, spellName = "Basic Campfire" })) or "ok", none = V(g({ t = "cast", spellName = "Basic Campfire" })) or "ok" })
		`,
	}).emitted;
	assert.equal(rows.ok, 'ok');
	assert.match(rows.none, /cast needs spell/);
});
