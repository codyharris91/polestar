'use strict';
// Builds the six generated profession guides (Mining, Herbalism, Skinning,
// Fishing, Cooking, First Aid) from their specs (specs.js) and the reference
// data:
//
//   node tools/polestar.js profession gathering build    # rewrite guides/forever/professions/<those>.guide
//   node tools/polestar.js profession gathering check    # exit 1 when a guide is out of date
//
// For each band and each group of characters (starting area, continent, or
// faction) the zones a group can use are ranked by expected skill-ups per
// yard (route.js); the winner's nodes become a loop of goto waypoints. Groups
// that pick the same zone share one step. Trainers and the tool vendor are
// smart targets (`train <Profession> <Rank>`, `buy … nearest`): the engine
// picks the nearest one of the player's faction at runtime.

const { ZONES, RANKS, color } = require('./tables');
const { RACE_GROUPS, REGIONS, SIDE, maxZoneLevel } = require('./groups');
const R = require('./route');
const { OUT_DIR, GUIDE_HEADER, FACTIONS, context, fmt, zoneName, flightMaster } = require('./common');

// ------------------------------------------------------------------ planning

function continentOf(ctx, map) {
	const f = ctx.data.eraFrame(map);
	return f ? f.c : null;
}

// Zone candidates for one group in one band.
function candidatesFor(ctx, band, faction, group) {
	const side = SIDE[faction];
	if (band.zones && band.zones[faction]) return band.zones[faction];
	if (band.scope === 'start') return group.start;
	if (band.scope === 'next') return group.next;
	const max = maxZoneLevel(band.from);
	return Object.entries(ZONES)
		.filter(([id, z]) => z.side.includes(side) && z.min <= max && (band.scope !== 'region' || continentOf(ctx, Number(id)) === group.c))
		.map(([id]) => Number(id));
}

function groupsFor(scope, faction) {
	if (scope === 'start' || scope === 'next') return RACE_GROUPS[faction];
	if (scope === 'region') return REGIONS[faction];
	return [{ key: faction.toLowerCase(), faction }];
}

function rankIn(ctx, prof, band, zones) {
	const ranked = [];
	for (const id of zones) {
		const points = prof.points(ctx, id, band.from, band.to);
		if (points.length < (prof.minPoints || 6)) continue;
		ranked.push({ zone: id, points, ...R.scorePoints(points) });
	}
	return ranked.sort((a, b) => b.score - a.score || a.zone - b.zone);
}

// Best zone for one group; a starting zone without nodes (Teldrassil has no
// ore) falls back to the group's next zone.
function pickZone(ctx, prof, band, faction, group) {
	let ranked = rankIn(ctx, prof, band, candidatesFor(ctx, band, faction, group));
	if (!ranked.length && band.scope === 'start') ranked = rankIn(ctx, prof, band, group.next);
	if (!ranked.length) throw new Error(`${prof.skill} ${band.from}-${band.to}: no zone with nodes for ${faction} ${group.key}`);
	return { ...ranked[0], ranked };
}

// Plan: a list of { kind: 'learn'|'train'|'band', ... } entries in guide order.
function plan(ctx, prof) {
	const out = [{ kind: 'learn' }];
	for (const band of prof.bands) {
		const splits = RANKS.filter((r) => r.learnAt > band.from && r.learnAt < band.to);
		const rankAtStart = RANKS.find((r) => r.learnAt === band.from && r.learnAt > 0);
		if (rankAtStart) out.push({ kind: 'train', rank: rankAtStart });
		// Pick a zone for every group of both factions.
		const picks = [];
		for (const faction of FACTIONS) {
			for (const group of groupsFor(band.scope, faction)) {
				picks.push({ faction, group, ...pickZone(ctx, prof, band, faction, group) });
			}
		}
		const merged = mergePicks(picks);
		let from = band.from;
		for (const stop of [...splits.map((r) => r.learnAt), band.to]) {
			for (const m of merged) {
				const entry = m.factions.length === 1 ? flightMaster(ctx, m.zone, m.factions[0]) : null;
				const loop = R.loop(m.points, ctx.project, { entry: entry ? entry.pt : null, radius: prof.radius || 110 });
				out.push({ kind: 'band', cond: m.cond, zone: m.zone, from, to: stop, band, loop, points: m.points, cont: from !== band.from });
			}
			const rank = splits.find((r) => r.learnAt === stop);
			if (rank) out.push({ kind: 'train', rank });
			from = stop;
		}
	}
	return out;
}

// One entry per zone: the groups that picked it, and the `only` condition
// covering them (none when both factions are in).
function mergePicks(picks) {
	const out = [];
	for (const p of picks) {
		let m = out.find((x) => x.zone === p.zone);
		if (!m) {
			m = { zone: p.zone, points: p.points, picks: [], factions: [] };
			out.push(m);
		}
		m.picks.push(p);
		if (!m.factions.includes(p.faction)) m.factions.push(p.faction);
	}
	for (const m of out) {
		const byRace = m.picks.every((p) => p.group.races);
		if (byRace) m.cond = m.picks.flatMap((p) => p.group.races).join(',');
		else m.cond = m.factions.length === FACTIONS.length ? null : m.factions.join(',');
	}
	return out;
}

// Node kinds on a loop, lowest requirement first, each with its color at the
// band start (or at its own requirement when that is higher: `later`).
function nodeSummary(prof, points, from) {
	const seen = new Map();
	for (const p of points) {
		const k = p.name;
		if (!seen.has(k)) seen.set(k, { name: k, req: p.req, level: p.level, n: 0 });
		seen.get(k).n++;
	}
	return [...seen.values()]
		.sort((a, b) => a.req - b.req || a.name.localeCompare(b.name))
		.map((s) => ({ ...s, color: color(Math.max(from, s.req), s.req), later: s.req > from }));
}

function shortName(prof, name) {
	return prof.shortName ? prof.shortName(name) : name;
}

function label(prof, cluster) {
	const names = Object.entries(cluster.counts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 2)
		.map(([n]) => shortName(prof, n));
	return names.join(', ');
}

function render(ctx, prof) {
	const entries = plan(ctx, prof);
	const L = [];
	L.push(GUIDE_HEADER, `guide forever/professions/${prof.file}`);
	L.push(`title ${prof.title}`);
	L.push('category Professions');
	L.push('coords era');
	L.push(`levels ${prof.levels}`);
	L.push(`zone ${prof.headerZone}`);
	L.push('');
	for (const c of prof.header) L.push(c ? `# ${c}` : '#');
	let lastBand = null;
	for (const e of entries) {
		if (e.kind === 'learn') {
			L.push('', '# ---------------------------------------------------------------- Apprentice', '');
			L.push(`step Learn ${prof.skill}`);
			L.push(`  tip Any ${prof.skill} trainer of your faction teaches Apprentice ${prof.skill} at any level, and so does the Junior ${prof.skill} Trainer in each starting zone; the arrow picks the nearest.${prof.tool ? ` Buy a ${prof.tool.name} from a trade goods or general vendor: ${prof.tool.why}` : ''}`);
			L.push(`  train ${prof.skill} Apprentice`);
			if (prof.tool) L.push(`  buy ${prof.tool.item} x1 nearest`);
		} else if (e.kind === 'train') {
			L.push('');
			L.push(`step ${e.rank.name} ${prof.skill}`);
			L.push(`  tip ${e.rank.name} ${prof.skill} raises the cap to ${e.rank.max}; it needs skill ${e.rank.learnAt} and character level ${e.rank.level}. The arrow picks the nearest ${prof.skill} trainer of your faction.`);
			L.push(`  level ${e.rank.level}`);
			L.push(`  train ${prof.skill} ${e.rank.name}`);
		} else {
			const zn = zoneName(ctx, e.zone);
			const key = `${e.band.from}-${e.band.to}`;
			if (lastBand !== key) {
				L.push('');
				L.push(`# ---------------------------------------------------------------- ${prof.skill} ${key}`);
				lastBand = key;
			}
			const nodes = nodeSummary(prof, e.points, e.from);
			const z = ZONES[e.zone];
			L.push('');
			L.push(`step ${prof.bandTitle(nodes, e)}: ${zn} (${e.from}-${e.to})${e.cont ? ' cont.' : ''}`);
			if (e.cond) L.push(`  only ${e.cond}`);
			L.push(`  zone ${zn}`);
			L.push(`  tip ${prof.bandTip(nodes, e, z)}`);
			for (const c of e.loop) L.push(`  goto ${fmt(c.pt.x)},${fmt(c.pt.y)} "${label(prof, c)}" r 30`);
			L.push(`  skill ${prof.skill} ${e.to}`);
		}
	}
	L.push('');
	for (const line of prof.footer || []) L.push(line);
	return `${L.join('\n').replace(/\n+$/, '')}\n`;
}

// Every generated profession guide: { 'mining.guide': text, ... }.
function buildAll(ctx) {
	const { SPECS } = require('./specs');
	const out = {};
	for (const prof of SPECS) out[`${prof.file}.guide`] = prof.render ? prof.render(ctx) : render(ctx, prof);
	return out;
}

module.exports = { plan, render, buildAll, OUT_DIR };
