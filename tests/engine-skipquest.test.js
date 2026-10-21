'use strict';
// Skipping a quest (Engine.SkipQuest): the player passes on one quest and the
// guide drops it with the quests that follow from it, here and in the guides
// after, the other quests of the same step staying. Saved per character, in
// every guide; the quest may be in the log; bringing it back undoes it all.
// Real Core manifest, stub world.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');
const { TEST_PACK, TEST_SOURCE } = require('./helpers/packs');

const CORE = { name: 'Polestar', files: ['Core/Core.xml'] };

const WORLD = `
local w = stub.world
w.addMap(1429, { name = "Elwynn Forest", c = 0, left = 1500, right = -1500, top = 500, bottom = -1500 })
w.moveTo(1429, 50, 50)
w.race, w.raceName, w.faction, w.class, w.className, w.level = "Human", "Human", "Alliance", "WARRIOR", "Warrior", 10
`;

// A -> B -> C in one guide, D after C in the next one; Other shares A's step.
const GUIDES = `
Polestar.RegisterGuide({ id = "test/c", pack = "test", title = "Chain", faction = "Alliance", minLevel = 1, maxLevel = 20, next = "test/c2", steps = {
	{ goals = { { t = "accept", quest = 1, title = "A", qlvl = 10 }, { t = "accept", quest = 9, title = "Other", qlvl = 10 } } },
	{ goals = { { t = "turnin", quest = 1, title = "A" }, { t = "accept", quest = 2, title = "B", qlvl = 10, pre = { 1 } } } },
	{ goals = { { t = "turnin", quest = 2, title = "B" }, { t = "accept", quest = 3, title = "C", qlvl = 10, pre = { 2 } } } },
	{ goals = { { t = "turnin", quest = 3, title = "C" } } },
	{ goals = { { t = "turnin", quest = 9, title = "Other" } } },
} })
Polestar.RegisterGuide({ id = "test/c2", pack = "test", title = "Chain 2", faction = "Alliance", minLevel = 10, maxLevel = 20, steps = {
	{ goals = { { t = "accept", quest = 4, title = "D", qlvl = 12, pre = { 3 } } } },
	{ goals = { { t = "accept", quest = 8, title = "Unrelated", qlvl = 12 } } },
} })
`;

function run({ before = '', saved, script }) {
	return runAddon({
		stubs: ['stub_world.lua'],
		before: WORLD + before,
		addons: [CORE],
		saved,
		script: `${TEST_PACK}
${TEST_SOURCE}
${GUIDES}
			E = Polestar.Engine
			function flush() stub.advance(0.25) end
			stub.login()
			stub.fire("QUEST_LOG_UPDATE"); stub.advance(0.6)
			-- Each step's statuses, goal by goal ("skipped" for a skipped quest).
			function statuses()
				local out = {}
				for i = 1, #E.GetGuide().steps do
					local g = {}
					for j, v in ipairs(E.GetStepView(i).goals) do g[j] = v.status end
					out[i] = table.concat(g, ",")
				end
				return out
			end
			${script}`,
	}).emitted;
}

test('a skipped quest goes with the quests that follow from it, the rest of its step stays, and it comes back', () => {
	const [out] = run({
		script: `
			E.SetGuide("test/c"); flush()
			E.SkipQuest(1); flush()
			local skipped = { at = E.GetStepIndex(), statuses = statuses(), saved = PolestarCharDB.skippedQuests[1] or false,
				text = E.GetStepView(1).goals[1].unavailableText or false, follow = E.GetStepView(2).goals[2].unavailableText or false }
			E.SkipQuest(1, false); flush()
			emit({ skipped = skipped, back = { at = E.GetStepIndex(), statuses = statuses(), saved = PolestarCharDB.skippedQuests or false } })`,
	});
	assert.deepEqual(out.skipped, {
		at: 1,
		statuses: ['skipped,active', 'skipped,skipped', 'skipped,skipped', 'skipped', 'pending'],
		saved: true,
		text: 'You skipped this quest',
		follow: 'Requires A first',
	}, 'A, B and C go; Other in the same step stays');
	assert.deepEqual(out.back, { at: 1, statuses: ['active,active', 'pending,pending', 'pending,pending', 'pending', 'pending'], saved: false });
});

test('the quests that follow in the next guide go too, and the automation never takes a skipped quest', () => {
	const [out] = run({
		before: 'stub.world.complete({ 9 })',
		script: `
			E.SetGuide("test/c"); flush()
			E.SkipQuest(1); flush()
			local wants = E.WantsQuest("accept", 1)
			stub.world.accept(9, {}, "Other"); flush()
			emit({ wants = wants, guide = E.GetGuide().id, at = E.GetStepIndex() or false, d = E.GetGuide().id == "test/c2" and E.GetStepView(1).goals[1].status or false })`,
	});
	assert.deepEqual(out, { wants: false, guide: 'test/c2', at: 2, d: 'skipped' });
});

test('a quest in the log can be skipped too: the guide stops leading to it, and a reload keeps it skipped', () => {
	const [inLog] = run({
		before: 'stub.world.onQuest(1, {})',
		script: `
			E.SetGuide("test/c"); flush()
			local before = E.GetStepIndex()
			E.SkipQuest(1); flush()
			emit({ before = before, after = E.GetStepIndex(), turnin = E.GetStepView(2).goals[1].status })`,
	});
	assert.deepEqual(inLog, { before: 1, after: 1, turnin: 'skipped' }, 'Other still waits in step 1; the turn-in of A is skipped');

	const [reload] = run({
		saved: { Polestar: 'PolestarCharDB = { schema = 1, tabs = { "test/c" }, activeTab = 1, skippedQuests = { [1] = true } }' },
		script: 'emit({ statuses = statuses(), skipped = E.IsQuestSkipped(1) })',
	});
	assert.deepEqual(reload.statuses.slice(0, 2), ['skipped,active', 'skipped,skipped']);
	assert.equal(reload.skipped, true);
});

test('a skipped quest done anyway counts as done, and its follow-ups come back', () => {
	const [out] = run({
		script: `
			E.SetGuide("test/c"); flush()
			E.SkipQuest(1); flush()
			stub.world.complete({ 1 }); stub.fire("QUEST_LOG_UPDATE"); flush()
			emit({ statuses = statuses() })`,
	});
	assert.deepEqual(out.statuses.slice(0, 3), ['done,active', 'done,pending', 'pending,pending']);
});
