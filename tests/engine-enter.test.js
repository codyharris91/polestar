'use strict';
// `enter "<Place>"` during play (addon/Polestar/Core/Engine.lua): done while
// the zone or subzone text reads the place (inPlace, as for `hearth`), kept
// once the live step had it, so walking out again does not reopen it.
// Coordinates only point the arrow. Real Core manifest, stub world (a level 1
// Human Warrior in Elwynn Forest), as tests/engine-when-dungeon.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');
const { TEST_PACK, TEST_SOURCE } = require('./helpers/packs');

const CORE = { name: 'Polestar', files: ['Core/Core.xml'] };

const WORLD = `
local w = stub.world
w.addMap(1429, { name = "Elwynn Forest", c = 0, left = 1500, right = -1500, top = 500, bottom = -1500 })
w.moveTo(1429, 48, 42)
w.setZone("Elwynn Forest", "Northshire Valley")
w.titles[783] = "A Threat Within"
w.onQuest(783, {})
`;

// Step 1 goes to Goldshire (an area, with a point for the arrow), step 2 to
// Westfall (a zone), step 3 hands in A Threat Within.
const GUIDE = `
Polestar.RegisterGuide({
	id = "test/enter", pack = "test", title = "Enter", minLevel = 1, maxLevel = 10,
	steps = {
		{ title = "Goldshire", goals = { { t = "enter", location = "Goldshire", map = 1429, x = 42.1, y = 65.9 } } },
		{ title = "Westfall", goals = { { t = "enter", location = "Westfall" } } },
		{ title = "Marshal McBride", goals = {
			{ t = "turnin", quest = 783, title = "A Threat Within", npc = 197, npcName = "Marshal McBride", map = 1429, x = 48.9, y = 41.6 },
		} },
	},
})
`;

function run(script) {
	return runAddon({
		stubs: ['stub_world.lua'],
		before: WORLD,
		addons: [CORE],
		saved: { Polestar: 'PolestarCharDB = { schema = 1, guide = "test/enter" }' },
		script: `${TEST_PACK}
${TEST_SOURCE}\n${GUIDE}\nE = Polestar.Engine\nfunction flush() stub.advance(0.25) end\nstub.login()\nstub.fire("QUEST_LOG_UPDATE"); stub.advance(0.6)\n${script}`,
	}).emitted;
}

test('`enter` is done once the subzone or zone text reads the place, and stays done', () => {
	const [rows] = run(`
		local out = { start = E.GetLiveStep() }
		local wp = E.GetWaypoint()
		out.arrow = wp and { wp.map, wp.x, wp.y } or false
		stub.world.setZone("Elwynn Forest", "Goldshire"); flush()
		out.area = E.GetLiveStep()
		stub.world.setZone("Elwynn Forest", "Brackwell Pumpkin Patch"); flush()
		out.left = { E.GetLiveStep(), E.GetStepView(1).status }
		stub.world.setZone("Westfall", ""); flush()
		out.zone = E.GetLiveStep()
		emit(out)
	`);
	assert.equal(rows.start, 1);
	assert.deepEqual(rows.arrow, [1429, 42.1, 65.9], 'the coordinates point the arrow');
	assert.equal(rows.area, 2, 'in Goldshire: step 1 is done');
	assert.deepEqual(rows.left, [2, 'done'], 'walking on does not reopen it');
	assert.equal(rows.zone, 3, 'in Westfall, a zone: step 2 is done');
});

test('Guides.Validate takes `enter` with a location, and refuses it without', () => {
	const [rows] = runAddon({
		stubs: ['stub_world.lua'],
		addons: [CORE],
		script: `
			local V = Polestar.Guides.Validate
			local function g(goal) return { id = "t/v", pack = "test", title = "V", minLevel = 1, maxLevel = 10, steps = { { goals = { goal } } } } end
			emit({ ok = V(g({ t = "enter", location = "Goldshire", area = 87 })) or "ok", none = V(g({ t = "enter" })) or "ok" })
		`,
	}).emitted;
	assert.equal(rows.ok, 'ok');
	assert.match(rows.none, /enter needs location/);
});
