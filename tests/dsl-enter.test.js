'use strict';
// `enter "<Place>"` (docs/GUIDE_FORMAT.md, "Goals"): be in a zone or an area,
// by the name the game shows. The parser's goal and its error, the area ID the
// resolver gives the place (places.js goalArea, as for `hearth`), the warning
// for a name that is no zone or area, the emitted table and the pack format.
// Fixture data: tests/fixtures/dsl/data, plus an AreaTable made here
// (Goldshire is area 87 in Elwynn Forest, 12; RestedXP's `.subzone 87`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuide } = require('../tools/lib/dsl/parse');
const { Diagnostics } = require('../tools/lib/dsl/diag');
const { Data } = require('../tools/lib/dsl/data');
const { emitGuides } = require('../tools/lib/dsl/emit');
const { formatFor, MONEY_TASK_FORMAT } = require('../tools/lib/pack/format');
const { compile, fixtureData, guideText, lineOf, plain } = require('./helpers/dsl');

function parse(text) {
	const diag = new Diagnostics();
	const ast = parseGuide(text, 'x.guide', diag);
	return { ast, errors: diag.sorted().filter((d) => d.severity === 'error').map((d) => `${d.line}: ${d.message}`) };
}

// The fixture data with the client's AreaTable names (data/areas.js loadAreas).
function areaData() {
	const base = fixtureData();
	const area = (id, name, parent) => ({ id, name, c: 0, parent });
	const list = [area(12, 'Elwynn Forest', 0), area(87, 'Goldshire', 12)];
	const areas = { build: 'test', byId: new Map(list.map((a) => [a.id, a])), byName: new Map(list.map((a) => [a.name.toLowerCase(), [a]])) };
	return new Data({ quests: base.quests, npcs: base.npcs, objects: base.objects, items: base.items, zones: base.zones, 'map-frames': base.mapFrames, meta: base.meta, areas }, { dir: base.dir });
}

test('`enter` takes a quoted place, with coordinates for the arrow', () => {
	const text = guideText(['step Goldshire', '  enter "Goldshire" @42.1,65.9', 'step Into the forest', '  enter "Elwynn Forest"']);
	const { ast, errors } = parse(text);
	assert.deepEqual(errors, []);
	assert.equal(ast.steps[0].goals[0].verb, 'enter');
	assert.equal(ast.steps[0].goals[0].location, 'Goldshire');
	assert.equal(ast.steps[0].goals[0].x, 42.1);
	assert.equal(ast.steps[1].goals[0].location, 'Elwynn Forest');
});

test('`enter` without a place is an error at its line', () => {
	const text = guideText(['step One', '  enter', '  note Go on.']);
	const { errors } = parse(text);
	assert.deepEqual(errors, [`${lineOf(text, 'enter')}: \`enter\` needs a "Location"`]);
});

test('the place gets its area ID, a zone or an area; one that is neither warns', () => {
	const text = guideText(['step A', '  enter "Goldshire"', 'step B', '  enter "Elwynn Forest"', 'step C', '  enter "Goldshiree"']);
	const r = compile(text, areaData());
	assert.deepEqual(r.errors, [], r.text);
	const goals = plain(r.guides[0].steps).map((s) => s.goals[0]);
	assert.deepEqual(goals, [{ t: 'enter', location: 'Goldshire', area: 87 }, { t: 'enter', location: 'Elwynn Forest', area: 12 }, { t: 'enter', location: 'Goldshiree' }]);
	assert.deepEqual(r.warnings.filter((w) => w.includes('enter')), [
		`test.guide:${lineOf(text, 'enter "Goldshiree"')}: enter "Goldshiree": no zone or area has that name; the game never reports it, so the goal never checks off by itself`,
	]);
	// The fixture data has no AreaTable: the name is not checked, and no area ID.
	const bare = compile(guideText(['step A', '  enter "Goldshire"']));
	assert.deepEqual(bare.warnings.filter((w) => w.includes('enter')), []);
	assert.deepEqual(plain(bare.guides[0].steps)[0].goals[0], { t: 'enter', location: 'Goldshire' });
});

test('the emitted goal carries the place and its area, and the pack is written in format 5', () => {
	const r = compile(guideText(['step A', '  enter "Goldshire"']), areaData());
	assert.deepEqual(r.errors, [], r.text);
	const lua = emitGuides([{ guide: r.guides[0], source: null }]);
	assert.match(lua, /\{ t = "enter", location = "Goldshire", area = 87 \}/);
	assert.equal(formatFor(r.guides), MONEY_TASK_FORMAT);
});
