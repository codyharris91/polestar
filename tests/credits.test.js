'use strict';
// The Guiding Stars generator (tools/lib/credits.js): who is credited, in
// what order, and that any name loads as a Lua string.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { rankContributors, render } = require('../tools/lib/credits');
const { findLua } = require('../tools/lib/lua');

test('contributors rank by merged pull requests, ties to whoever merged first; bots and excluded logins left out', () => {
	const prs = [
		{ login: 'late', mergedAt: '2026-10-05T00:00:00Z' },
		{ login: 'late', mergedAt: '2026-10-06T00:00:00Z' },
		{ login: 'early', mergedAt: '2026-10-01T00:00:00Z' },
		{ login: 'early', mergedAt: '2026-10-09T00:00:00Z' },
		{ login: 'most', mergedAt: '2026-10-08T00:00:00Z' },
		{ login: 'most', mergedAt: '2026-10-08T00:00:00Z' },
		{ login: 'most', mergedAt: '2026-10-08T00:00:00Z' },
		{ login: 'app/github-actions', mergedAt: '2026-10-01T00:00:00Z' },
		{ login: 'dependabot[bot]', mergedAt: '2026-10-01T00:00:00Z' },
		{ login: 'Owner', mergedAt: '2026-10-01T00:00:00Z' },
	];
	assert.deepEqual(rankContributors(prs, { exclude: ['owner'], names: { most: 'Most Of All' } }), [
		{ name: 'Most Of All', prs: 3 },
		{ name: 'early', prs: 2 },
		{ name: 'late', prs: 2 },
	]);
});

test('names with quotes, backslashes and newlines load back unchanged in Lua', () => {
	const odd = ['Say "hi"', 'back\\slash', 'two\nlines', 'pipe|name'];
	const lua = render({ supporters: odd, contributors: [{ name: 'q"uote', prs: 1 }] });
	const out = execFileSync(findLua(), ['-e', `local ns = {}; local f = assert(loadstring(${JSON.stringify(lua)})); f(nil, ns)
		for _, n in ipairs(ns.Credits.supporters) do io.write(n, "\\0") end
		io.write(ns.Credits.contributors[1].name)`], { encoding: 'utf8' });
	assert.deepEqual(out.split('\0'), [...odd, 'q"uote']);
});
