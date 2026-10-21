'use strict';
// QuestieDB Forever import (tools/lib/data/questie.js, questie-merge.js):
// the baked-store decoder on a synthetic store encoded here (CBOR, zlib,
// base64, chunked values, presence masks, defaults), merge precedence
// (recordings > questie-forever > pfQuest) and map-frame tagging, on top of
// the tests/fixtures/data pfQuest and wago fixtures.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { decodeCbor, storedValue, readQuestie, dropRate, questieDbDir } = require('../tools/lib/data/questie');
const { raceMask } = require('../tools/lib/data/questie-merge');
const { extractQuestCounts, DB_REV } = require('../tools/lib/travel/cmangos');
const { buildData } = require('../tools/lib/data/build');
const { tmpdir } = require('./helpers/tmp');

const FIX = path.join(__dirname, 'fixtures', 'data');

// --- a minimal CBOR encoder (the shapes C_EncodingUtil.SerializeCBOR emits) ---

function head(major, n) {
	if (n < 24) return Buffer.from([(major << 5) | n]);
	if (n < 256) return Buffer.from([(major << 5) | 24, n]);
	if (n < 65536) {
		const b = Buffer.alloc(3);
		b[0] = (major << 5) | 25;
		b.writeUInt16BE(n, 1);
		return b;
	}
	if (n < 2 ** 32) {
		const b = Buffer.alloc(5);
		b[0] = (major << 5) | 26;
		b.writeUInt32BE(n, 1);
		return b;
	}
	const b = Buffer.alloc(9);
	b[0] = (major << 5) | 27;
	b.writeBigUInt64BE(BigInt(n), 1);
	return b;
}

function cbor(v) {
	if (v === null) return Buffer.from([0xf6]);
	if (v === true) return Buffer.from([0xf5]);
	if (v === false) return Buffer.from([0xf4]);
	if (typeof v === 'number') {
		if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
		const b = Buffer.alloc(9);
		b[0] = 0xfb;
		b.writeDoubleBE(v, 1);
		return b;
	}
	if (typeof v === 'string') {
		const s = Buffer.from(v, 'utf8');
		return Buffer.concat([head(3, s.length), s]);
	}
	if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
	if (v instanceof Map) {
		const parts = [head(5, v.size)];
		for (const [k, x] of v) parts.push(cbor(k), cbor(x));
		return Buffer.concat(parts);
	}
	// Plain objects: integer-looking keys become integer keys, as in Lua.
	return cbor(new Map(Object.entries(v).map(([k, x]) => [/^-?\d+$/.test(k) ? Number(k) : k, x])));
}

const b64 = (buf) => buf.toString('base64');

// --- a synthetic QuestieDB install -------------------------------------------

// Field layouts (synthetic indices: the decoder reads them from the meta files).
const METAS = {
	Quest: [
		['name', 'string'], ['startedBy', 'table', 'questgivers'], ['finishedBy', 'table', 'questgivers'],
		['requiredLevel', 'number'], ['questLevel', 'number'], ['requiredRaces', 'number'],
		['objectivesText', 'table', 'stringarray'], ['objectives', 'table', 'objectives'], ['preQuestSingle', 'table', 'idarray'],
		['preQuestGroup', 'table', 'idarray'], ['exclusiveTo', 'table', 'idarray'], ['nextQuestInChain', 'number'],
		['breadcrumbs', 'table', 'idarray'], ['triggerEnd', 'table', 'trigger'], ['zoneOrSort', 'number'],
		['requiredClasses', 'number'], ['retired', 'number', null, 7], ['breadcrumbForQuestId', 'number'],
		['parentQuest', 'number'], ['childQuests', 'table', 'idarray'], ['requiredSkill', 'table', 'pair'],
	],
	Npc: [
		['name', 'string'], ['minLevel', 'number'], ['maxLevel', 'number'], ['spawns', 'table', 'spawnlist'],
		['friendlyToFaction', 'string'], ['npcFlags', 'number'], ['questStarts', 'table', 'idarray'], ['rank', 'number'],
		['minLevelHealth', 'number', null, 0],
	],
	Object: [['name', 'string'], ['spawns', 'table', 'spawnlist'], ['questStarts', 'table', 'idarray'], ['questEnds', 'table', 'idarray'], ['factionID', 'number']],
	Item: [['name', 'string'], ['npcDrops', 'table', 'idarray'], ['objectDrops', 'table', 'idarray'], ['vendors', 'table', 'idarray']],
};
const META_FILE = { Quest: 'questMeta.lua', Npc: 'npcMeta.lua', Object: 'objectMeta.lua', Item: 'itemMeta.lua' };

function metaLua(entity) {
	const f = METAS[entity];
	const list = (pick) => f.map((x, i) => (pick(x) === null || pick(x) === undefined ? null : `[${i + 1}]=${typeof pick(x) === 'number' ? pick(x) : `'${pick(x)}'`}`)).filter(Boolean).join(', ');
	return `local _, LibQuestieDB = ...
local meta = {
  entity = '${entity}', metaPrefix = '${entity}-', fieldCount = ${f.length},
  names = { ${list((x) => x[0])} },
  types = { ${list((x) => x[1])} },
  structures = { ${list((x) => x[2])} },
  constantValues = { ${list((x) => x[3])} },
}
return meta
`;
}

// records: { id: { fieldName: value } } -> TOC lines. opts.chunk: ids whose
// scalar row is split into a two-part chunked value; opts.hidden: [id, field]
// table values stored without their presence bit.
function storeLines(entity, records, opts = {}) {
	const fields = METAS[entity];
	const lines = [];
	const ids = Object.keys(records).map(Number).sort((a, b) => a - b);
	const encIds = b64(zlib.deflateSync(cbor(ids)));
	lines.push(`## X-${entity}-IDS: ~2~`, `## X-${entity}-IDS-1: ${encIds.slice(0, 10)}`, `## X-${entity}-IDS-2: ${encIds.slice(10)}`);
	for (const id of ids) {
		const row = new Map();
		let p = 0;
		fields.forEach(([name, type, , constant], i) => {
			const v = records[id][name];
			if (v === undefined || constant !== undefined) return;
			if (type === 'table') {
				p += 2 ** i;
				lines.push(`## X-${entity}-${id}-${i + 1}: ${b64(cbor(v))}`);
			} else {
				row.set(i + 1, v);
			}
		});
		row.set('p', p);
		const s = b64(cbor(row));
		if ((opts.chunk || []).includes(id)) {
			lines.push(`## X-${entity}-${id}-S: ~2~`, `## X-${entity}-${id}-S-1: ${s.slice(0, 7)}`, `## X-${entity}-${id}-S-2: ${s.slice(7)}`);
		} else {
			lines.push(`## X-${entity}-${id}-S: ${s}`);
		}
	}
	for (const [id, name, v] of opts.hidden || []) {
		const i = fields.findIndex((f) => f[0] === name);
		lines.push(`## X-${entity}-${id}-${i + 1}: ${b64(cbor(v))}`);
	}
	return lines;
}

const QUESTS = {
	100: { name: 'Fixture Calling (Questie)', questLevel: 3, requiredLevel: 1, startedBy: [[1]], finishedBy: [[2]], objectivesText: ['Speak with Alice.'] },
	101: {
		name: 'Wolf Trouble', questLevel: 3, requiredLevel: 2, requiredRaces: 77, requiredClasses: 1,
		startedBy: [[2]], finishedBy: [[2]],
		objectivesText: ['Bring 3 pieces of Wolf Pelt, and kill 10 Fixture Wolves and 4 Fixture Wolf Alphas for Alice.'],
		objectives: [[{ 1: 3, 3: 0 }, { 1: 4, 3: 0 }], [], [{ 1: 50, 3: 0 }]],
		preQuestSingle: [100], exclusiveTo: [102, 105], breadcrumbs: [103], childQuests: [104], requiredSkill: [393, 1],
	},
	102: { name: 'Fixture Altar', questLevel: 4, requiredLevel: 2, startedBy: [[], [500]], finishedBy: [[], [500]], preQuestSingle: [101, 102, 100] },
	// Sparse questgivers (object slot only) and an ender known only from the object's questEnds.
	92461: { name: 'The Missing Scholar', questLevel: 5, requiredLevel: 2, startedBy: { 2: [700] } },
	92460: {
		name: 'Coming of Age', questLevel: 1, requiredLevel: 1, requiredRaces: 2 ** 32 + 2 ** 33,
		startedBy: [[251362]], finishedBy: [[251361]], objectivesText: ['Find the shrine.', '', 'Return to Rorian.'],
		preQuestGroup: [100], zoneOrSort: 16593, triggerEnd: ['Find the shrine', { 16593: [[40.5, 60.25]] }],
		breadcrumbForQuestId: 92461, parentQuest: 100, retired: 99,
	},
};
const NPCS = {
	1: { name: 'Bob', minLevel: 20, maxLevel: 20, spawns: { 12: [[48.9, 41.6]] }, friendlyToFaction: 'A', npcFlags: 10 },
	2: { name: 'Alice', minLevel: 5, maxLevel: 6, rank: 1, spawns: { 12: [[42.1, 65.9]], 1519: [[60, 60]] }, friendlyToFaction: 'AH', npcFlags: 6, questStarts: [101] },
	3: { name: 'Fixture Wolf', minLevel: 2, maxLevel: 3, spawns: { 12: [[21, 31]] }, friendlyToFaction: 'AH', npcFlags: 0 },
	251361: { name: 'Rorian the Dayseeker', minLevel: 1, maxLevel: 1, spawns: { 16593: [[44, 25]] }, friendlyToFaction: 'AH', npcFlags: 2 },
	251362: { name: 'Ailee Farheart', minLevel: 1, maxLevel: 1, spawns: { 16593: [[42.82, 23.37], [-1, -1]] }, friendlyToFaction: 'AH', npcFlags: 2, questStarts: [92460] },
};
const OBJECTS = { 500: { name: 'Fixture Altar', spawns: { 12: [[30.12, 40.99]] } }, 700: { name: 'Bloodstained Satchel', spawns: { 16593: [[53.25, 72.17]] }, questStarts: [92461], questEnds: [92461] }, 600: { name: 'Peacebloom', spawns: { 1519: [[10, 10]] } } };
const ITEMS = {
	50: { name: 'Wolf Pelt', npcDrops: [3, 4] },
	// QuestieDB lists fewer vendors than pfQuest (16042 Schematic: Thorium Widget shape).
	52: { name: 'Fixture Schematic', vendors: [2] },
	252665: { name: "Head of Urs'anah", npcDrops: [251361] },
};

// store: { quests, npcs, objects (added to QUESTS, NPCS, OBJECTS), files ({ path in QuestieDB: text }) }
function writeQuestie(dir, store = {}) {
	const q = path.join(dir, 'QuestieDB');
	const w = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(q, rel)), { recursive: true });
		fs.writeFileSync(path.join(q, rel), text);
	};
	const toc = [
		'## Interface: 16001', '## Title: QuestieDB', '## Author: Fixture Authors', '## Version: 9.9.9',
		'## X-Contract-Version: 3', '## X-Flavor: Forever', '## X-Mode: baked', '## X-BUILD-COMMIT: abc123', '## X-BUILD-TIME: 2026-01-01T00:00:00Z', '',
		...storeLines('Quest', { ...QUESTS, ...(store.quests || {}) }, { chunk: [92460], hidden: [[92460, 'breadcrumbs', [7]]] }),
		...storeLines('Npc', { ...NPCS, ...(store.npcs || {}) }),
		...storeLines('Object', { ...OBJECTS, ...(store.objects || {}) }),
		...storeLines('Item', ITEMS),
		'', 'src\\config.lua', '',
	];
	w('QuestieDB_Forever.toc', toc.join('\r\n'));
	for (const e of Object.keys(METAS)) w(`src/meta/${META_FILE[e]}`, metaLua(e));
	w('support/Forever/QuestXP/xpDB-classic.lua', 'local QuestXP = QuestieLoader:ImportModule("QuestXP");\nQuestXP.db = {\n  [100] = {1, 85},\n  [101] = {3, 170},\n  [92460] = {1, 40},\n}\n');
	w(
		'support/Forever/DropTables/classicItemDrops.lua',
		'local D = QuestieLoader:CreateModule("QuestieClassicItemDrops")\nD.wowheadData = [[return {\n  [50] = { [3] = 12.5, [4] = 20 },\n}]]\nD.cmangosData = [[return {\n  [50] = { [4] = 70.0 },\n}]]\n',
	);
	w(
		'support/Forever/DropTables/itemDropCorrections.lua',
		'local DropDB = QuestieLoader:ImportModule("DropDB")\nlocal K = DropDB.correctionKeys\nlocal C = QuestieLoader:CreateModule("QuestieItemDropCorrections")\nC.Era = {\n  [50] = { [3] = K.PSERVER },\n  [252665] = { [251361] = 100 },\n}\n',
	);
	w('support/Forever/Zones/areaIdToUiMapId.lua', 'local ZoneDB = QuestieLoader:ImportModule("ZoneDB")\nZoneDB.private.areaIdToUiMapIdOverride = [[return { [0] = 0 }]]\nZoneDB.private.areaIdToUiMapId = [[return {\n  [12] = 1429, [87] = 1429, [1519] = 1453, [16593] = 2521,\n}]]\n');
	w('support/Forever/Zones/uiMapIdToAreaId.lua', 'local ZoneDB = QuestieLoader:ImportModule("ZoneDB")\nZoneDB.private.uiMapIdToAreaId = [[return {\n  [1429] = 12, [1453] = 1519, [2521] = 16593,\n}]]\n');
	w('support/Forever/FactionTemplates/factionTemplateClassic.lua', 'local Q = QuestieLoader:ImportModule("QuestieDB")\nQ.factionTemplate = { [12] = 4, [29] = 2, [35] = 0, [99] = 6 }\n');
	w(
		'src/support/eraToForever.lua',
		'-- DBC bounds: 1.15.9.1 -> 1.60.1.2. Assumes unchanged world positions.\nlocal transforms = {\n  [1519] = { 0.77, 19.68, 0.77, 24.43 }, -- Stormwind City\n}\nlocal uiMapToArea = {\n  [1453] = 1519, -- Stormwind City\n}\n',
	);
	w('../Questie/Questie_Camelot.toc', '## Title: Questie\n## Version: 8.8.8\n## Author: Fixture Questie Authors\n## X-BUILD-COMMIT: def456\n');
	for (const [rel, text] of Object.entries(store.files || {})) w(rel, text);
	return q;
}

async function build(extra = {}, store = {}) {
	const root = tmpdir('polestar-questie-');
	const questieDir = writeQuestie(root, store);
	const outDir = path.join(root, 'out');
	const result = await buildData({
		offline: true,
		pfquestDir: path.join(FIX, 'pfquest'),
		sourcesDir: path.join(FIX, 'sources'),
		recordingsDir: path.join(root, 'no-recordings'),
		questieDir,
		outDir,
		builtAt: '2026-01-01T00:00:00Z',
		...extra,
	});
	const read = (name) => JSON.parse(fs.readFileSync(path.join(outDir, `${name}.json`), 'utf8'));
	return { result, read, questieDir, root };
}

// --- tests --------------------------------------------------------------------

describe('QuestieDB decoder', () => {
	test('CBOR round trip: integers past 2^32, floats, UTF-8, arrays and Lua-style maps', () => {
		const values = [
			0, 23, 24, 255, 65535, 65536, 2 ** 32 - 1, 2 ** 32 + 2 ** 33, -1, -500, 1.5, -48.92, "Urs'anah ü", '',
			[1, [2, [3]], 'x'], true, false,
		];
		for (const v of values) assert.deepEqual(decodeCbor(cbor(v)), v);
		// Map keys 1..n read back as a list; anything else as a string-keyed object.
		assert.deepEqual(decodeCbor(cbor(new Map([[1, 'a'], [2, 'b']]))), ['a', 'b']);
		assert.deepEqual(decodeCbor(cbor(new Map([[1, 182], [3, 0]]))), { 1: 182, 3: 0 });
		assert.deepEqual(decodeCbor(cbor(new Map([[16593, [[40.5, 60.25]]], ['p', 6]]))), { 16593: [[40.5, 60.25]], p: 6 });
		// Half and single floats, byte strings, tags, indefinite arrays, null entries.
		assert.equal(decodeCbor(Buffer.from([0xf9, 0x3e, 0x00])), 1.5);
		assert.equal(decodeCbor(Buffer.from([0xfa, 0x3f, 0xc0, 0x00, 0x00])), 1.5);
		assert.equal(decodeCbor(Buffer.from([0x43, 0x41, 0x42, 0x43])), 'ABC');
		assert.equal(decodeCbor(Buffer.from([0xc1, 0x05])), 5);
		assert.deepEqual(decodeCbor(Buffer.from([0x9f, 0x01, 0x02, 0xff])), [1, 2]);
		assert.deepEqual(decodeCbor(Buffer.from([0x83, 0x01, 0xf6, 0x03])), { 1: 1, 3: 3 }, 'a nil hole breaks the list, as in Lua');
		assert.throws(() => decodeCbor(Buffer.from([0x01, 0x02])), /trailing/);
		assert.throws(() => decodeCbor(Buffer.from([0x82, 0x01])), /truncated/);
	});

	test('chunked values reassemble; a missing part is corruption', () => {
		const m = new Map([['K', '~2~'], ['K-1', 'ab'], ['K-2', 'cd'], ['L', 'plain'], ['M', '~3~'], ['M-1', 'x']]);
		assert.equal(storedValue(m, 'K'), 'abcd');
		assert.equal(storedValue(m, 'L'), 'plain');
		assert.equal(storedValue(m, 'nope'), null);
		assert.throws(() => storedValue(m, 'M'), /declares 3 parts but part 2 is missing/);
	});

	test('reads every entity with defaults, presence masks and constants', () => {
		const dir = writeQuestie(tmpdir('polestar-questie-'));
		assert.equal(questieDbDir(path.dirname(dir)), dir, 'an AddOns folder resolves to its QuestieDB');
		const qz = readQuestie(dir);
		assert.deepEqual([...qz.quests.keys()], [100, 101, 102, 92460, 92461]);
		assert.deepEqual(qz.quests.get(92461).startedBy, { 2: [700] }, 'sparse questgivers decode as a Lua table with a hole');
		const q = qz.quests.get(92460);
		assert.equal(q.name, 'Coming of Age', 'chunked scalar row');
		assert.equal(q.requiredRaces, 2 ** 32 + 2 ** 33);
		assert.deepEqual(q.startedBy, [[251362]]);
		assert.deepEqual(q.triggerEnd, ['Find the shrine', { 16593: [[40.5, 60.25]] }]);
		assert.equal(q.breadcrumbs, undefined, 'a stored table without its presence bit is not read');
		assert.equal(q.retired, 7, 'constant fields read back as the schema constant');
		assert.equal(q.nextQuestInChain, 0, 'absent numbers read back as 0');
		assert.deepEqual(qz.quests.get(100).objectives, [], 'objectives (never-nil structure) default to an empty table');
		assert.deepEqual(qz.quests.get(102).startedBy, [[], [500]]);
		assert.equal(qz.quests.get(100).preQuestSingle, undefined);
		assert.equal(qz.npcs.get(251362).minLevelHealth, 0);
		assert.deepEqual(qz.npcs.get(2).spawns, { 12: [[42.1, 65.9]], 1519: [[60, 60]] });
		assert.equal(qz.objects.get(500).name, 'Fixture Altar');
		assert.equal(qz.objects.get(500).factionID, 0, 'absent object faction templates retain the numeric default');
		assert.deepEqual(qz.items.get(50).npcDrops, [3, 4]);
		// Support data.
		assert.deepEqual(qz.xp.get(92460), { level: 1, xp: 40 });
		assert.deepEqual([...qz.factionTemplates], [[12, 4], [29, 2], [35, 0], [99, 6]]);
		assert.equal(qz.areaToUiMap.get(16593), 2521);
		assert.equal(qz.uiMapToArea.get(2521), 16593);
		assert.deepEqual([...qz.eraToForever.uiMapToArea], [[1453, 1519]]);
		assert.deepEqual(qz.eraToForever.dbc, { from: '1.15.9.1', to: '1.60.1.2' });
		assert.deepEqual(qz.info.questie, { title: 'Questie', version: '8.8.8', author: 'Fixture Questie Authors', buildCommit: 'def456', buildTime: null });
		// DropDB.GetItemDroprate order: correction (a reference falls through when missing), pserver, wowhead.
		assert.deepEqual(dropRate(qz.drops, 50, 3), { chance: 12.5, source: 'wowhead' });
		assert.deepEqual(dropRate(qz.drops, 50, 4), { chance: 70, source: 'cmangos' });
		assert.deepEqual(dropRate(qz.drops, 252665, 251361), { chance: 100, source: 'questie' });
		assert.equal(dropRate(qz.drops, 50, 99), null);
	});

	test('race masks keep the Skyborne bits; all races means unrestricted', () => {
		assert.equal(raceMask(77), 77);
		assert.equal(raceMask(2 ** 32), 2 ** 32);
		assert.equal(raceMask(255 + 2 ** 32 + 2 ** 33), null);
		assert.equal(raceMask(255), 255, 'all Era races but no Skyborne is a restriction');
		assert.equal(raceMask(0), null);
	});

	test('refuses a store that is not baked Forever', () => {
		const dir = writeQuestie(tmpdir('polestar-questie-'));
		const toc = path.join(dir, 'QuestieDB_Forever.toc');
		fs.writeFileSync(toc, fs.readFileSync(toc, 'utf8').replace('## X-Flavor: Forever', '## X-Flavor: Era'));
		assert.throws(() => readQuestie(dir), /flavor Era, not Forever/);
	});
});

describe('QuestieDB merge', () => {
	test('mailboxes keep their role and known friendly side through pfQuest and recording overlays', async () => {
		const mailbox = (factionID) => ({ name: 'Mailbox', factionID, spawns: { 12: [[30, 40]] } });
		const { read } = await build({ recordingsDir: path.join(FIX, 'recordings') }, {
			objects: {
				500: mailbox(29), 600: mailbox(12), 801: mailbox(35), 802: mailbox(99),
				803: mailbox(999), 804: { name: 'Mailbox', spawns: { 12: [[31, 41]] } },
				805: { name: 'mailbox', factionID: 35, spawns: { 12: [[32, 42]] } },
			},
		});
		const objects = read('objects');
		assert.deepEqual(objects[500].roles, ['mailbox']);
		assert.equal(objects[500].faction, 'H');
		assert.equal(objects[500].name, 'Fixture Altar', 'observed name may change without losing mailbox identity');
		assert.deepEqual(objects[500].spawns, { 1429: { f: 'l', pts: [[31.5, 41.25]] } });
		assert.deepEqual(Object.keys(objects[500]).slice(0, 5), ['id', 'name', 'roles', 'faction', 'spawns']);
		assert.deepEqual(objects[600].roles, ['herb', 'mailbox'], 'pfQuest gathering roles survive');
		assert.equal(objects[600].faction, 'A');
		assert.deepEqual(objects[801].roles, ['mailbox']);
		assert.equal(objects[801].faction, 'AH', 'known template with no enemy player side');
		assert.equal(objects[804].faction, 'AH', 'zero faction ID follows Questie mailbox semantics: available to both sides');
		for (const id of [802, 803]) {
			assert.deepEqual(objects[id].roles, ['mailbox']);
			assert.equal(objects[id].faction, null, `hostile-both or unknown template stays unknown: ${id}`);
		}
		assert.equal(objects[805].roles, undefined, 'classification uses the exact raw English object name');
		assert.equal(objects[805].faction, undefined, 'unrelated objects gain no faction field');
	});

	test('services retain close spawn positions, spirit guides, and only fill missing service NPC factions', async () => {
		const points = [[30, 40], [30.1, 40.1]];
		const npc = (npcFlags, friendlyToFaction) => ({ name: 'Fixture Service', minLevel: 10, spawns: { 12: points }, npcFlags, friendlyToFaction });
		const { read } = await build({ cap: 1 }, {
			npcs: { 2: npc(4, 'H'), 3: npc(4, 'H'), 4: npc(0, 'A'), 812: npc(32 + 64, 'AH') },
			objects: { 813: { name: 'Mailbox', factionID: 35, spawns: { 12: points } }, 814: { name: 'Fixture Stone', spawns: { 12: points } } },
		});
		const npcs = read('npcs');
		assert.equal(npcs[2].faction, 'AH', 'existing pfQuest service side wins');
		assert.equal(npcs[3].faction, 'H', 'new service flag fills an unknown pfQuest side');
		assert.equal(npcs[4].faction, null, 'nonservice wildlife keeps its existing faction semantics');
		assert.deepEqual(npcs[812].roles, ['spirithealer'], 'spirit healer and guide bits share one role');
		for (const entity of [npcs[3], npcs[812], read('objects')[813]]) {
			const spawn = entity.spawns[1429];
			assert.equal(spawn.pts.length, 1);
			assert.deepEqual([...spawn.pts, ...(spawn.more || [])].sort((a, b) => a[0] - b[0]), points, 'cap keeps the other close service point in more');
		}
		assert.equal(read('objects')[814].spawns[1429].more, undefined, 'ordinary objects retain spatial reduction');
	});

	test('Forever-only quests, npcs and items are added', async () => {
		const { read } = await build();
		const q = read('quests');
		assert.deepEqual(q[92460], {
			id: 92460, title: 'Coming of Age', level: 1, minLevel: 1, races: 2 ** 32 + 2 ** 33, classes: null,
			start: { npc: [251362], object: [], item: [] }, end: { npc: [251361], object: [] },
			pre: [100], excl: [], next: null,
			objectives: [{ type: 'event', id: null, count: null, text: 'Find the shrine', map: 2521, f: 'l', x: 40.5, y: 60.25 }],
			objectiveText: 'Find the shrine.$B$BReturn to Rorian.', zone: 2521, xp: 40, skill: null, event: null,
			source: ['questie-forever'], preAll: [100], breadcrumbFor: 92461, parent: 100, area: 16593,
		});
		const npcs = read('npcs');
		assert.deepEqual(npcs[251362], { id: 251362, name: 'Ailee Farheart', level: 1, faction: 'AH', spawns: { 2521: { f: 'l', pts: [[42.82, 23.37]] } }, source: ['questie-forever'] });
		assert.deepEqual(read('items')[252665], { id: 252665, name: "Head of Urs'anah", drops: { npc: { 251361: 100 }, object: {} }, vendors: [], source: ['questie-forever'] });
		assert.deepEqual(read('zones')[2521], { id: 2521, name: null, areaId: 16593, parent: null, type: 3 });
	});

	test('shared entities: Questie wins on the fields it has, pfQuest-only fields stay', async () => {
		const { read, result } = await build();
		const q = read('quests');
		assert.equal(q[100].title, 'Fixture Calling (Questie)');
		assert.equal(q[100].level, 3);
		assert.equal(q[100].xp, 85, 'xp from QuestieDB QuestXP');
		assert.deepEqual(q[100].source, ['pfquest', 'questie-forever']);
		// 101: objectives in the order the game lists them, creatures before
		// items, though the text names the pelts first; counts from the text.
		assert.deepEqual(q[101].objectives, [
			{ type: 'kill', id: 3, count: 10, text: 'Fixture Wolf' },
			{ type: 'kill', id: 4, count: 4, text: 'Fixture Wolf Alpha' },
			{ type: 'item', id: 50, count: 3, text: 'Wolf Pelt' },
		]);
		assert.deepEqual(q[101].pre, [100]);
		assert.deepEqual(q[101].preAny, [100]);
		assert.deepEqual(q[101].excl, [102, 105]);
		assert.deepEqual(q[101].breadcrumbs, [103]);
		assert.deepEqual(q[101].children, [104]);
		assert.equal(q[101].races, 77);
		assert.equal(q[101].skill, 393, "the profession from QuestieDB's requiredSkill");
		assert.equal(q[101].skillLevel, 1);
		// 102: Questie has no objectives or event: pfQuest's stay. It has no
		// requiredSkill either, and that is Forever's answer: pfQuest's Classic
		// Mining (186) is dropped, as Beer Basted Boar Ribs (384) lost pfQuest's
		// Cooking, which Forever does not ask for (thmastin's report).
		assert.equal(q[102].event, 12);
		assert.equal(q[102].skill, null);
		assert.equal('skillLevel' in q[102], false);
		assert.equal(q[102].objectives.length, 2);
		assert.equal('preAll' in q[102], false, 'fields Questie has no value for are omitted');
		assert.deepEqual(q[102].preAny, [100], 'a quest never requires itself or a quest exclusive with it');
		assert.equal(result.meta.counts.prereqsCleaned, 1);
		// 104: pfQuest only.
		assert.deepEqual(q[104].source, ['pfquest']);
		assert.deepEqual(result.meta.questie.notInStore, [104]);

		const npcs = read('npcs');
		assert.deepEqual(npcs[2].roles, ['vendor'], 'npc flags give roles');
		assert.equal(npcs[2].faction, 'AH', 'faction stays pfQuest’s');
		assert.equal(npcs[3].faction, null, 'Questie "AH" (not hostile) on wildlife is not a side');
		assert.deepEqual(npcs[1].roles, ['flightmaster']);
		assert.deepEqual(npcs[1].source, ['pfquest', 'questie-forever']);
		// Gathering nodes keep pfQuest's maps that QuestieDB does not list.
		assert.deepEqual(read('objects')[600].spawns, { 1429: { f: 'e', pts: [[33.3, 44.4]] }, 1453: { f: 'l', pts: [[10, 10]] } });
		const items = read('items');
		assert.deepEqual(items[50].drops, { npc: { 3: 12.5, 4: 70, 5: 2.5 }, object: { 600: 2.5 } }, 'union: DropDB chances win, pfQuest-only droppers and objects kept');
		assert.deepEqual(items[52].vendors, [1, 2], 'a shorter QuestieDB vendor list never drops pfQuest vendors');
		assert.deepEqual(items[52].source, ['pfquest', 'questie-forever']);
		assert.equal(result.meta.counts.itemsRegainedEntries, 2);

		const src = result.meta.sources.find((s) => /QuestieDB/.test(s.name));
		assert.equal(src.revision, '9.9.9 abc123');
		assert.equal(src.questie.version, '8.8.8');
		assert.match(src.license, /all rights reserved/);
		assert.equal(result.meta.counts.questieOnlyQuests, 2);
		assert.deepEqual(q[92461].start, { npc: [], object: [700], item: [] }, 'sparse questgivers keep the object slot');
		assert.deepEqual(q[92461].end, { npc: [], object: [700] }, 'ender from the object questEnds');
		assert.equal(result.meta.counts.reverseLinks, 1);
		assert.equal(result.meta.counts.questsWithXp, 3);
	});

	test('recordings win over QuestieDB', async () => {
		const { read } = await build({ recordingsDir: path.join(FIX, 'recordings') });
		const q = read('quests');
		assert.equal(q[100].title, 'Fixture Calling (Forever)');
		assert.equal(q[100].level, 2);
		assert.equal(q[100].xp, 40, 'recorded xp beats QuestXP');
		assert.deepEqual(q[100].source, ['pfquest', 'questie-forever', 'recorder', 'recorder:xp-turnin']);
		assert.deepEqual(read('npcs')[1].spawns, { 1429: { f: 'l', pts: [[47.5, 40.25]] } });
	});

	// tools/lib/data/corrections.json: dungeon quests whose Forever XP is about
	// twice the Classic QuestXP the store has (issue #394), corrected from dated in-game evidence.
	test('corrections.json gives dungeon quests their Forever XP over QuestieDB\'s QuestXP', async () => {
		const quest = (name, questLevel) => ({ name, questLevel, requiredLevel: 1, startedBy: [[2]], finishedBy: [[2]] });
		const { read } = await build({}, {
			quests: { 377: quest('Crime and Punishment', 26), 1486: quest('Deviate Hides', 17) },
			files: { 'support/Forever/QuestXP/xpDB-classic.lua': 'local QuestXP = QuestieLoader:ImportModule("QuestXP");\nQuestXP.db = {\n  [377] = {26, 2100},\n  [1486] = {17, 1600},\n}\n' },
		});
		const q = read('quests');
		assert.equal(q[377].xp, 4400, 'Crime and Punishment: The Stockade');
		assert.equal(q[1486].xp, 3100, 'Deviate Hides: Wailing Caverns');
		for (const id of [377, 1486]) assert.ok(q[id].source.includes('polestar-correction'), `${id} is tagged as corrected`);
	});

	// MgM's report (#462): QuestieDB's Forever store gives Deviate Hides (1486)
	// an Orgrimmar Mailbox and Poor Old Blanchy (151) a Stormwind one as a
	// second giver, so the Wailing Caverns pick-up page sent a player from
	// Tirisfal to the Orgrimmar mailbox. Forever's quest data has only the NPC;
	// corrections.json sets it after the merge.
	test("MgM's report: corrections.json leaves Nalpak and Verna Furlbrow as the only givers, not the mailboxes", async () => {
		const { read } = await build({}, {
			quests: {
				1486: { name: 'Deviate Hides', questLevel: 17, requiredLevel: 13, startedBy: [[5767], [659159]], finishedBy: [[5767]] },
				151: { name: 'Poor Old Blanchy', questLevel: 10, requiredLevel: 7, startedBy: [[238], [696264]], finishedBy: [[238]] },
			},
			npcs: {
				5767: { name: 'Nalpak', minLevel: 22, maxLevel: 22, spawns: { 17: [[46, 35.7]] }, friendlyToFaction: 'AH', npcFlags: 2, questStarts: [1486] },
				238: { name: 'Verna Furlbrow', minLevel: 14, maxLevel: 14, spawns: { 40: [[59.9, 19.4]] }, friendlyToFaction: 'A', npcFlags: 2, questStarts: [151] },
			},
			objects: {
				659159: { name: 'Mailbox', spawns: { 1637: [[50.9, 70.4]] }, questStarts: [1486] },
				696264: { name: 'Mailbox', spawns: { 1519: [[61.7, 70.7]] }, questStarts: [151] },
			},
		});
		const q = read('quests');
		assert.deepEqual(q[1486].start, { npc: [5767], object: [], item: [] });
		assert.deepEqual(q[151].start, { npc: [238], object: [], item: [] });
		assert.ok(q[1486].source.includes('polestar-correction'));
	});

	// The fields #471 left alone: the client gives Nat's Measuring Tape no
	// StartQuestID (only the Battered Tackle Box starts 8227), and A Sealed Crate
	// (91901) starts at both factions' trade representatives.
	test('corrections.json: Nat\'s Measuring Tape starts only at the tackle box; Dokimi and Marcy Baker both give A Sealed Crate', async () => {
		const { read } = await build({}, {
			quests: {
				8227: { name: "Nat's Measuring Tape", questLevel: 60, requiredLevel: 58, startedBy: [[], [180366], [19973]], finishedBy: [[12919]] },
				91901: { name: 'A Sealed Crate', questLevel: 60, requiredLevel: 1, startedBy: [[256386]], finishedBy: [[256386]] },
			},
			npcs: {
				12919: { name: 'Nat Pagle', minLevel: 45, maxLevel: 45, spawns: { 15: [[58.6, 60.1]] }, friendlyToFaction: 'AH', npcFlags: 2, questEnds: [8227] },
				256386: { name: 'Dokimi', minLevel: 30, maxLevel: 30, spawns: { 17: [[50.15, 29.35]] }, friendlyToFaction: 'H', npcFlags: 2, questStarts: [91901], questEnds: [91901] },
			},
			objects: {
				180366: { name: 'Battered Tackle Box', spawns: {}, questStarts: [8227] },
			},
		});
		const q = read('quests');
		assert.deepEqual(q[8227].start, { npc: [], object: [180366], item: [] });
		assert.deepEqual(q[91901].start, { npc: [256386, 256390], object: [], item: [] });
	});

	// Forever's quest data shows only one faction's NPC on some shared quests:
	// Storm, Earth, and Fire (79358) ends at the Horde's Rau Cliffrunner there,
	// yet the Alliance Shaman chain hands it to Veyric Thunderhame in Arathi.
	test('corrections.json: Storm, Earth, and Fire ends at both Rau Cliffrunner and Veyric Thunderhame', async () => {
		const { read } = await build({}, {
			quests: {
				79358: { name: 'Storm, Earth, and Fire', questLevel: 40, requiredLevel: 30, startedBy: [[259023]], finishedBy: [[4722, 259023]] },
			},
			npcs: {
				4722: { name: 'Rau Cliffrunner', minLevel: 30, maxLevel: 30, spawns: { 400: [[46.1, 51.7]] }, friendlyToFaction: 'H', npcFlags: 2, questEnds: [79358] },
				259023: { name: 'Veyric Thunderhame', minLevel: 40, maxLevel: 40, spawns: { 45: [[59.8, 27.6]] }, friendlyToFaction: 'A', npcFlags: 2, questStarts: [79358], questEnds: [79358] },
			},
		});
		assert.deepEqual(read('quests')[79358].end, { npc: [4722, 259023], object: [] });
	});

	test("objectives come in the game's order: creatures, objects, items, kill credits, the trigger", async () => {
		const { read } = await build({}, {
			quests: {
				// The Guns of Northwatch: the text names the medals first, the game
				// lists the three kills first and the medals fourth.
				891: {
					name: 'The Guns of Northwatch', questLevel: 20, requiredLevel: 13, startedBy: [[2]], finishedBy: [[2]],
					objectivesText: ["Captain Thalo'thas Brightsun of Ratchet wants you to collect 10 Theramore Medals and slay Captain Fairmount, Cannoneer Whessan and Cannoneer Smythe."],
					objectives: [[{ 1: 3393, 2: 'Captain Fairmount' }, { 1: 3455, 2: 'Cannoneer Whessan' }, { 1: 3454, 2: 'Cannoneer Smythe' }], [], [{ 1: 5078, 2: 'Theramore Medal' }]],
				},
				110: {
					name: 'Fixture Order', questLevel: 3, requiredLevel: 1, startedBy: [[2]], finishedBy: [[2]],
					objectivesText: ['Scout the ridge, question Bob, bring 3 Wolf Pelts, light the Fixture Altar and kill 5 Fixture Wolves.'],
					objectives: { 1: [{ 1: 3 }], 2: [{ 1: 500 }], 3: [{ 1: 50 }], 5: [{ 1: [1, 2], 2: 1, 3: 'Bob questioned' }] },
					triggerEnd: ['Scout the ridge', { 12: [[50, 50]] }],
				},
			},
		});
		const q = read('quests');
		const order = (id) => q[id].objectives.map((o) => `${o.type} ${o.id ?? o.text}`);
		assert.deepEqual(order(891), ['kill 3393', 'kill 3455', 'kill 3454', 'item 5078']);
		assert.equal(q[891].objectives[3].count, 10);
		assert.deepEqual(order(110), ['kill 3', 'object 500', 'item 50', 'kill 1', 'event Scout the ridge']);
	});

	// How Big a Threat? (984) lists four furbolg camps, the first far north-east
	// of Auberdine; its map marker pointed there (#560).
	test("a trigger at several places keeps the one nearest the giver on that map, else the first", async () => {
		const quest = (name, giver) => ({ name, questLevel: 3, requiredLevel: 1, startedBy: [[giver]], finishedBy: [[giver]], triggerEnd: ['Find a camp', { 12: [[80, 20], [44, 62], [10, 90]] }] });
		const { read } = await build({}, { quests: { 130: quest('Fixture Camps', 2), 131: quest('Fixture Camps Elsewhere', 251361) } });
		const q = read('quests');
		const at = (id) => { const o = q[id].objectives[0]; return [o.map, o.x, o.y]; };
		assert.deepEqual(at(130), [1429, 44, 62], 'the giver stands at 42.1,65.9 on the same map');
		assert.deepEqual(at(131), [1429, 80, 20], 'the giver is on another map: the first point');
	});

	test("QuestieDB's hints move a kind to the front; commented hints and other scopes' do not count", async () => {
		const quest = (name) => ({ name, questLevel: 3, requiredLevel: 1, startedBy: [[2]], finishedBy: [[2]], objectives: [[{ 1: 3 }], [], [{ 1: 50 }]] });
		const { read } = await build({}, {
			quests: { 111: quest('Fixture Item First'), 112: quest('Fixture Commented'), 113: quest('Fixture Era'), 114: quest('Fixture Season') },
			files: {
				'src/corrections/Forever/legacy/classicQuestFixes.lua': 'QuestieCorrections.itemObjectiveFirst[111] = true\n-- QuestieCorrections.itemObjectiveFirst[112] = true\n',
				'src/corrections/Era/classicQuestFixes.lua': 'QuestieCorrections.itemObjectiveFirst[113] = true\n',
				'src/corrections/Sod/sodQuestFixes.lua': 'QuestieCorrections.itemObjectiveFirst[114] = true\n',
			},
		});
		const q = read('quests');
		const order = (id) => q[id].objectives.map((o) => `${o.type} ${o.id}`);
		assert.deepEqual(order(111), ['item 50', 'kill 3']);
		for (const id of [112, 113, 114]) assert.deepEqual(order(id), ['kill 3', 'item 50'], `quest ${id}`);
	});

	// CMaNGOS classic-db quest_template (tools/lib/travel/cmangos.js
	// loadQuestCounts) fills the counts QuestieDB's store and pfQuest lack.
	describe('objective counts from classic-db', () => {
		const COLS = ['entry', 'Title', ...[1, 2, 3, 4].map((i) => `ReqItemId${i}`), ...[1, 2, 3, 4].map((i) => `ReqItemCount${i}`), ...[1, 2, 3, 4].map((i) => `ReqCreatureOrGOId${i}`), ...[1, 2, 3, 4].map((i) => `ReqCreatureOrGOCount${i}`)];
		// One quest_template row: items and creatures/objects as [id, count] (a negative id is a gameobject).
		const row = (entry, items = [], kills = []) => {
			const pad = (list) => [0, 1, 2, 3].map((i) => list[i] || [0, 0]);
			const it = pad(items);
			const kl = pad(kills);
			return `(${[entry, "'Fixture\\'s quest'", ...it.map((e) => e[0]), ...it.map((e) => e[1]), ...kl.map((e) => e[0]), ...kl.map((e) => e[1])].join(',')})`;
		};
		const DUMP = [
			'CREATE TABLE `quest_template` (',
			...COLS.map((c) => `  \`${c}\` mediumint NOT NULL DEFAULT '0',`),
			'  PRIMARY KEY (`entry`)',
			') ENGINE=MyISAM;',
			`INSERT INTO \`quest_template\` VALUES ${[
				row(120, [[50, 6]], [[3, 8]]), // the same ids: their counts
				row(121, [], [[999, 7]]), // one kill each side, ids differ (Forever changed it): paired
				row(122, [], [[3, 5], [3, 9]]), // two different counts for kill 3: left null
				row(123, [[50, 2]], [[4, 10]]), // the text gives 4 wolves: kept
				row(124, [], [[-500, 2], [3, 1]]), // the altar is an object (negative id)
				row(125, [], [[999, 1]]), // the trigger is the quest's one kill-group objective
				row(126, [[0, 0]], []), // nothing to count: not kept
			].join(',')};`,
		];

		test('extractQuestCounts reads kill, object and item counts by column name', async () => {
			const t = await extractQuestCounts(DUMP);
			assert.deepEqual(t[120], { kill: [[3, 8]], object: [], item: [[50, 6]] });
			assert.deepEqual(t[124], { kill: [[3, 1]], object: [[500, 2]], item: [] });
			assert.equal(t[126], undefined);
		});

		test('a count QuestieDB lacks comes from classic-db: same id, or the one objective of its kind on each side', async () => {
			const sourcesDir = tmpdir('polestar-questie-');
			fs.cpSync(path.join(FIX, 'sources'), sourcesDir, { recursive: true });
			const gz = zlib.gzipSync(Buffer.from(DUMP.join('\n')));
			const cache = path.join(sourcesDir, 'cmangos', DB_REV.slice(0, 12));
			fs.mkdirSync(cache, { recursive: true });
			fs.writeFileSync(path.join(cache, 'classicdb.sql.gz'), gz);
			const quest = (name, objectives, extra = {}) => ({ name, questLevel: 3, requiredLevel: 1, startedBy: [[2]], finishedBy: [[2]], objectivesText: ['Help the camp.'], objectives, ...extra });
			const { read, result } = await build({ sourcesDir, classicDb: { hash: crypto.createHash('sha256').update(gz).digest('hex') } }, {
				quests: {
					120: quest('Fixture Same Ids', [[{ 1: 3 }], [], [{ 1: 50 }]]),
					121: quest('Fixture Changed Id', [[{ 1: 4 }]]),
					122: quest('Fixture Conflict', [[{ 1: 3 }]]),
					123: quest('Fixture Text Count', [[{ 1: 4 }], [], [{ 1: 50 }]], { objectivesText: ['Kill 4 Fixture Wolf Alphas.'] }),
					124: quest('Fixture Altar', [[{ 1: 3 }], [{ 1: 500 }]]),
					125: quest('Fixture Trigger', [], { triggerEnd: ['Scout the ridge', { 12: [[50, 50]] }] }),
					127: quest('Fixture Not In Classic', [[{ 1: 3 }]]),
				},
			});
			const q = read('quests');
			const counts = (id) => q[id].objectives.map((o) => `${o.type} ${o.id} ${o.count}`);
			assert.deepEqual(counts(120), ['kill 3 8', 'item 50 6']);
			assert.deepEqual(counts(121), ['kill 4 7']);
			assert.deepEqual(counts(122), ['kill 3 null'], 'two different counts leave null');
			assert.deepEqual(counts(123), ['kill 4 4', 'item 50 2'], "the text's count is never overwritten");
			assert.deepEqual(counts(124), ['kill 3 1', 'object 500 2']);
			assert.deepEqual(counts(125), ['event null 1']);
			assert.deepEqual(counts(127), ['kill 3 null']);
			assert.ok(fs.existsSync(path.join(cache, 'quest_counts.json')), 'the extract is cached beside the dump');
			assert.equal(result.meta.counts.objectiveCountsFromClassicDb, 7);
			const credit = result.meta.sources.find((s) => /quest objective counts/.test(s.name));
			assert.equal(credit.revision, DB_REV);
			assert.match(credit.license, /^GPL-3\.0/);
		});

		test('without the dump: counts stay null, one warning', async () => {
			const { read, result } = await build({}, { quests: { 121: { name: 'Fixture Changed Id', questLevel: 3, requiredLevel: 1, startedBy: [[2]], finishedBy: [[2]], objectives: [[{ 1: 4 }]] } } });
			assert.equal(read('quests')[121].objectives[0].count, null);
			assert.equal(result.meta.warnings.filter((w) => /objective counts unavailable/.test(w)).length, 1);
			assert.equal(result.meta.sources.some((s) => /quest objective counts/.test(s.name)), false);
		});
	});
});

describe('QuestieDB frames', () => {
	test('points are Era-tagged on unchanged maps, live on changed and Forever-only maps', async () => {
		const { read, result } = await build();
		const npcs = read('npcs');
		assert.deepEqual(npcs[2].spawns, { 1429: { f: 'e', pts: [[42.1, 65.9]] }, 1453: { f: 'l', pts: [[60, 60]] } });
		assert.equal(npcs[251361].spawns[2521].f, 'l');
		assert.deepEqual(result.meta.liveFrameMaps, [1453], 'without Forever tables, QuestieDB eraToForever names the changed maps');
	});

	test('with Forever client tables, frame changes decide and Forever maps get names and frames', async () => {
		const sourcesDir = tmpdir('polestar-questie-');
		fs.cpSync(path.join(FIX, 'sources', 'wago'), path.join(sourcesDir, 'wago'), { recursive: true });
		const era = path.join(sourcesDir, 'wago', '1.15.9.11111');
		const fv = path.join(sourcesDir, 'wago', '1.60.1.1');
		fs.mkdirSync(fv);
		fs.writeFileSync(path.join(fv, 'UiMap.csv'), `${fs.readFileSync(path.join(era, 'UiMap.csv'), 'utf8').trimEnd()}\n"Zephras Isle",2521,947,4,0,3\n`);
		// Stormwind keeps its frame here, Elwynn moves 10 yards, Zephras Isle is new.
		const asg = fs.readFileSync(path.join(era, 'UiMapAssignment.csv'), 'utf8').replace('-10254.166015625,-1935.4166259766', '-10264.166015625,-1935.4166259766').trimEnd();
		fs.writeFileSync(path.join(fv, 'UiMapAssignment.csv'), `${asg}\n0,0,1,1,1247.917,-1331.25,-1000000,4956.25,4231.25,1000000,50000,2521,0,2991,16593,0,0\n`);
		fs.writeFileSync(path.join(fv, 'AreaTable.csv'), `${fs.readFileSync(path.join(era, 'AreaTable.csv'), 'utf8').trimEnd()}\n16593,ZephrasIsle,"Zephras Isle",2991,0\n`);
		const { read, result } = await build({ sourcesDir, forever: true });
		assert.deepEqual(result.meta.liveFrameMaps, [1429]);
		assert.deepEqual(read('zones')[2521], { id: 2521, name: 'Zephras Isle', areaId: 16593, parent: 947, type: 3 });
		const frames = read('map-frames');
		assert.deepEqual(frames.forever[2521], { c: 2991, left: 4231.25, right: -1331.25, top: 4956.25, bottom: 1247.917 });
		assert.equal(frames.era[2521], undefined);
		const npcs = read('npcs');
		assert.equal(npcs[2].spawns[1429].f, 'l');
		assert.equal(npcs[2].spawns[1453].f, 'e');
		assert.match(result.meta.sources.find((s) => /Forever client tables/.test(s.name)).revision, /wow_classic_beta 1\.60\.1\.1/);
	});

	test('instance npcs and objects (QuestieDB spawns without coordinates) get the instance map ids of their areas', async () => {
		const sourcesDir = tmpdir('polestar-questie-');
		fs.cpSync(path.join(FIX, 'sources', 'wago'), path.join(sourcesDir, 'wago'), { recursive: true });
		const era = path.join(sourcesDir, 'wago', '1.15.9.11111');
		// The Deadmines (1581) and Blackfathom Deeps (719) lie on their instance maps 36 and 48; Zephras Isle on the open-world continent 2991.
		const areas = `${fs.readFileSync(path.join(era, 'AreaTable.csv'), 'utf8').trimEnd()}\n1581,TheDeadmines,"The Deadmines",36,0\n719,BlackfathomDeeps,"Blackfathom Deeps",48,0\n16593,ZephrasIsle,"Zephras Isle",2991,0\n`;
		fs.writeFileSync(path.join(era, 'AreaTable.csv'), areas);
		const store = {
			npcs: { 639: { name: 'Edwin VanCleef', minLevel: 21, maxLevel: 21, spawns: { 1581: [[-1, -1]] }, friendlyToFaction: '', npcFlags: 0 } },
			objects: { 1700: { name: 'Fathom Stone', spawns: { 719: [[-1, -1]] } } },
		};
		// Without the Forever Map table: unmapped areas off the two old continents.
		const plain = await build({ sourcesDir }, store);
		assert.deepEqual(plain.read('npcs')[639].instances, [36]);
		assert.deepEqual(plain.read('objects')[1700].instances, [48]);
		assert.equal(plain.read('npcs')[251362].instances, undefined, 'Zephras Isle is open world');

		// With it: Map InstanceType decides (48 is a battleground here, so not a dungeon).
		const fv = path.join(sourcesDir, 'wago', '1.60.1.1');
		fs.mkdirSync(fv);
		for (const t of ['UiMap', 'UiMapAssignment']) fs.copyFileSync(path.join(era, `${t}.csv`), path.join(fv, `${t}.csv`));
		fs.writeFileSync(path.join(fv, 'AreaTable.csv'), areas);
		fs.writeFileSync(path.join(fv, 'Map.csv'), 'ID,Directory,MapName_lang,InstanceType\n0,Azeroth,"Eastern Kingdoms",0\n36,DeadminesInstance,"Deadmines",1\n48,Blackfathom,"Blackfathom Deeps",3\n');
		const forever = await build({ sourcesDir, forever: true }, store);
		assert.deepEqual(forever.read('npcs')[639].instances, [36]);
		assert.equal(forever.read('objects')[1700].instances, undefined);
		assert.match(forever.result.meta.sources.find((s) => /Forever client tables/.test(s.name)).name, /, Map\)/);
	});

	test("the Forever client's ItemSparse gives the items that vanish after a while their duration in seconds", async () => {
		const sourcesDir = tmpdir('polestar-questie-');
		fs.cpSync(path.join(FIX, 'sources', 'wago'), path.join(sourcesDir, 'wago'), { recursive: true });
		const era = path.join(sourcesDir, 'wago', '1.15.9.11111');
		const fv = path.join(sourcesDir, 'wago', '1.60.1.1');
		fs.mkdirSync(fv);
		for (const t of ['UiMap', 'UiMapAssignment', 'AreaTable']) fs.copyFileSync(path.join(era, `${t}.csv`), path.join(fv, `${t}.csv`));
		// Item 50 lasts 15 minutes, 252665 never expires, 999999 is not an item we hold.
		fs.writeFileSync(path.join(fv, 'ItemSparse.csv'), 'ID,Display_lang,DurationInInventory\n50,"Timed Thing",900\n252665,"Lasting Thing",0\n999999,"Elsewhere",300\n');
		const { read, result } = await build({ sourcesDir, forever: true });
		const items = read('items');
		assert.equal(items[50].duration, 900);
		assert.equal(items[252665].duration, undefined);
		assert.equal(items[999999], undefined);
		assert.equal(result.meta.counts.timedItems, 1);
		assert.match(result.meta.sources.find((s) => /Forever client tables/.test(s.name)).name, /, ItemSparse\)/);
	});
});
