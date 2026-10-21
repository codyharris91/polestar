'use strict';
// QuestieDB's "baked" Forever store (QuestieDB_Forever.toc) and its support
// data, read in Node. QuestieDB (https://github.com/Questie/QuestieDB) is
// GPL-3.0; nothing from it is copied into this repository: this reads the
// copy installed with the game and the output stays local (data/ is ignored).
//
// Ported from QuestieDB 1.0.5:
// - src/meta/codec.lua, src/read/baked.lua: every value is a TOC metadata
//   line `## X-<Entity>-<key>: <base64>`. A value of exactly `~N~` is a chunk
//   header: the value is parts `<key>-1` .. `<key>-N` concatenated (a missing
//   part is corruption, not absence). `X-<Entity>-IDS` is base64 of a
//   zlib-compressed (C_EncodingUtil.DecompressString method 1) CBOR list of
//   ids. `X-<Entity>-<id>-S` is base64 CBOR of the scalar row: { [fieldIndex]
//   = value, p = presence mask }, where bit (fieldIndex - 1) of `p` says that
//   table field fieldIndex is stored, as base64 CBOR, under
//   `X-<Entity>-<id>-<fieldIndex>`. Constant fields are dropped from rows.
// - src/read/shared.lua + src/meta/normalize.lua (normalize.default): stored
//   values are already normalized by QuestieDB's generator and are returned
//   as stored; an absent value reads back as the field's default: the
//   constant for constant fields, 0 for numbers, an empty table for the
//   `questgivers` / `objectives` structures, nil otherwise.
// - src/meta/<entity>Meta.lua: field names, storage types and structures are
//   read from the installed copy (run under Lua 5.1), so a field added by a
//   QuestieDB update decodes without changing this file.
// CBOR byte strings are Lua strings (UTF-8 text). Lua tables come back the
// way tools/lib/lua.js returns them: keys exactly 1..n -> array, anything
// else -> object with string keys. Use luaGet / luaPairs to index either.
//
// Runtime corrections are not applied: QuestieDB folds every Static
// Correction into the store; its Dynamic Corrections pick values per
// character (faction, class) at query time and have no single answer here.
// The correction files' objective-order hints are read (readObjectiveFirst).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { luaToJson } = require('../lua');

const REPO = 'https://github.com/Questie/QuestieDB';
const QUESTIE_REPO = 'https://github.com/Questie/Questie';
const TOC = 'QuestieDB_Forever.toc';
const ENTITIES = ['Quest', 'Npc', 'Object', 'Item'];
const META_FILES = { Quest: 'questMeta.lua', Npc: 'npcMeta.lua', Object: 'objectMeta.lua', Item: 'itemMeta.lua' };
// normalize.neverNilStructures: readers that always build a table.
const NEVER_NIL = new Set(['questgivers', 'objectives']);

// Support files QuestieDB's config.lua lists for Forever (supportData.perFlavor.Forever).
const SUPPORT = {
	xp: 'support/Forever/QuestXP/xpDB-classic.lua',
	drops: 'support/Forever/DropTables/classicItemDrops.lua',
	dropCorrections: 'support/Forever/DropTables/itemDropCorrections.lua',
	factionTemplates: 'support/Forever/FactionTemplates/factionTemplateClassic.lua',
	areaToUiMap: 'support/Forever/Zones/areaIdToUiMapId.lua',
	uiMapToArea: 'support/Forever/Zones/uiMapIdToAreaId.lua',
	subZones: 'support/Forever/Zones/subZoneToParentZone.lua',
	eraToForever: 'src/support/eraToForever.lua',
};

// --- Lua-table access --------------------------------------------------------

function isNil(v) {
	return v === undefined || v === null;
}

// t[k] with Lua semantics over both array and object forms.
function luaGet(t, k) {
	if (isNil(t) || typeof t !== 'object') return undefined;
	if (Array.isArray(t)) {
		const n = Number(k);
		const v = Number.isInteger(n) && n >= 1 ? t[n - 1] : undefined;
		return isNil(v) ? undefined : v;
	}
	const v = t[String(k)];
	return isNil(v) ? undefined : v;
}

// pairs(t) -> [[key, value]]; integer keys come back as numbers, ascending first.
function luaPairs(t) {
	if (isNil(t) || typeof t !== 'object') return [];
	if (Array.isArray(t)) return t.map((v, i) => [i + 1, v]).filter(([, v]) => !isNil(v));
	const ints = [];
	const strs = [];
	for (const [k, v] of Object.entries(t)) {
		if (isNil(v)) continue;
		if (/^-?\d+$/.test(k)) ints.push([Number(k), v]);
		else strs.push([k, v]);
	}
	ints.sort((a, b) => a[0] - b[0]);
	return [...ints, ...strs];
}

// ipairs(t) -> values 1..n until the first nil.
function luaList(t) {
	const out = [];
	for (let i = 1; ; i++) {
		const v = luaGet(t, i);
		if (v === undefined) return out;
		out.push(v);
	}
}

// --- CBOR (RFC 8949), as C_EncodingUtil.DeserializeCBOR returns it ----------

function luaTable(entries) {
	let dense = true;
	for (let i = 0; i < entries.length; i++) {
		if (entries[i][0] !== i + 1) {
			dense = false;
			break;
		}
	}
	if (dense) return entries.map((e) => e[1]);
	const obj = {};
	for (const [k, v] of entries) obj[String(k)] = v;
	return obj;
}

function decodeCbor(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let o = 0;
	const need = (n) => {
		if (o + n > buf.length) throw new Error(`CBOR: truncated at byte ${o}`);
	};
	const arg = (ai) => {
		if (ai < 24) return ai;
		if (ai === 24) {
			need(1);
			return buf[o++];
		}
		if (ai === 25) {
			need(2);
			o += 2;
			return dv.getUint16(o - 2);
		}
		if (ai === 26) {
			need(4);
			o += 4;
			return dv.getUint32(o - 4);
		}
		if (ai === 27) {
			need(8);
			o += 8;
			const v = dv.getBigUint64(o - 8);
			if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: integer beyond 2^53');
			return Number(v);
		}
		if (ai === 31) return -1;
		throw new Error(`CBOR: reserved additional info ${ai}`);
	};
	const BREAK = Symbol('break');
	const item = () => {
		need(1);
		const b = buf[o++];
		const mt = b >> 5;
		const ai = b & 31;
		switch (mt) {
			case 0:
				return arg(ai);
			case 1:
				return -1 - arg(ai);
			case 2:
			case 3: {
				const n = arg(ai);
				if (n < 0) {
					const parts = [];
					for (let p = item(); p !== BREAK; p = item()) parts.push(p);
					return parts.join('');
				}
				need(n);
				o += n;
				return buf.toString('utf8', o - n, o);
			}
			case 4: {
				const n = arg(ai);
				const entries = [];
				if (n < 0) for (let v = item(), i = 1; v !== BREAK; v = item(), i++) entries.push([i, v]);
				else for (let i = 1; i <= n; i++) entries.push([i, item()]);
				return luaTable(entries.filter((e) => !isNil(e[1])));
			}
			case 5: {
				const n = arg(ai);
				const entries = [];
				const add = (k) => {
					if (k === BREAK) return false;
					const v = item();
					if (!isNil(k) && !isNil(v)) entries.push([k, v]);
					return true;
				};
				if (n < 0) while (add(item()));
				else for (let i = 0; i < n; i++) add(item());
				entries.sort((a, b) => (typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : typeof a[0] === 'number' ? -1 : typeof b[0] === 'number' ? 1 : 0));
				return luaTable(entries);
			}
			case 6:
				arg(ai);
				return item();
			default: {
				if (ai === 20) return false;
				if (ai === 21) return true;
				if (ai === 22 || ai === 23) return null;
				if (ai === 25) {
					need(2);
					const h = dv.getUint16(o);
					o += 2;
					const e = (h >> 10) & 31;
					const f = h & 1023;
					const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15);
					return h & 0x8000 ? -v : v;
				}
				if (ai === 26) {
					need(4);
					o += 4;
					return dv.getFloat32(o - 4);
				}
				if (ai === 27) {
					need(8);
					o += 8;
					return dv.getFloat64(o - 8);
				}
				if (ai === 31) return BREAK;
				throw new Error(`CBOR: unsupported simple value ${ai}`);
			}
		}
	};
	const v = item();
	if (v === BREAK) throw new Error('CBOR: unexpected break');
	if (o !== buf.length) throw new Error(`CBOR: ${buf.length - o} trailing bytes`);
	return v;
}

// --- TOC metadata store -------------------------------------------------------

// `## Key: value` lines (C_AddOns.GetAddOnMetadata) -> Map.
function parseToc(text) {
	const out = new Map();
	for (const line of text.split(/\r?\n/)) {
		const m = /^##\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
		if (m && !out.has(m[1])) out.set(m[1], m[2]);
	}
	return out;
}

// baked.lua getStored: one value, reassembling a chunked value.
function storedValue(meta, key) {
	const value = meta.get(key);
	if (value === undefined) return null;
	if (value.charCodeAt(0) !== 126) return value;
	const m = /^~(\d+)~$/.exec(value);
	if (!m) return value;
	const parts = [];
	for (let i = 1; i <= Number(m[1]); i++) {
		const part = meta.get(`${key}-${i}`);
		if (part === undefined) throw new Error(`QuestieDB: metadata key ${key} declares ${m[1]} parts but part ${i} is missing`);
		parts.push(part);
	}
	return parts.join('');
}

function cborOf(b64) {
	return decodeCbor(Buffer.from(b64, 'base64'));
}

// Meta tables from the installed src/meta/*.lua -> plain schema objects.
function loadMetas(dir) {
	const files = ENTITIES.map((e) => path.join(dir, 'src', 'meta', META_FILES[e]));
	for (const f of files) if (!fs.existsSync(f)) throw new Error(`QuestieDB: missing ${path.relative(dir, f)}`);
	const expr = `
local out = {}
for i, p in ipairs({ ${files.map((f) => JSON.stringify(f)).join(', ')} }) do
  local ok, m = __polestar_loaddata(p)
  if not ok then error(m, 0) end
  out[i] = m
end
return out`;
	const raw = luaToJson({ expr });
	const metas = {};
	ENTITIES.forEach((entity, i) => {
		const m = raw[i];
		if (!m || luaGet(m, 'entity') !== entity) throw new Error(`QuestieDB: ${META_FILES[entity]} does not describe ${entity}`);
		const n = Number(luaGet(m, 'fieldCount'));
		const field = (name, fi) => luaGet(luaGet(m, name), fi);
		const fields = [];
		for (let fi = 1; fi <= n; fi++) {
			fields.push({
				index: fi,
				name: field('names', fi),
				type: field('types', fi),
				structure: field('structures', fi) || null,
				constant: field('constantValues', fi),
			});
		}
		metas[entity] = { entity, prefix: `X-${luaGet(m, 'metaPrefix')}`, fieldCount: n, fields };
	});
	return metas;
}

// normalize.default
function fieldDefault(field) {
	if (field.constant !== undefined) return field.constant;
	if (field.type === 'number') return 0;
	if (field.structure && NEVER_NIL.has(field.structure)) return [];
	return undefined;
}

// baked.CreateBackend + shared.get for every field of one entity type.
function readEntities(meta, schema) {
	const stored = (key) => storedValue(meta, key);
	const encodedIds = stored(`${schema.prefix}IDS`);
	if (!encodedIds) throw new Error(`QuestieDB: missing metadata key ${schema.prefix}IDS`);
	const ids = luaList(decodeCbor(zlib.inflateSync(Buffer.from(encodedIds, 'base64'))));
	const out = new Map();
	for (const id of ids) {
		const s = stored(`${schema.prefix}${id}-S`);
		const row = s === null ? {} : cborOf(s);
		const p = Number(luaGet(row, 'p')) || 0;
		const rec = { id };
		for (const f of schema.fields) {
			let v;
			if (f.constant === undefined) {
				if (f.type === 'table') {
					if (Math.floor(p / 2 ** (f.index - 1)) % 2 === 1) {
						const t = stored(`${schema.prefix}${id}-${f.index}`);
						if (t !== null) v = cborOf(t);
					}
				} else {
					v = luaGet(row, f.index);
				}
			}
			rec[f.name] = v === undefined ? fieldDefault(f) : v;
		}
		out.set(id, rec);
	}
	return out;
}

// --- Support data (plain Lua) -------------------------------------------------

// The support files assign into QuestieLoader modules (src/support/data.lua
// installs the same shim). Table-valued strings (`[[return {...}]]`) are
// evaluated in an empty environment. DropDB.correctionKeys mirrors Questie's
// Database/DropTables/dropDB.lua and QuestieDB's constants.dropCorrectionKeys.
const SUPPORT_PRELUDE = `
__modules = {}
local function __module(name)
  local m = __modules[name]
  if not m then m = { private = {} } __modules[name] = m end
  return m
end
QuestieLoader = {
  ImportModule = function(_, name) return __module(name) end,
  CreateModule = function(_, name) return __module(name) end,
}
__module("DropDB").correctionKeys = { WOWHEAD = -1, PSERVER = -2 }
`;
const SUPPORT_EXPR = `
local function decode(s)
  if type(s) ~= "string" then return s end
  local f = assert(loadstring(s))
  setfenv(f, {})
  return f()
end
local function list(t)
  local out = {}
  if type(t) ~= "table" then return out end
  local keys = {}
  for k in pairs(t) do if type(k) == "number" then keys[#keys + 1] = k end end
  table.sort(keys)
  for i, k in ipairs(keys) do out[i] = { k, t[k] } end
  return out
end
local function nested(t)
  local out = list(t)
  for _, p in ipairs(out) do p[2] = list(p[2]) end
  return out
end
local m = __modules
local zone = (m.ZoneDB or {}).private or {}
local drops = m.QuestieClassicItemDrops or {}
local corr = m.QuestieItemDropCorrections or {}
return {
  xp = list((m.QuestXP or {}).db),
  wowhead = nested(decode(drops.wowheadData)),
  pserver = nested(decode(drops.cmangosData)),
  corrections = nested(corr.Era),
  factionTemplates = list((m.QuestieDB or {}).factionTemplate),
  areaToUiMap = list(decode(zone.areaIdToUiMapId)),
  areaToUiMapOverride = list(decode(zone.areaIdToUiMapIdOverride)),
  uiMapToArea = list(decode(zone.uiMapIdToAreaId)),
  uiMapToAreaOverride = list(decode(zone.uiMapIdToAreaIdOverride)),
  subZones = list(decode(zone.subZoneToParentZone)),
  subZonesOverride = list(decode(zone.subZoneToParentZoneOverride)),
}`;

function pairsMap(list, value = (v) => v) {
	return new Map((Array.isArray(list) ? list : []).map(([k, v]) => [Number(k), value(v)]));
}

function merged(base, override) {
	const m = pairsMap(base);
	for (const [k, v] of pairsMap(override)) m.set(k, v);
	return m;
}

// eraToForever.lua is generated with a fixed shape; read its two tables.
function readEraToForever(file) {
	if (!fs.existsSync(file)) return { transforms: new Map(), uiMapToArea: new Map(), dbc: null };
	const text = fs.readFileSync(file, 'utf8');
	const block = (name) => {
		const m = new RegExp(`local ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(text);
		return m ? m[1] : '';
	};
	const transforms = new Map();
	for (const m of block('transforms').matchAll(/\[(\d+)\]\s*=\s*\{([^}]*)\}/g)) {
		const v = m[2].split(',').map((s) => Number(s.trim()));
		if (v.length === 4 && v.every(Number.isFinite)) transforms.set(Number(m[1]), { scaleX: v[0], offsetX: v[1], scaleY: v[2], offsetY: v[3] });
	}
	const uiMapToArea = new Map();
	for (const m of block('uiMapToArea').matchAll(/\[(\d+)\]\s*=\s*(\d+)/g)) uiMapToArea.set(Number(m[1]), Number(m[2]));
	const dbc = /DBC bounds: (\d+(?:\.\d+)+) -> (\d+(?:\.\d+)+)/.exec(text);
	return { transforms, uiMapToArea, dbc: dbc ? { from: dbc[1], to: dbc[2] } : null };
}

function loadSupport(dir) {
	const files = [SUPPORT.xp, SUPPORT.drops, SUPPORT.dropCorrections, SUPPORT.factionTemplates, SUPPORT.areaToUiMap, SUPPORT.uiMapToArea, SUPPORT.subZones]
		.map((f) => path.join(dir, f))
		.filter((f) => fs.existsSync(f));
	const raw = luaToJson({ files, prelude: SUPPORT_PRELUDE, expr: SUPPORT_EXPR });
	const xp = pairsMap(raw.xp, (v) => ({ level: Number(luaGet(v, 1)) || null, xp: Number(luaGet(v, 2)) || null }));
	const rates = (t) => pairsMap(t, (inner) => pairsMap(inner, Number));
	return {
		xp,
		drops: { wowhead: rates(raw.wowhead), pserver: rates(raw.pserver), corrections: rates(raw.corrections) },
		factionTemplates: pairsMap(raw.factionTemplates, Number),
		areaToUiMap: merged(raw.areaToUiMap, raw.areaToUiMapOverride),
		uiMapToArea: merged(raw.uiMapToArea, raw.uiMapToAreaOverride),
		subZoneToParent: merged(raw.subZones, raw.subZonesOverride),
		eraToForever: readEraToForever(path.join(dir, SUPPORT.eraToForever)),
	};
}

// DropDB.GetItemDroprate: manual correction (or the source it references),
// then private-server data, then Wowhead. -> { chance, source } | null
function dropRate(drops, itemId, npcId) {
	const c = drops.corrections.get(itemId);
	const fromTable = (t) => {
		const r = t.get(itemId);
		return r && r.has(npcId) ? r.get(npcId) : undefined;
	};
	if (c && c.has(npcId)) {
		const v = c.get(npcId);
		if (v >= 0) return { chance: v, source: 'questie' };
		if (v === -1 && fromTable(drops.wowhead) !== undefined) return { chance: fromTable(drops.wowhead), source: 'wowhead' };
		if (v === -2 && fromTable(drops.pserver) !== undefined) return { chance: fromTable(drops.pserver), source: 'cmangos' };
	}
	if (fromTable(drops.pserver) !== undefined) return { chance: fromTable(drops.pserver), source: 'cmangos' };
	if (fromTable(drops.wowhead) !== undefined) return { chance: fromTable(drops.wowhead), source: 'wowhead' };
	return null;
}

// --- Locating and reading an install -------------------------------------------

// The QuestieDB folder for `dir`: the folder itself, or <dir>/QuestieDB
// (an Interface/AddOns folder). -> path | null
function questieDbDir(dir) {
	for (const d of [dir, path.join(dir, 'QuestieDB')]) if (fs.existsSync(path.join(d, TOC))) return d;
	return null;
}

// QuestieDB in the first AddOns folder holding it (tools/lib/addons.js
// searchAddonsDirs: $WOW_FOREVER_ADDONS, then the detected clients).
function detectQuestie(opts = {}) {
	const { searchAddonsDirs } = require('../addons');
	for (const dir of searchAddonsDirs(opts)) {
		const d = questieDbDir(dir);
		if (d) return d;
	}
	return null;
}

function tocInfo(file) {
	if (!fs.existsSync(file)) return null;
	const m = parseToc(fs.readFileSync(file, 'utf8'));
	return {
		title: m.get('Title') || null,
		version: m.get('Version') || null,
		author: m.get('Author') || null,
		buildCommit: m.get('X-BUILD-COMMIT') || null,
		buildTime: m.get('X-BUILD-TIME') || null,
	};
}

// QuestieDB's hints for the few quests whose objectives the game lists in
// another order than by kind (`QuestieCorrections.itemObjectiveFirst[503] =
// true`): side effects in the correction files, not data in the store. Only
// the Forever scope counts (src/corrections/Forever, with its own copy of the
// Era baseline in legacy/): QuestieDB_Forever.toc loads no other.
// Commented-out lines do not count.
// -> { killCredit, object, item, event: Set of quest ids }
const HINT_SCOPES = ['Forever'];
function readObjectiveFirst(qdir) {
	const out = { killCredit: new Set(), object: new Set(), item: new Set(), event: new Set() };
	const hint = /\b(killCredit|object|item|event)ObjectiveFirst\[(\d+)\]\s*=\s*true\b/g;
	for (const scope of HINT_SCOPES) {
		const root = path.join(qdir, 'src', 'corrections', scope);
		if (!fs.existsSync(root)) continue;
		const files = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.lua')).sort();
		for (const f of files) {
			for (const line of fs.readFileSync(path.join(root, f), 'utf8').split('\n')) {
				for (const m of line.replace(/--.*$/, '').matchAll(hint)) out[m[1]].add(Number(m[2]));
			}
		}
	}
	return out;
}

// -> { dir, info, metas, quests, npcs, objects, items (Maps id -> record keyed
//      by Questie field name), xp, drops, areaToUiMap, uiMapToArea,
//      subZoneToParent, eraToForever, objectiveFirst }
function readQuestie(dir, { log = () => {} } = {}) {
	const qdir = questieDbDir(dir);
	if (!qdir) throw new Error(`QuestieDB: no ${TOC} under ${dir}`);
	const tocFile = path.join(qdir, TOC);
	log(`reading QuestieDB store ${tocFile}`);
	const meta = parseToc(fs.readFileSync(tocFile, 'utf8'));
	if (meta.get('X-Mode') !== 'baked') throw new Error(`QuestieDB: ${TOC} is not a baked store (X-Mode ${meta.get('X-Mode')})`);
	if (meta.get('X-Flavor') !== 'Forever') throw new Error(`QuestieDB: ${TOC} is flavor ${meta.get('X-Flavor')}, not Forever`);
	const metas = loadMetas(qdir);
	const tables = {};
	for (const [entity, key] of [['Quest', 'quests'], ['Npc', 'npcs'], ['Object', 'objects'], ['Item', 'items']]) tables[key] = readEntities(meta, metas[entity]);
	const questie = tocInfo(path.join(path.dirname(qdir), 'Questie', 'Questie_Camelot.toc')) || tocInfo(path.join(path.dirname(qdir), 'Questie', 'Questie.toc'));
	const info = {
		...tocInfo(tocFile),
		flavor: meta.get('X-Flavor'),
		contract: meta.get('X-Contract-Version') || null,
		interface: meta.get('Interface') || null,
		questie,
	};
	return { dir: qdir, info, metas, ...tables, ...loadSupport(qdir), objectiveFirst: readObjectiveFirst(qdir) };
}

module.exports = {
	REPO,
	QUESTIE_REPO,
	TOC,
	decodeCbor,
	parseToc,
	storedValue,
	readEntities,
	readQuestie,
	loadSupport,
	dropRate,
	questieDbDir,
	detectQuestie,
	luaGet,
	luaPairs,
	luaList,
};
