'use strict';
// The Guiding Stars page's data (addon/Polestar/Core/Credits.lua): the
// supporters, kept by hand in tools/lib/credits.json in rank order (highest
// Ko-fi total first; amounts are never stored), and the contributors, counted
// from the repository's merged pull requests on GitHub.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { header } = require('./generated');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(__dirname, 'credits.json');
const OUT = path.join(ROOT, 'addon', 'Polestar', 'Core', 'Credits.lua');
const REPO = 'fitzforge/polestar';

function readSource(file = SOURCE) {
	const src = JSON.parse(fs.readFileSync(file, 'utf8'));
	const supporters = src.supporters || [];
	for (const s of supporters) {
		if (typeof s !== 'string' || !s.trim()) throw new Error(`${file}: every supporter is a non-empty name`);
	}
	return { supporters, exclude: src.exclude || [], names: src.names || {} };
}

// Every merged pull request's author login, via the GitHub CLI.
function fetchMergedAuthors(repo = REPO) {
	const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '5000', '--json', 'author,mergedAt'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(out).map((pr) => ({ login: pr.author && pr.author.login, mergedAt: pr.mergedAt }));
}

// Merged pull requests -> [{ name, prs }], most first; a tie goes to whoever
// merged first. Bots and excluded logins are left out; `names` maps a login
// to the name shown.
function rankContributors(prs, { exclude = [], names = {} } = {}) {
	const skip = new Set(exclude.map((l) => l.toLowerCase()));
	const by = new Map();
	for (const { login, mergedAt } of prs) {
		if (!login || skip.has(login.toLowerCase()) || login.startsWith('app/') || /\[bot\]$/.test(login)) continue;
		const c = by.get(login) || { login, prs: 0, first: mergedAt };
		c.prs += 1;
		if (mergedAt && (!c.first || mergedAt < c.first)) c.first = mergedAt;
		by.set(login, c);
	}
	return [...by.values()]
		.sort((a, b) => b.prs - a.prs || String(a.first).localeCompare(String(b.first)))
		.map((c) => ({ name: names[c.login] || c.login, prs: c.prs }));
}

function luaString(s) {
	return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function render({ supporters, contributors }) {
	return [
		header('lua', 'credits', "tools/lib/credits.json and the repository's merged pull requests"),
		'',
		'local _, ns = ...',
		'',
		'ns.Credits = {',
		'\t-- Supporters, highest total first.',
		'\tsupporters = {',
		...supporters.map((s) => `\t\t${luaString(s)},`),
		'\t},',
		'\t-- GitHub contributors by merged pull requests, most first.',
		'\tcontributors = {',
		...contributors.map((c) => `\t\t{ name = ${luaString(c.name)}, prs = ${c.prs} },`),
		'\t},',
		'}',
		'',
	].join('\n');
}

function write({ source = SOURCE, out = OUT, prs } = {}) {
	const src = readSource(source);
	const contributors = rankContributors(prs || fetchMergedAuthors(), src);
	fs.writeFileSync(out, render({ supporters: src.supporters, contributors }));
	return { out, supporters: src.supporters.length, contributors: contributors.length };
}

module.exports = { readSource, fetchMergedAuthors, rankContributors, render, write, OUT, SOURCE };
