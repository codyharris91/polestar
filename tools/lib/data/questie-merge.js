'use strict';
// QuestieDB Forever records (questie.js readQuestie) -> the reference-data
// schema (docs/ARCHITECTURE.md, Toolchain -> Reference data), merged over the
// pfQuest tables. Precedence: recordings > questie-forever > pfQuest.
// Forever-only entities are added; for shared ones Questie wins on every
// field it has (a non-empty value; Questie stores absent numbers as 0) and
// pfQuest-only fields stay. `source` lists every contributor.
//
// Coordinates: the store holds Forever-frame percentages (see "Map frames"
// in docs/ARCHITECTURE.md for the evidence). On maps whose Forever bounds equal
// the Era bounds that is the same point in both frames and it is tagged "e";
// on maps whose bounds changed, or that exist only in Forever, "l".

const { parseCount } = require('./objectives');
const { reduceSpawns, spawnRecord, round2 } = require('./spawns');
const { luaGet, luaPairs, luaList, dropRate } = require('./questie');
const { ALL_RACES, ALL_CLASSES } = require('../game/races');

const SOURCE = 'questie-forever';
// Questie npcFlags (Classic values) -> npcs.json roles.
const NPC_FLAG_ROLES = [
	[4, 'vendor'], [8, 'flightmaster'], [16, 'trainer'], [32, 'spirithealer'], [64, 'spirithealer'], [128, 'innkeeper'], [256, 'banker'],
	[2048, 'battlemaster'], [4096, 'auctioneer'], [8192, 'stablemaster'], [16384, 'repair'],
];

function ids(v) {
	const out = [];
	for (const x of luaList(v)) {
		const n = Number(x);
		if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
	}
	return out;
}

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) && n !== 0 ? n : null;
}

// Race mask -> null when unrestricted. Bits 32/33 are past 32-bit bitwise
// range, so split arithmetically.
function raceMask(v) {
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n <= 0) return null;
	const low = n % 2 ** 32;
	const high = Math.floor(n / 2 ** 32);
	if ((low & ALL_RACES) === ALL_RACES && (high & 3) === 3) return null;
	return n;
}

function classMask(v) {
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0 || (n & ALL_CLASSES) === ALL_CLASSES) return null;
	return n;
}

function sortedRoles(set) {
	return [...set].sort();
}

// --- spawns -----------------------------------------------------------------

// ctx: { areaToUiMap(areaId) -> uiMapID | null, liveMaps: Set, spawnOptions }
// -> { spawns, counts: Map<uiMap, raw points>, unmapped }
function questieSpawns(value, ctx) {
	const perMap = new Map();
	let unmapped = 0;
	for (const [area, rows] of luaPairs(value)) {
		const pts = luaList(rows).filter((r) => Number(luaGet(r, 1)) >= 0 && Number(luaGet(r, 2)) >= 0);
		if (!pts.length) continue;
		const map = ctx.areaToUiMap(Number(area));
		if (!map) {
			unmapped += pts.length;
			continue;
		}
		if (!perMap.has(map)) perMap.set(map, []);
		for (const r of pts) perMap.get(map).push([Number(luaGet(r, 1)), Number(luaGet(r, 2))]);
	}
	const spawns = {};
	const counts = new Map();
	for (const map of [...perMap.keys()].sort((a, b) => a - b)) {
		const r = reduceSpawns(perMap.get(map), ctx.spawnOptions);
		if (!r.pts.length) continue;
		spawns[map] = spawnRecord(ctx.liveMaps.has(map) ? 'l' : 'e', r);
		counts.set(map, perMap.get(map).length);
	}
	return { spawns, counts, unmapped };
}

function mainOf(counts) {
	let best = null;
	let bestN = 0;
	for (const [m, n] of counts || []) {
		if (n > bestN || (n === bestN && m < best)) {
			best = m;
			bestN = n;
		}
	}
	return best;
}

// --- npcs / objects -----------------------------------------------------------

// Questie's friendlyToFaction is "not hostile to": neutral wildlife reads
// "AH". npcs.json `faction` is pfQuest's "serves that side" (quest givers,
// services), so a neutral "AH" npc without services or quests has none.
function npcFaction(r) {
	const f = r.friendlyToFaction;
	if (f !== 'A' && f !== 'H' && f !== 'AH') return null;
	const services = (Number(r.npcFlags) || 0) > 3;
	const quests = luaList(r.questStarts).length + luaList(r.questEnds).length > 0;
	return f === 'AH' && !services && !quests ? null : f;
}

function npcRecord(r, spawns) {
	const rec = { id: r.id, name: typeof r.name === 'string' ? r.name : null };
	const lo = num(r.minLevel);
	const hi = num(r.maxLevel);
	rec.level = lo ?? hi;
	if (lo !== null && hi !== null && hi !== lo) rec.levelMax = hi;
	if (num(r.rank) !== null) rec.rank = num(r.rank);
	rec.faction = npcFaction(r);
	const flags = Number(r.npcFlags) || 0;
	const roles = NPC_FLAG_ROLES.filter(([bit]) => Math.floor(flags / bit) % 2 === 1).map(([, role]) => role);
	if (roles.length) rec.roles = sortedRoles(new Set(roles));
	if (typeof r.subName === 'string' && r.subName) rec.subName = r.subName;
	rec.spawns = spawns;
	return rec;
}

function objectRecord(r, spawns, factionTemplates) {
	const rec = { id: r.id, name: typeof r.name === 'string' ? r.name : null };
	if (rec.name === 'Mailbox') {
		rec.roles = ['mailbox'];
		// Questie's Townsfolk mailbox lists treat factionID 0 as available to both sides.
		const factionID = Number(r.factionID);
		const enemies = factionID === 0 ? 0 : factionTemplates && factionTemplates.get(factionID);
		// EnemyGroup bits 2/4 name the player sides excluded; unknown or hostile to both is not neutral.
		const hostile = Number.isInteger(enemies) && enemies >= 0 ? enemies & 6 : null;
		rec.faction = hostile === 0 ? 'AH' : hostile === 2 ? 'H' : hostile === 4 ? 'A' : null;
	}
	rec.spawns = spawns;
	return rec;
}

// Yards within which a pfQuest point on another map is the same spawn.
const SAME_SPAWN_YARDS = 30;

// Questie's spawns, plus pfQuest's copies of the same spawns on maps Questie
// does not list (pfQuest repeats a spawn on every map whose area holds it: a
// city and its zone, both sides of a border). With `allMaps` every pfQuest
// map Questie lacks is kept whole. A copy's `pts` are the ones near Questie's
// `pts`; its `more` the rest near any Questie point, `more` included (the
// points a cap left out). A copy map with no point near Questie's `pts` is
// dropped, as before: its spawns are on Questie's own map, in `more`.
// toWorld(map, f, x, y) -> { c, wx, wy } | null
function mergeSpawns(pfSpawns, qSpawns, toWorld, allMaps = false) {
	if (!Object.keys(qSpawns).length) return pfSpawns || {};
	const world = [];
	const extra = [];
	for (const [map, s] of Object.entries(qSpawns)) {
		for (const [x, y] of s.pts) world.push(toWorld(Number(map), s.f, x, y));
		for (const [x, y] of s.more || []) extra.push(toWorld(Number(map), s.f, x, y));
	}
	const everyPoint = [...world, ...extra];
	const near = (w, list) => w && list.some((q) => q && q.c === w.c && Math.hypot(q.wx - w.wx, q.wy - w.wy) <= SAME_SPAWN_YARDS);
	const out = { ...qSpawns };
	for (const [map, s] of Object.entries(pfSpawns || {})) {
		if (out[map]) continue;
		if (allMaps) {
			out[map] = s;
			continue;
		}
		const at = ([x, y]) => toWorld(Number(map), s.f, x, y);
		const pts = s.pts.filter((p) => near(at(p), world));
		const more = [...s.pts.filter((p) => !pts.includes(p)), ...(s.more || [])].filter((p) => near(at(p), everyPoint)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		if (pts.length) out[map] = spawnRecord(s.f, { pts, more });
	}
	const sorted = {};
	for (const k of Object.keys(out).map(Number).sort((a, b) => a - b)) sorted[k] = out[k];
	return sorted;
}

// Questie over pfQuest; service flags can supply a side pfQuest did not know.
function mergeNpc(pf, q, toWorld, counter = { n: 0 }) {
	if (!pf) return { ...q, source: [SOURCE] };
	const out = { id: pf.id, name: q.name || pf.name };
	out.level = q.level ?? pf.level;
	const levelMax = q.level !== null ? q.levelMax : pf.levelMax;
	if (levelMax !== undefined && levelMax !== null) out.levelMax = levelMax;
	const rank = q.level !== null ? q.rank : pf.rank;
	if (rank !== undefined && rank !== null) out.rank = rank;
	out.faction = pf.faction ?? ((q.roles || []).length ? q.faction : null);
	// Roles are a union: QuestieDB's npc flags plus pfQuest's categories (rare,
	// and services QuestieDB's flags miss).
	const roles = new Set([...(q.roles || []), ...(pf.roles || [])]);
	if ((q.roles || []).length && (pf.roles || []).some((r) => !q.roles.includes(r))) counter.n++;
	if (roles.size) out.roles = sortedRoles(roles);
	if (q.subName) out.subName = q.subName;
	out.spawns = mergeSpawns(pf.spawns, q.spawns, toWorld);
	out.source = [...(pf.source || ['pfquest']), SOURCE];
	return out;
}

// Resource nodes and pools (pfQuest's gathering categories) spawn from shared
// pools; QuestieDB lists them only where quests need them (a fishing school
// in one zone), so pfQuest's other maps stay.
const GATHER_ROLES = new Set(['herb', 'mine', 'fishing', 'chest']);

function mergeObject(pf, q, toWorld) {
	if (!pf) return { ...q, source: [SOURCE] };
	const out = { id: pf.id, name: q.name || pf.name };
	const roles = new Set([...(q.roles || []), ...(pf.roles || [])]);
	if (roles.size) out.roles = sortedRoles(roles);
	if (q.roles && q.roles.includes('mailbox')) out.faction = q.faction;
	else if (pf.faction !== undefined) out.faction = pf.faction;
	out.spawns = mergeSpawns(pf.spawns, q.spawns, toWorld, (pf.roles || []).some((r) => GATHER_ROLES.has(r)));
	out.source = [...(pf.source || ['pfquest']), SOURCE];
	return out;
}

// --- items --------------------------------------------------------------------

function sortedObj(map) {
	const o = {};
	for (const k of [...map.keys()].sort((a, b) => a - b)) o[k] = map.get(k);
	return o;
}

// Source lists (droppers, objects, vendors) are unions: QuestieDB's entries
// first and its chances win, pfQuest's extra entries stay (a missing entry in
// QuestieDB is not evidence that Forever removed it; real removals go in
// corrections.json). `added` counts the pfQuest-only entries kept.
function mergeItem(pf, r, drops, added = { n: 0 }) {
	const npc = new Map();
	for (const id of ids(r.npcDrops)) {
		const rate = dropRate(drops, r.id, id);
		npc.set(id, rate ? rate.chance : pf && pf.drops.npc[id] !== undefined ? pf.drops.npc[id] : null);
	}
	const object = new Map();
	for (const id of ids(r.objectDrops)) object.set(id, pf && pf.drops.object[id] !== undefined ? pf.drops.object[id] : null);
	const vendors = ids(r.vendors);
	let extra = 0;
	if (pf) {
		for (const [k, c] of Object.entries(pf.drops.npc)) if (!npc.has(Number(k))) (npc.set(Number(k), c), extra++);
		for (const [k, c] of Object.entries(pf.drops.object)) if (!object.has(Number(k))) (object.set(Number(k), c), extra++);
		for (const v of pf.vendors) if (!vendors.includes(v)) (vendors.push(v), extra++);
	}
	if (extra && (r.npcDrops || r.objectDrops || r.vendors)) added.n++;
	const out = {
		id: r.id,
		name: typeof r.name === 'string' && r.name ? r.name : pf ? pf.name : null,
		drops: { npc: sortedObj(npc), object: sortedObj(object) },
		vendors: vendors.sort((a, b) => a - b),
	};
	// Item class 12 (Quest): drops only for characters on the quest; chances are often unknown (null).
	if (Number(r.class) === 12) out.questItem = true;
	const containers = ids(r.itemDrops);
	if (containers.length) out.containers = containers.sort((a, b) => a - b);
	out.source = pf ? [...(pf.source || ['pfquest']), SOURCE] : [SOURCE];
	return out;
}

// --- quests -------------------------------------------------------------------

function objectiveTextOf(lines) {
	const l = luaList(lines).filter((s) => typeof s === 'string');
	return l.length && l.some((s) => s !== '') ? l.join('$B') : null;
}

// objectives = { creature, object, item, reputation, killCredit, spell },
// triggerEnd = { text, spawnlist }. The game lists a quest's objectives by
// kind: creatures, objects, items, kill credits, then the trigger. That is the
// order Questie maps the quest log by, and the order the Engine's goal.oi
// counts in; QuestieDB's hints (readObjectiveFirst) move one kind to the front
// for the few quests the game lists otherwise, one entry at a time as Questie
// does. A reputation objective, which would sit after the items, is not kept:
// no quest has one before another objective; nor is a spell objective (after
// the kill credits), which no quest in the store has. Counts come from the
// objective text (the store has none), else pfQuest's count for the same
// objective, else CMaNGOS classic-db's (fillCounts).
// A trigger listed at several places is done at any one of them (How Big a
// Threat?, 984: four furbolg camps, the first far north-east of Auberdine,
// #560). The objective keeps one point: the one nearest the quest's giver
// in yards when it stands on that map, else the first. `at`: the giver's
// { f, x, y }; toWorld(f, x, y) -> { wx, wy } | null on the trigger's map.
function nearestPoint(rows, at, f, toWorld) {
	const g = at && toWorld(at.f, at.x, at.y);
	if (!rows.length || !g) return rows[0] || null;
	const d = (r) => {
		const w = toWorld(f, Number(luaGet(r, 1)), Number(luaGet(r, 2)));
		return w ? Math.hypot(w.wx - g.wx, w.wy - g.wy) : Infinity;
	};
	return rows.reduce((a, b) => (d(b) < d(a) ? b : a));
}

function questObjectives(q, pf, names, ctx) {
	const text = objectiveTextOf(q.objectivesText);
	const o = q.objectives;
	const first = ctx.objectiveFirst || {};
	const moved = (kind) => Boolean(first[kind] && first[kind].has(Number(q.id)));
	const entries = [];
	const add = (kind, e) => (moved(kind) ? entries.unshift(e) : entries.push(e));
	for (const e of luaList(luaGet(o, 1))) add('creature', { type: 'kill', id: Number(luaGet(e, 1)), text: luaGet(e, 2) ?? names.npc(Number(luaGet(e, 1))) });
	for (const e of luaList(luaGet(o, 2))) add('object', { type: 'object', id: Number(luaGet(e, 1)), text: luaGet(e, 2) ?? names.object(Number(luaGet(e, 1))) });
	for (const e of luaList(luaGet(o, 3))) add('item', { type: 'item', id: Number(luaGet(e, 1)), text: luaGet(e, 2) ?? names.item(Number(luaGet(e, 1))) });
	for (const e of luaList(luaGet(o, 5))) {
		const base = Number(luaGet(e, 2));
		add('killCredit', { type: 'kill', id: base, text: luaGet(e, 3) ?? names.npc(base), credit: ids(luaGet(e, 1)) });
	}
	const valid = entries.filter((e) => Number.isInteger(e.id) && e.id > 0);
	const allNames = valid.map((e) => e.text).filter(Boolean);
	const pfObj = (pf && pf.objectives) || [];
	const list = valid.map((e) => {
		const { count } = parseCount(text, e.text, { type: e.type, others: allNames });
		const pfSame = pfObj.find((p) => p.type === e.type && p.id === e.id);
		return { ...e, count: count ?? (pfSame ? pfSame.count : null) };
	});
	const out = list.map((e) => {
		const r = { type: e.type, id: e.id, count: e.count, text: typeof e.text === 'string' ? e.text : null };
		if (e.credit && e.credit.length > 1) r.credit = e.credit;
		return r;
	});
	const trig = q.triggerEnd;
	if (trig) {
		const pfEvents = pfObj.filter((p) => p.type === 'event');
		const ev = { type: 'event', id: pfEvents.length === 1 ? pfEvents[0].id : null, count: null, text: typeof luaGet(trig, 1) === 'string' ? luaGet(trig, 1) : null };
		for (const [area, rows] of luaPairs(luaGet(trig, 2))) {
			const map = ctx.areaToUiMap(Number(area));
			const pts = map ? luaList(rows).filter((r) => Number(luaGet(r, 1)) >= 0) : [];
			const f = ctx.liveMaps.has(map) ? 'l' : 'e';
			const toWorld = (pf, x, y) => (ctx.toWorld ? ctx.toWorld(map, pf, x, y) : null);
			const p = nearestPoint(pts, ctx.giverAt ? ctx.giverAt(q, map) : null, f, toWorld);
			if (p) {
				Object.assign(ev, { map, f, x: round2(Number(luaGet(p, 1))), y: round2(Number(luaGet(p, 2))) });
				break;
			}
		}
		if (moved('event')) out.unshift(ev);
		else out.push(ev);
	}
	const classic = ctx.questCounts && ctx.questCounts[Number(q.id)];
	if (classic) ctx.countsFilled.n += fillCounts(out, classic);
	return out;
}

// The kind groups a project objective and a quest_template slot pair within:
// kills, kill credits and triggers count ReqCreatureOrGO creatures.
const COUNT_GROUP = { kill: 'kill', event: 'kill', object: 'object', item: 'item' };

// Objectives with no count take one from classic-db's quest_template
// ({ kill, object, item }: [[id, count]]) of the same group: the counts of
// the same id, or the slot's when each side has exactly one of the group
// (Forever changed some ids). Two different counts leave it null; a count it
// has is never replaced. -> how many were filled.
function fillCounts(objectives, classic) {
	let filled = 0;
	for (const o of objectives) {
		const group = COUNT_GROUP[o.type];
		const slots = (group && classic[group]) || [];
		if (o.count !== null || !slots.length) continue;
		const counts = new Set(slots.filter(([id]) => id === o.id).map(([, n]) => n));
		if (slots.length === 1 && objectives.filter((p) => COUNT_GROUP[p.type] === group).length === 1) counts.add(slots[0][1]);
		if (counts.size !== 1) continue;
		o.count = [...counts][0];
		filled++;
	}
	return filled;
}

// One Questie quest -> schema record (before merging).
function questRecord(q, pf, ctx) {
	// questgivers = { npcIds?, objectIds?, itemIds? }: slots may be absent ({ [2] = { 581822 } }), so index, not ipairs.
	const givers = [1, 2, 3].map((i) => luaGet(q.startedBy, i));
	const enders = [1, 2].map((i) => luaGet(q.finishedBy, i));
	const skill = luaList(q.requiredSkill);
	const rep = luaList(luaGet(q.objectives, 4));
	const minRep = luaList(q.requiredMinRep);
	const hasObjectives = luaPairs(q.objectives).length > 0 || Boolean(q.triggerEnd);
	return {
		title: typeof q.name === 'string' && q.name ? q.name : null,
		level: num(q.questLevel),
		minLevel: num(q.requiredLevel),
		races: raceMask(q.requiredRaces),
		classes: classMask(q.requiredClasses),
		start: { npc: ids(givers[0]), object: ids(givers[1]), item: ids(givers[2]) },
		end: { npc: ids(enders[0]), object: ids(enders[1]) },
		preAny: ids(q.preQuestSingle),
		preAll: ids(q.preQuestGroup),
		excl: ids(q.exclusiveTo).filter((x) => x !== q.id),
		next: num(q.nextQuestInChain),
		breadcrumbs: ids(q.breadcrumbs),
		parent: num(q.parentQuest),
		children: ids(q.childQuests),
		objectives: hasObjectives ? questObjectives(q, pf, ctx.names, ctx) : [],
		hasObjectives,
		objectiveText: objectiveTextOf(q.objectivesText),
		zoneOrSort: Number(q.zoneOrSort) || 0,
		skill: num(skill[0]),
		skillLevel: num(skill[1]),
		maxLevel: num(q.requiredMaxLevel),
		breadcrumbFor: num(q.breadcrumbForQuestId),
		repeatable: Math.floor((Number(q.specialFlags) || 0) % 2) === 1,
		sourceItem: num(q.sourceItemId),
		requiredItems: ids(q.requiredSourceItems),
		reputation: rep.length >= 2 && num(rep[0]) ? { faction: Number(rep[0]), value: Number(rep[1]) } : null,
		// requiredMinRep: the standing (reputation value, 3000 Friendly) a character needs to take the quest.
		minRep: minRep.length >= 2 && num(minRep[0]) ? { faction: Number(minRep[0]), value: Number(minRep[1]) } : null,
	};
}

// Givers/enders per kind: QuestieDB's first, pfQuest's extras kept (npc/object
// questStarts/questEnds are the same facts seen from the other side).
function unionGivers(q, pf, keys, counter) {
	const out = {};
	let extra = 0;
	for (const k of keys) {
		out[k] = q[k].slice();
		for (const id of pf[k] || []) if (!out[k].includes(id)) (out[k].push(id), extra++);
	}
	if (extra && keys.some((k) => q[k].length)) counter.n++;
	return out;
}

function mergeQuest(id, pf, r, ctx) {
	const has = (v) => v !== null && v !== undefined;
	const base = pf || {
		id, title: null, level: null, minLevel: null, races: null, classes: null,
		start: { npc: [], object: [], item: [] }, end: { npc: [], object: [] }, pre: [], excl: [], next: null,
		objectives: [], objectiveText: null, zone: null, xp: null, skill: null, event: null, source: [],
	};
	const out = {
		id,
		title: r.title || base.title,
		level: has(r.level) ? r.level : base.level,
		minLevel: has(r.minLevel) ? r.minLevel : base.minLevel,
		races: r.races,
		classes: r.classes,
		start: unionGivers(r.start, base.start, ['npc', 'object', 'item'], ctx.added.quests),
		end: unionGivers(r.end, base.end, ['npc', 'object'], ctx.added.quests),
		// `pre` stays pfQuest's (any one suffices; it also lists optional
		// breadcrumbs). Forever-only quests take Questie's any-of list, else its all-of list.
		pre: pf ? base.pre : r.preAny.length ? r.preAny : r.preAll,
		// pfQuest `close` and Questie exclusiveTo are both the ExclusiveGroup: union.
		excl: [...base.excl, ...r.excl.filter((x) => !base.excl.includes(x))],
		next: has(r.next) ? r.next : base.next,
		objectives: r.hasObjectives ? r.objectives : base.objectives,
		objectiveText: r.objectiveText || base.objectiveText,
		zone: base.zone,
		xp: base.xp,
		// The profession a quest needs is the Forever store's alone: a quest it
		// lists without requiredSkill is offered to everyone on Forever, whatever
		// pfQuest's Classic data says (Ragnar Thunderbrew offers Beer Basted
		// Boar Ribs, 384, to non-cooks; pfQuest lists Cooking).
		skill: has(r.skill) ? r.skill : null,
		event: base.event,
		source: [...(base.source || []), SOURCE],
	};
	if (r.preAll.length) out.preAll = r.preAll;
	if (r.preAny.length) out.preAny = r.preAny;
	if (has(r.skill) && has(r.skillLevel)) out.skillLevel = r.skillLevel;
	if (has(r.maxLevel)) out.maxLevel = r.maxLevel;
	if (has(r.breadcrumbFor)) out.breadcrumbFor = r.breadcrumbFor;
	if (r.breadcrumbs.length) out.breadcrumbs = r.breadcrumbs;
	if (has(r.parent)) out.parent = r.parent;
	if (r.children.length) out.children = r.children;
	if (r.repeatable) out.repeatable = true;
	if (has(r.sourceItem)) out.sourceItem = r.sourceItem;
	if (r.requiredItems.length) out.requiredItems = r.requiredItems;
	if (r.reputation) out.reputation = r.reputation;
	if (r.minRep) out.minRep = r.minRep;
	// AreaTable id of the quest's zone or instance (QuestieDB zoneOrSort > 0; negative QuestSort ids omitted).
	if (r.zoneOrSort > 0) out.area = r.zoneOrSort;
	if (!pf || out.zone === null) {
		out.zone =
			ctx.main('npc', out.start.npc[0]) ?? ctx.main('object', out.start.object[0]) ?? ctx.main('npc', out.end.npc[0]) ?? ctx.main('object', out.end.object[0]) ??
			(r.zoneOrSort > 0 ? ctx.areaToUiMap(r.zoneOrSort) : null);
	}
	return out;
}

// Fields compared for the "changed in Forever" report.
const COMPARED = ['title', 'level', 'minLevel', 'races', 'classes', 'start', 'end', 'next', 'objectives'];

function questDiff(pf, merged) {
	const changed = [];
	for (const k of COMPARED) {
		const a = k === 'objectives' ? pf[k].map((o) => `${o.type}:${o.id}`) : pf[k];
		const b = k === 'objectives' ? merged[k].map((o) => `${o.type}:${o.id}`) : merged[k];
		if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
	}
	return changed;
}

// tables: { quests, npcs, objects, items } from normalizePfQuest (mutated in place).
// qz: readQuestie(). ctx: { areaToUiMap, liveMaps, spawnOptions, toWorld(map, f, x, y),
// questCounts (loadQuestCounts' table, optional) } -> stats
function applyQuestie(tables, qz, ctx) {
	const stats = {
		questieOnlyQuests: 0, questieOnlyNpcs: 0, questieOnlyObjects: 0, questieOnlyItems: 0,
		questieQuests: 0, questieNpcs: 0, questieObjects: 0, questieItems: 0, unmappedQuestiePoints: 0,
		questXp: 0, removedQuests: [], changedQuests: {}, objectiveCountsFromClassicDb: 0,
	};
	const mains = { npc: new Map(), object: new Map() };
	const rolesAdded = { n: 0 };
	// Instance npcs and objects have no coordinates in QuestieDB ({ [area] =
	// { { -1, -1 } } }): the areas of their spawns and zoneID give the
	// dungeon or raid map ids (ctx.instanceOfArea) they belong to.
	const instancesOf = (r) => {
		if (!ctx.instanceOfArea) return [];
		const areas = luaPairs(r.spawns).map(([area]) => Number(area));
		if (Number(r.zoneID) > 0) areas.push(Number(r.zoneID));
		return [...new Set(areas.map(ctx.instanceOfArea).filter(Boolean))].sort((a, b) => a - b);
	};
	const merge = (kind, table, source, build, mergeFn, key) => {
		for (const [id, r] of source) {
			const service = kind === 'npc' ? Number(r.npcFlags) > 3 : r.name === 'Mailbox';
			const spawnContext = service ? { ...ctx, spawnOptions: { ...ctx.spawnOptions, dedupe: 0 } } : ctx;
			const { spawns, counts, unmapped } = questieSpawns(r.spawns, spawnContext);
			stats.unmappedQuestiePoints += unmapped;
			const m = mainOf(counts);
			if (m) mains[kind].set(id, m);
			const pf = table[id];
			if (!pf) stats[`questieOnly${key}`]++;
			table[id] = mergeFn(pf, build(r, spawns), ctx.toWorld, rolesAdded);
			const instances = instancesOf(r);
			if (instances.length) table[id].instances = instances;
			stats[`questie${key}`]++;
		}
	};
	merge('npc', tables.npcs, qz.npcs, npcRecord, mergeNpc, 'Npcs');
	merge('object', tables.objects, qz.objects, (r, spawns) => objectRecord(r, spawns, qz.factionTemplates), mergeObject, 'Objects');
	const addedItems = { n: 0 };
	for (const [id, r] of qz.items) {
		if (!tables.items[id]) stats.questieOnlyItems++;
		tables.items[id] = mergeItem(tables.items[id], r, qz.drops, addedItems);
		stats.questieItems++;
	}
	stats.itemsRegainedEntries = addedItems.n;
	stats.npcsRegainedRoles = rolesAdded.n;
	const nameOf = (t) => (id) => (t[id] && typeof t[id].name === 'string' ? t[id].name : null);
	const qctx = {
		...ctx,
		names: { npc: nameOf(tables.npcs), object: nameOf(tables.objects), item: nameOf(tables.items) },
		main: (kind, id) => (id === undefined ? null : mains[kind].get(id) ?? null),
		// The first NPC giver's first spawn on `map` ({ f, x, y }), or null.
		giverAt: (q, map) => {
			const npc = tables.npcs[ids(luaGet(q.startedBy, 1))[0]];
			const s = npc && npc.spawns && npc.spawns[map];
			const p = s && Array.isArray(s.pts) && s.pts[0];
			return p ? { f: s.f, x: p[0], y: p[1] } : null;
		},
		added: { quests: { n: 0 } },
		countsFilled: { n: 0 },
		objectiveFirst: qz.objectiveFirst,
	};
	const questieIds = new Set(qz.quests.keys());
	for (const id of Object.keys(tables.quests).map(Number)) if (!questieIds.has(id)) stats.removedQuests.push(id);
	for (const [id, q] of qz.quests) {
		const pf = tables.quests[id];
		const r = questRecord(q, pf, qctx);
		if (!r.title && !pf) continue;
		const merged = mergeQuest(id, pf, r, qctx);
		if (pf) {
			for (const k of questDiff(pf, merged)) stats.changedQuests[k] = (stats.changedQuests[k] || 0) + 1;
		} else {
			stats.questieOnlyQuests++;
		}
		tables.quests[id] = merged;
		stats.questieQuests++;
	}
	stats.questsRegainedGivers = qctx.added.quests.n;
	stats.objectiveCountsFromClassicDb = qctx.countsFilled.n;
	// Reverse links: npc/object questStarts/questEnds and item startQuest
	// name givers and enders the quest record sometimes lacks (92727 ends at
	// object 581822, which lists it in questEnds).
	stats.reverseLinks = 0;
	const link = (qid, side, kind, eid) => {
		const q = tables.quests[qid];
		if (!q || !q[side] || !Array.isArray(q[side][kind]) || q[side][kind].includes(eid)) return;
		q[side][kind].push(eid);
		stats.reverseLinks++;
	};
	for (const [kind, source] of [['npc', qz.npcs], ['object', qz.objects]]) {
		for (const [eid, e] of source) {
			for (const qid of luaList(e.questStarts)) link(Number(qid), 'start', kind, eid);
			for (const qid of luaList(e.questEnds)) link(Number(qid), 'end', kind, eid);
		}
	}
	for (const [iid, it] of qz.items) if (Number(it.startQuest) > 0) link(Number(it.startQuest), 'start', 'item', iid);
	// Quest XP (QuestXP support data: { level, xp } per quest, full XP at quest level).
	for (const [id, x] of qz.xp) {
		const q = tables.quests[id];
		if (!q || !x.xp) continue;
		q.xp = x.xp;
		stats.questXp++;
	}
	// Follow-up = Questie's nextQuestInChain, else the single quest listing this one as a prerequisite.
	const successors = new Map();
	for (const q of Object.values(tables.quests)) {
		for (const p of q.pre) {
			if (!successors.has(p)) successors.set(p, []);
			successors.get(p).push(q.id);
		}
	}
	for (const [p, list] of successors) {
		const q = tables.quests[p];
		if (q && q.next === null && list.length === 1 && tables.quests[list[0]]) q.next = list[0];
	}
	// Every npc, object and item names its origin, as quests do.
	for (const t of [tables.npcs, tables.objects, tables.items]) {
		for (const e of Object.values(t)) if (!e.source) e.source = ['pfquest'];
	}
	// A quest never requires itself or a quest exclusive with it. QuestieDB's
	// preQuestSingle sometimes lists the whole exclusive group (1519 Call of
	// Earth: [1516, 1519, 92466]); pfQuest has a few self-listings too.
	stats.prereqsCleaned = 0;
	for (const q of Object.values(tables.quests)) {
		const bad = new Set([q.id, ...q.excl]);
		let touched = false;
		for (const key of ['pre', 'preAll', 'preAny']) {
			if (!Array.isArray(q[key])) continue;
			const kept = q[key].filter((p) => !bad.has(p));
			if (kept.length === q[key].length) continue;
			touched = true;
			if (key === 'pre' || kept.length) q[key] = kept;
			else delete q[key];
		}
		if (touched) stats.prereqsCleaned++;
	}
	return stats;
}

module.exports = { applyQuestie, raceMask, classMask, SOURCE };
