'use strict';
// `cast <spellId> ["Name"]` (docs/GUIDE_FORMAT.md, "Goals"): the player casts
// that spell while the goal is open. The parser's goal and its errors, the
// name from the professions data (a recipe) or the author's, the emitted
// table and the pack format. Fixture data: tests/fixtures/dsl/data (3275,
// Linen Bandage, is a First Aid recipe in its professions).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuide } = require('../tools/lib/dsl/parse');
const { Diagnostics } = require('../tools/lib/dsl/diag');
const { emitGuides } = require('../tools/lib/dsl/emit');
const { formatFor, MONEY_TASK_FORMAT } = require('../tools/lib/pack/format');
const { compile, guideText, lineOf, plain } = require('./helpers/dsl');

function parse(text) {
	const diag = new Diagnostics();
	const ast = parseGuide(text, 'x.guide', diag);
	return { ast, errors: diag.sorted().filter((d) => d.severity === 'error').map((d) => `${d.line}: ${d.message}`) };
}

test('`cast` takes a spell id and an optional quoted name', () => {
	const text = guideText(['step Fire', '  cast 818 "Basic Campfire"', 'step Bandage', '  cast 3275']);
	const { ast, errors } = parse(text);
	assert.deepEqual(errors, []);
	assert.deepEqual([ast.steps[0].goals[0].verb, ast.steps[0].goals[0].spell, ast.steps[0].goals[0].spellName], ['cast', 818, 'Basic Campfire']);
	assert.deepEqual([ast.steps[1].goals[0].spell, ast.steps[1].goals[0].spellName], [3275, undefined]);
});

test('`cast` without a spell id is an error at its line', () => {
	const text = guideText(['step One', '  cast', '  note Go on.']);
	assert.deepEqual(parse(text).errors, [`${lineOf(text, 'cast')}: \`cast\` needs a spell id`]);
});

test('the name comes from the professions data, else the author; a spell in neither is an error', () => {
	const text = guideText(['step A', '  cast 3275', 'step B', '  cast 18960 "Teleport: Moonglade"', 'step C', '  cast 18960']);
	const r = compile(text);
	// Step C's goal is the line after its header.
	assert.deepEqual(r.errors, [`test.guide:${lineOf(text, 'step C') + 1}: spell 18960 is not in data; give its name: \`cast 18960 "Name"\``]);
	const ok = compile(guideText(['step A', '  cast 3275', 'step B', '  cast 18960 "Teleport: Moonglade"']));
	assert.deepEqual(ok.errors, [], ok.text);
	assert.deepEqual(plain(ok.guides[0].steps).map((s) => s.goals[0]), [
		{ t: 'cast', spell: 3275, spellName: 'Linen Bandage' },
		{ t: 'cast', spell: 18960, spellName: 'Teleport: Moonglade' },
	]);
});

test('the emitted goal carries the spell and its name, and the pack is written in format 5', () => {
	const r = compile(guideText(['step A', '  cast 818 "Basic Campfire"']));
	assert.deepEqual(r.errors, [], r.text);
	const lua = emitGuides([{ guide: r.guides[0], source: null }]);
	assert.match(lua, /\{ t = "cast", spell = 818, spellName = "Basic Campfire" \}/);
	assert.equal(formatFor(r.guides), MONEY_TASK_FORMAT);
});
