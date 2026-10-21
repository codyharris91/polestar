'use strict';
// Specs for the generated profession guides (see build.js). Mining, Herbalism
// and Skinning are band specs rendered by build.js; Fishing renders itself.
// scope: 'start' = each race's starting zone, 'next' = the zone after it,
// 'region' = per continent group, 'faction' = anywhere the faction can work.

const { MINING_NODES, HERB_NODES } = require('./tables');
const { SKINNING_POINTS } = require('./skinning');
const { ERA_NOTE } = require('./notes');
const fishing = require('./fishing');
const secondary = require('./secondary');
const R = require('./route');

function list(nodes, short) {
	return nodes
		.filter((n) => n.color && n.color !== 'grey')
		.map((n) => (n.later ? `${short(n.name)} (from ${n.req})` : `${short(n.name)} (${n.req}, ${n.color})`))
		.join(', ');
}

// The two highest nodes that are orange in the band: what the band is about.
function title(nodes, short) {
	const orange = nodes.filter((n) => n.color === 'orange');
	const pick = (orange.length ? orange : nodes.filter((n) => n.color && n.color !== 'grey')).slice(-2);
	return pick.map((n) => short(n.name)).join(' & ');
}

function zoneWarn(z) {
	return z ? ` Zone level ${z.min}-${z.max}.` : '';
}

const shortOre = (n) => n.replace(/ (Mineral Vein|Vein|Deposit)$/, '');

const mining = {
	file: 'mining',
	skill: 'Mining',
	title: 'Mining 1-300',
	levels: '1-60',
	headerZone: 'Ironforge',
	role: 'mine',
	tool: { item: 2901, name: 'Mining Pick', why: 'keep it in your bags, you cannot mine without it.' },
	shortName: shortOre,
	points(ctx, map, from, to) {
		return R.nodePoints(ctx.data.objects, ctx.project, { table: MINING_NODES, role: 'mine', map, from, to });
	},
	bands: [
		{ from: 1, to: 65, scope: 'start' },
		{ from: 65, to: 125, scope: 'region' },
		{ from: 125, to: 155, scope: 'faction' },
		{ from: 155, to: 175, scope: 'faction' },
		{ from: 175, to: 230, scope: 'faction' },
		{ from: 230, to: 245, scope: 'faction' },
		{ from: 245, to: 275, scope: 'faction' },
		{ from: 275, to: 300, scope: 'faction' },
	],
	bandTitle(nodes) {
		return title(nodes, shortOre);
	},
	bandTip(nodes, e, z) {
		return `Mine every ${list(nodes, shortOre)} node you pass and circle the waypoints until Mining ${e.to}. Smelt the ore at a forge when your bags fill: smelting also raises Mining.${zoneWarn(z)}`;
	},
	header: [
		'Mining 1-300 for both factions: loops through the densest skill-up nodes for',
		'each skill band (expected skill-ups per yard walked), with rank training.',
		'Skill needed per node: Copper 1, Tin and Incendicite 65, Silver and Lesser',
		'Bloodstone 75, Iron 125, Gold 155, Mithril 175, Truesilver and Dark Iron 230,',
		'Small Thorium 245, Rich Thorium 275.',
		'',
		...ERA_NOTE,
	],
};

const herbalism = {
	file: 'herbalism',
	skill: 'Herbalism',
	title: 'Herbalism 1-300',
	levels: '1-60',
	headerZone: 'Ironforge',
	role: 'herb',
	points(ctx, map, from, to) {
		return R.nodePoints(ctx.data.objects, ctx.project, { table: HERB_NODES, role: 'herb', map, from, to });
	},
	bands: [
		{ from: 1, to: 50, scope: 'start' },
		{ from: 50, to: 100, scope: 'next' },
		{ from: 100, to: 125, scope: 'region' },
		{ from: 125, to: 160, scope: 'faction' },
		{ from: 160, to: 185, scope: 'faction' },
		{ from: 185, to: 210, scope: 'faction' },
		{ from: 210, to: 230, scope: 'faction' },
		{ from: 230, to: 260, scope: 'faction' },
		{ from: 260, to: 285, scope: 'faction' },
		{ from: 285, to: 300, scope: 'faction' },
	],
	bandTitle(nodes) {
		return title(nodes, (n) => n);
	},
	bandTip(nodes, e, z) {
		return `Pick every ${list(nodes, (n) => n)} you pass and circle the waypoints until Herbalism ${e.to}.${zoneWarn(z)}`;
	},
	header: [
		'Herbalism 1-300 for both factions: loops through the densest skill-up herbs',
		'for each skill band (expected skill-ups per yard walked), with rank training.',
		'Skill needed per herb: see tools/lib/professions/gathering/tables.js',
		'(Peacebloom and Silverleaf 1 ... Black Lotus 300).',
		'',
		...ERA_NOTE,
	],
};

const skinning = {
	file: 'skinning',
	skill: 'Skinning',
	title: 'Skinning 1-300',
	levels: '1-60',
	headerZone: 'Ironforge',
	tool: { item: 7005, name: 'Skinning Knife', why: 'keep it in your bags, you cannot skin without it.' },
	radius: 150,
	minPoints: 4,
	points: SKINNING_POINTS,
	bands: [
		{ from: 1, to: 50, scope: 'start' },
		{ from: 50, to: 100, scope: 'next' },
		{ from: 100, to: 125, scope: 'region' },
		{ from: 125, to: 150, scope: 'region' },
		{ from: 150, to: 175, scope: 'faction' },
		{ from: 175, to: 200, scope: 'faction' },
		{ from: 200, to: 225, scope: 'faction' },
		{ from: 225, to: 250, scope: 'faction' },
		{ from: 250, to: 275, scope: 'faction' },
		{ from: 275, to: 300, scope: 'faction' },
	],
	bandTitle(nodes) {
		const lv = nodes.map((n) => n.level);
		return `Beasts ${Math.min(...lv)}-${Math.max(...lv)}`;
	},
	bandTip(nodes, e, z) {
		const names = nodes.filter((n) => n.color && n.color !== 'grey').map((n) => `${n.name} (${n.level}${n.later ? `, needs ${n.req}` : ''})`);
		return `Kill and skin ${names.join(', ')} along the loop until Skinning ${e.to}; skin the highest-level beasts your skill allows. A beast of level L needs skill (L-10)x10 up to level 20 and Lx5 above.${zoneWarn(z)}`;
	},
	header: [
		'Skinning 1-300 for both factions: loops through the densest skinnable beasts',
		'of the right level for each skill band, with rank training. Skill needed: 1 for',
		'level 10 and below, (level-10)x10 for 11-20, level x5 above 20.',
		'Beast lists per zone are curated (tools/lib/professions/gathering/skinning.js);',
		'levels and spawns come from npcs.json.',
		'',
		...ERA_NOTE,
	],
};

const SPECS = [mining, herbalism, skinning, fishing, secondary.cooking, secondary.firstAid];

module.exports = { SPECS };
