'use strict';
// The `abandon` and `destroy` goals (docs/GUIDE_FORMAT.md): parsing, resolving,
// emitting and the pack format they need.
// Fixture data: tests/fixtures/dsl/data (Elwynn Forest, uiMapID 1429).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseGuide } = require('../tools/lib/dsl/parse');
const { Diagnostics } = require('../tools/lib/dsl/diag');
const { emitGuides } = require('../tools/lib/dsl/emit');
const { formatFor, FORMAT, MONEY_TASK_FORMAT } = require('../tools/lib/pack/format');
const { readManifest } = require('../tools/lib/pack/manifest');
const { compileProject } = require('../tools/lib/dsl/project');
const { compile, guideText, lineOf, plain, DATA_DIR } = require('./helpers/dsl');

function parse(text) {
	const diag = new Diagnostics();
	const ast = parseGuide(text, 'x.guide', diag);
	return { ast, errors: diag.sorted().filter((d) => d.severity === 'error').map((d) => `${d.line}: ${d.message}`) };
}

test('`abandon` and `destroy` parse into goals; a missing or malformed id is an error at its line', () => {
	const { ast, errors } = parse(guideText(['step One', '  abandon 783 "A Threat Within"', '  destroy 159 "Refreshing Spring Water" optional']));
	assert.deepEqual(errors, []);
	const [abandon, destroy] = ast.steps[0].goals;
	assert.deepEqual([abandon.verb, abandon.quest, abandon.title], ['abandon', 783, 'A Threat Within']);
	assert.deepEqual([destroy.verb, destroy.item, destroy.itemName, destroy.optional], ['destroy', 159, 'Refreshing Spring Water', true]);
	for (const [line, message] of Object.entries({ '  abandon x': 'malformed quest id "x"', '  destroy': '`destroy` needs an item id' })) {
		const text = guideText(['step One', line, '  accept 783']);
		assert.deepEqual(parse(text).errors, [`${lineOf(text, line)}: ${message}`], line);
	}
});

test('the resolver takes titles and names from data, lint takes an abandon as the end of the quest, and the emitter writes both goals', () => {
	const r = compile(guideText(['step One', '  accept 783', '  abandon 783', '  destroy 159']));
	assert.deepEqual(r.errors, [], r.text);
	assert.deepEqual(r.warnings.filter((w) => w.includes('never turned in')), [], 'an abandon ends the quest like a turn-in');
	const goals = plain(r.guides[0].steps[0]).goals;
	assert.deepEqual([goals[1].t, goals[1].quest], ['abandon', 783]);
	assert.ok(goals[1].title);
	assert.deepEqual([goals[2].t, goals[2].item, goals[2].itemName], ['destroy', 159, 'Refreshing Spring Water']);
	const lua = emitGuides([{ guide: r.guides[0], source: null }]);
	assert.match(lua, /\{ t = "abandon", quest = 783, title = "[^"]+" \},/);
	assert.match(lua, /\{ t = "destroy", item = 159, itemName = "Refreshing Spring Water" \},/);
});

test('a pack with an abandon or destroy goal is written in format 5', () => {
	const mini = path.join(__dirname, 'fixtures', 'packs', 'mini');
	const { manifest } = readManifest(mini);
	const { guides } = compileProject({ packDir: mini, manifest, dataDir: DATA_DIR });
	assert.equal(formatFor(guides), FORMAT);
	const goal = { t: 'destroy', item: 159, itemName: 'Water' };
	const copy = guides.map((g) => ({ ...g, steps: g.steps.map((s, i) => (i === 0 ? { ...s, goals: [...s.goals, goal] } : s)) }));
	assert.equal(formatFor(copy), MONEY_TASK_FORMAT);
});
