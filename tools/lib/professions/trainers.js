'use strict';
// Profession trainers and rank sources. Blizzard's client tables do not say
// who trains what (trainer lists are server data), so this is a curated table
// of NPC names from general game knowledge of Classic (Era) cities and outposts.
// Every name is checked against npcs.json at build time: it must exist, be
// unique on the given side and have spawns, else it is dropped with a
// warning. Nothing here is copied from a leveling or profession guide.
//
// Per profession:
//   train   { Alliance: [names], Horde: [names] }   Apprentice and Journeyman
//   expert  { Alliance: [names], Horde: [names] }   the city trainers that also
//           teach Expert (a subset of `train`; they teach the lower ranks too)
//   artisan { Alliance: [names], Horde: [names] }   Artisan trainers
//   junior  { Alliance: [names], Horde: [names] }   Forever's Junior trainers
//           in the starting zones: they teach Apprentice only
//   book / quest                                    secondary skills: Expert
//           comes from a book bought from a vendor, Artisan from a quest
//   main    { Alliance: name, Horde: name }         the trainer a guide sends
//           the player to (Stormwind / Orgrimmar unless that city has none)

const RANKS = [
	// Classic rank requirements (game mechanics): character level and skill
	// needed before a trainer teaches the rank.
	{ name: 'Apprentice', max: 75, minLevel: 5, minSkill: 0 },
	{ name: 'Journeyman', max: 150, minLevel: 10, minSkill: 50 },
	{ name: 'Expert', max: 225, minLevel: 20, minSkill: 125 },
	{ name: 'Artisan', max: 300, minLevel: 35, minSkill: 200 },
];
// Forever teaches Apprentice gathering skills from level 1 (Warcraft Tavern's
// Forever professions guide; the Junior trainers in every starting zone).
const GATHERING_APPRENTICE_LEVEL = 1;

const CURATED = {
	171: {
		name: 'Alchemy',
		train: {
			Alliance: ['Alchemist Mallory', "Tel'Athir", 'Lilyssia Nightbreeze', 'Tally Berryfizz', 'Vosur Brakthel', 'Ghak Healtouch', 'Cyndra Kindwhisper', 'Ainethil', 'Milla Fairancora', 'Sylvanna Forestmoon', 'Kylanna'],
			Horde: ["Miao'zan", 'Yelmak', 'Whuut', 'Bena Winterhoof', 'Kray', 'Carolai Anise', 'Doctor Herbert Halsey', 'Doctor Marsh', 'Doctor Martin Felben', 'Serge Hinott'],
		},
		expert: {
			Alliance: ['Lilyssia Nightbreeze', 'Vosur Brakthel', 'Ainethil'],
			Horde: ['Yelmak', 'Bena Winterhoof', 'Doctor Herbert Halsey'],
		},
		artisan: { Alliance: ['Kylanna Windwhisper'], Horde: ['Rogvar'] },
		main: { Alliance: 'Lilyssia Nightbreeze', Horde: 'Yelmak' },
	},
	164: {
		name: 'Blacksmithing',
		train: {
			Alliance: ['Smith Argus', 'Therum Deepforge', 'Ironus Coldsteel', 'Bengus Deepforge', 'Groum Stonebeard', 'Tognus Flintfire'],
			Horde: ['Dwukk', 'Saru Steelfury', 'Thrag Stonehoof', 'Karn Stonehoof', 'James Van Brunt', 'Basil Frye'],
		},
		expert: {
			Alliance: ['Therum Deepforge', 'Bengus Deepforge'],
			Horde: ['Saru Steelfury', 'Karn Stonehoof', 'James Van Brunt'],
		},
		artisan: { Alliance: ['Brikk Keencraft'], Horde: ['Brikk Keencraft'] },
		main: { Alliance: 'Therum Deepforge', Horde: 'Saru Steelfury' },
	},
	333: {
		name: 'Enchanting',
		train: {
			Alliance: ['Lucan Cordell', 'Betty Quin', 'Kitta Firewind', 'Gimble Thistlefuzz', 'Tilli Thistlefuzz', 'Thonys Pillarstone', 'Taladan', 'Lalina Summermoon', 'Alanna Raveneye'],
			Horde: ['Godan', 'Jhag', 'Mot Dawnstrider', 'Teg Dawnstrider', 'Lavinia Crowe', 'Malcomb Wynn', 'Vance Undergloom', 'Hgarth'],
		},
		expert: {
			Alliance: ['Lucan Cordell', 'Gimble Thistlefuzz', 'Taladan'],
			Horde: ['Godan', 'Teg Dawnstrider', 'Lavinia Crowe'],
		},
		// Annora teaches inside the Uldaman dungeon (Badlands); the reference
		// data has no spawn for her, so she is kept by name only.
		artisan: { Alliance: ['Annora'], Horde: ['Annora'] },
		main: { Alliance: 'Lucan Cordell', Horde: 'Godan' },
	},
	202: {
		name: 'Engineering',
		train: {
			Alliance: ['Lilliam Sparkspindle', 'Sprite Jumpsprocket', 'Springspindle Fizzlegear', 'Jemma Quikswitch', 'Trixie Quikswitch', 'Bronk Guzzlegear', 'Jenna Lemkenilli'],
			Horde: ['Nogg', 'Roxxik', 'Mukdrak', 'Graham Van Talen', 'Franklin Lloyd'],
		},
		expert: {
			Alliance: ['Lilliam Sparkspindle', 'Springspindle Fizzlegear'],
			Horde: ['Nogg', 'Graham Van Talen'],
		},
		artisan: { Alliance: ['Buzzek Bracketswing'], Horde: ['Buzzek Bracketswing'] },
		main: { Alliance: 'Lilliam Sparkspindle', Horde: 'Nogg' },
	},
	165: {
		name: 'Leatherworking',
		train: {
			Alliance: ['Adele Fielder', 'Simon Tanner', 'Randal Worth', 'Fimble Finespindle', 'Telonis', 'Darianna', 'Faldron', 'Trianna'],
			Horde: ['Karolek', 'Chaw Stronghide', 'Una', 'Tarn', 'Arthur Moore', 'Brawn', 'Krulmoo Fullmoon'],
		},
		expert: {
			Alliance: ['Simon Tanner', 'Fimble Finespindle', 'Telonis'],
			Horde: ['Karolek', 'Una', 'Arthur Moore'],
		},
		artisan: { Alliance: ['Drakk Stonehand'], Horde: ['Hahrana Ironhide'] },
		main: { Alliance: 'Simon Tanner', Horde: 'Karolek' },
	},
	197: {
		name: 'Tailoring',
		train: {
			Alliance: ['Eldrin', 'Sellandus', 'Georgio Bolero', 'Lawrence Schneider', 'Jormund Stonebrow', 'Uthrar Threx', "Me'lynn", 'Sinda', 'Nadyia Maneweaver'],
			Horde: ['Magar', 'Snang', 'Josephine Lister', 'Victor Ward', 'Rhiannon Davis', 'Bowen Brisboise', 'Vhan', 'Mahani'],
		},
		expert: {
			Alliance: ['Georgio Bolero', 'Jormund Stonebrow', "Me'lynn"],
			Horde: ['Magar', 'Josephine Lister'],
		},
		artisan: { Alliance: ['Timothy Worthington'], Horde: ['Daryl Stack'] },
		main: { Alliance: 'Georgio Bolero', Horde: 'Magar' },
	},
	// Gathering skills: every `train` trainer teaches all four ranks.
	182: {
		name: 'Herbalism',
		train: {
			Alliance: ['Tannysa', 'Shylamiir', 'Reyna Stonebranch', 'Firodren Mooncaller', 'Malorne Bladeleaf', 'Alma Jainrose', 'Kali Healtouch'],
			Horde: ['Jandi', 'Komin Winterhoof', 'Martha Alliestar', 'Faruza', 'Aranae Venomblood'],
		},
		junior: {
			Alliance: ['Nancy Songflower', 'Emrys Flintbeard', 'Eleyna Duskbreeze'],
			Horde: ["Zor'la", 'Garan Sunstrider', 'Florence Nightshade'],
		},
		main: { Alliance: 'Tannysa', Horde: 'Jandi' },
	},
	186: {
		name: 'Mining',
		train: {
			Alliance: ['Gelman Stonehand', 'Geofram Bouldertoe', 'Yarr Hammerstone', 'Brock Stoneseeker', 'Kurdram Stonehammer'],
			Horde: ['Makaru', 'Krunn', 'Brek Stonehoof', 'Brom Killian', 'Johan Focht'],
		},
		junior: {
			Alliance: ['Kelsey Fargo', 'Sally Swiftwrench', 'Fanorran Stilloak'],
			Horde: ['Norzsh', 'Vartha Rockmane', 'Walter Mason'],
		},
		main: { Alliance: 'Gelman Stonehand', Horde: 'Makaru' },
	},
	393: {
		name: 'Skinning',
		train: {
			Alliance: ['Maris Granger', 'Helene Peltskinner', 'Balthus Stoneflayer', 'Radnaal Maneweaver'],
			Horde: ['Thuwd', 'Mooranta', 'Rand Rhobart', 'Killian Sanatha'],
		},
		junior: {
			Alliance: ['Riley Peltskinner', 'Brighid Stormflayer', 'Terunne Bearshaper'],
			Horde: ['Kagil', 'Nawka Wildsong', 'Margaret Weaver'],
		},
		main: { Alliance: 'Maris Granger', Horde: 'Thuwd' },
	},
	// Secondary skills: trainers teach Apprentice and Journeyman.
	185: {
		name: 'Cooking',
		train: {
			Alliance: ['Stephen Ryback', 'Tomas', 'Daryl Riknussun', 'Gremlock Pilsnor', 'Alegorn', 'Zarrin'],
			Horde: ['Zamja', 'Aska Mistrunner', 'Eunice Burch', 'Duhng'],
		},
		book: { item: 16072, vendors: { Alliance: ['Shandrina'], Horde: ['Wulan'] } },
		quest: { Alliance: ['Dirge Quikcleave'], Horde: ['Dirge Quikcleave'] },
		main: { Alliance: 'Stephen Ryback', Horde: 'Zamja' },
	},
	129: {
		name: 'First Aid',
		train: {
			Alliance: ['Shaina Fuller', 'Michelle Belle', 'Nissa Firestone', 'Thamner Pol', 'Byancie'],
			Horde: ['Arnok', 'Rawrk', 'Pand Stonebinder', 'Mary Edras', 'Nurse Neela'],
		},
		book: { item: 16084, vendors: { Alliance: ['Deneb Walker'], Horde: ["Balai Lok'Wein"] } },
		quest: { Alliance: ['Doctor Gustaf VanHowzen'], Horde: ['Doctor Gregory Victor'] },
		main: { Alliance: 'Shaina Fuller', Horde: 'Arnok' },
	},
	356: {
		name: 'Fishing',
		train: {
			Alliance: ['Arnold Leland', 'Lee Brown', 'Grimnur Stonebrand', 'Paxton Ganter', 'Astaia'],
			Horde: ['Lumak', 'Kah Mistrunner', 'Armand Cromwell', 'Clyde Kellen'],
		},
		book: { item: 16083, vendors: { Alliance: ['Old Man Heming'], Horde: ['Old Man Heming'] } },
		quest: { Alliance: ['Nat Pagle'], Horde: ['Nat Pagle'] },
		main: { Alliance: 'Arnold Leland', Horde: 'Lumak' },
	},
};

const SIDE_CODE = { Alliance: 'A', Horde: 'H' };

// npcs.json name -> npc for one side: the side's own NPC or a neutral one.
function makeFinder(npcs) {
	const byName = new Map();
	for (const n of Object.values(npcs || {})) {
		if (!n || !n.name) continue;
		const key = String(n.name).toLowerCase();
		if (!byName.has(key)) byName.set(key, []);
		byName.get(key).push(n);
	}
	return (name, side) => {
		const list = (byName.get(String(name).toLowerCase()) || []).filter((n) => {
			const f = n.faction == null ? '' : String(n.faction);
			return f === '' || f === 'AH' || f.includes(SIDE_CODE[side]);
		});
		if (list.length === 0) return { error: 'not in npcs.json for this side' };
		if (list.length > 1) return { error: `ambiguous (${list.map((n) => n.id).join(', ')})` };
		return { npc: list[0] };
	};
}

function hasSpawns(npc) {
	return Object.values(npc.spawns || {}).some((s) => s && Array.isArray(s.pts) && s.pts.length > 0);
}

// Resolve the curated names for one skill line -> { ranks, trainers, main,
// book, quest } with NPC ids, plus warnings for names that failed.
function resolveTrainers(skillLine, npcs, { kind } = {}) {
	const c = CURATED[skillLine];
	const warnings = [];
	if (!c) return { ranks: RANKS.map((r) => ({ ...r })), trainers: { Alliance: [], Horde: [] }, warnings };
	const find = makeFinder(npcs);
	const ids = (names, side, { allowNoSpawn = false } = {}) => {
		const out = [];
		for (const name of names || []) {
			const r = find(name, side);
			if (r.error) {
				warnings.push(`${c.name} ${side} trainer "${name}": ${r.error}`);
				continue;
			}
			if (!hasSpawns(r.npc) && !allowNoSpawn) {
				warnings.push(`${c.name} ${side} trainer "${name}" (${r.npc.id}) has no spawns`);
				continue;
			}
			if (!out.includes(r.npc.id)) out.push(r.npc.id);
		}
		return out;
	};
	const sides = ['Alliance', 'Horde'];
	const per = (group, opts) => Object.fromEntries(sides.map((s) => [s, ids(group && group[s], s, opts)]));
	const train = per(c.train);
	const expert = c.expert ? per(c.expert) : null;
	const artisan = c.artisan ? per(c.artisan, { allowNoSpawn: true }) : null;
	const junior = c.junior ? per(c.junior) : null;
	const merge = (...lists) => [...new Set(lists.flat())].sort((a, b) => a - b);
	const trainers = Object.fromEntries(sides.map((s) => [s, merge(train[s], expert ? expert[s] : [], artisan ? artisan[s] : [])]));
	const ranks = RANKS.map((r) => {
		const rank = { ...r };
		if (r.name === 'Apprentice' && kind === 'gathering') rank.minLevel = GATHERING_APPRENTICE_LEVEL;
		if (r.name === 'Apprentice' && junior) {
			rank.trainers = Object.fromEntries(sides.map((s) => [s, merge(train[s], expert ? expert[s] : [], junior[s])]));
		} else if (r.name === 'Apprentice' || r.name === 'Journeyman' || kind === 'gathering') {
			rank.trainers = Object.fromEntries(sides.map((s) => [s, merge(train[s], expert ? expert[s] : [])]));
		} else if (r.name === 'Expert') {
			if (expert) rank.trainers = Object.fromEntries(sides.map((s) => [s, merge(expert[s])]));
			if (c.book) rank.book = { item: c.book.item, vendors: Object.fromEntries(sides.map((s) => [s, ids(c.book.vendors[s], s)])) };
		} else if (r.name === 'Artisan') {
			if (artisan) rank.trainers = Object.fromEntries(sides.map((s) => [s, merge(artisan[s])]));
			if (c.quest) rank.quest = { npcs: Object.fromEntries(sides.map((s) => [s, ids(c.quest[s], s)])) };
			// Secondary skills: the Artisan quests ask for 225, the Expert cap.
			if (kind === 'secondary') rank.minSkill = 225;
		}
		return rank;
	});
	const main = {};
	for (const s of sides) {
		const r = c.main && c.main[s] ? find(c.main[s], s) : null;
		if (r && r.npc) main[s] = r.npc.id;
	}
	return { ranks, trainers, main, warnings };
}

module.exports = { resolveTrainers, CURATED, RANKS, GATHERING_APPRENTICE_LEVEL };
