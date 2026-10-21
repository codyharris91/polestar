'use strict';
// A guide name click targets only that goal's NPC; it never borrows the
// standalone target button's list or marks an unrelated existing target.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');

const FILES = { name: 'Polestar', files: ['Core/Init.lua', 'Core/Compat.lua', 'Theme/Theme.xml', 'QoL/QoL.xml'] };

// Actual Forever handler bodies, pinned to Gethe/wow-ui-source forever
// 172a387e3ab85b26e6640d3058d5ec1e6ccd4c63, not a Retail assumption:
// Interface/AddOns/Blizzard_ChatFrameBase/Shared/SlashCommands.lua
// https://github.com/Gethe/wow-ui-source/blob/172a387e3ab85b26e6640d3058d5ec1e6ccd4c63/Interface/AddOns/Blizzard_ChatFrameBase/Shared/SlashCommands.lua#L489-L497
// Also L541-L545 and L1451-L1478. Only the registration wrapper is replaced
// by the local table. Native option parsing, unit selection and permissions
// are still test doubles below; these tests cannot prove client C behavior.
const FOREVER_HANDLERS = String.raw`
local handlers = {}
handlers.TARGET_EXACT = function(msg)
	local action, target = SecureCmdOptionParse(msg);
	if ( action ) then
		if ( not target or target == "target" ) then
			target = action;
		end
		TargetUnit(target, true);
	end
end
handlers.CLEARTARGET = function(msg)
	if ( SecureCmdOptionParse(msg) ) then
		ClearTarget();
	end
end
handlers.TARGET_MARKER = function(msg)
	local marker, target = SecureCmdOptionParse(msg);
	if ( not target ) then
		target = "target";
	end
	if ( marker and string.find(marker, "^!") ) then
		marker = tonumber(string.match(marker, "%d+"));
		if ( GetRaidTargetIndex(target) == marker ) then
			return;
		end
	elseif ( marker and string.find(marker, "^~") ) then
		marker = tonumber(string.match(marker, "%d+"));
		if ( GetRaidTargetIndex(target) ~= nil ) then
			return;
		end
	else
		marker = tonumber(marker);
	end
	if ( marker ) then
		SetRaidTarget(target, tonumber(marker));
	end
end
`;
function run(script) {
	return runAddon({ stubs: ['stub_qol.lua'], addons: [FILES], login: true,
		script: `local B = Polestar.QoL.Buttons
		SLASH_CLEARTARGET1, SLASH_TARGET_EXACT1, SLASH_TARGET_MARKER1 = "/cleartarget", "/targetexact", "/tm"
		Polestar.Set("qol.guideNameTarget", true)
		${script}` }).emitted;
}

// Execute the target/clear/mark commands against nearby units. Conditions
// are evaluated when each line runs, as the target may have just changed.
function press(macro, nearby, oldTarget = null, combat = false) {
	let target = oldTarget;
	const marks = [];
	function allowed(options) {
		return options.split(',').every((option) => {
			if (option === '@target') return true;
			if (option === 'nocombat') return !combat;
			if (option === 'exists') return !!target;
			if (option === 'dead') return !!target?.dead;
			if (option === 'nodead') return !target?.dead;
			throw new Error(`Unknown macro condition: ${option}`);
		});
	}
	for (const line of macro.split('\n')) {
		const [, command, options, argument = ''] = line.match(/^\/(\w+)(?: \[([^\]]+)\])?(?: (.*))?$/) || [];
		assert.ok(command, `valid macro line: ${line}`);
		if (options && !allowed(options)) continue;
		if (command === 'cleartarget') target = null;
		else if (command === 'targetexact') target = nearby.filter((unit) => unit.name === argument)
			.sort((a, b) => (a.distance || 0) - (b.distance || 0))[0] || target;
		else if (command === 'tm') marks.push({ target, icon: Number(argument.replace(/^!/, '')) });
		else throw new Error(`Unexpected macro command: ${command}`);
	}
	return { target, marks };
}

test('guide name: exact localized NPC, with one clicked goal rather than the whole step', () => {
	const out = run(`
		Polestar.Names = { Npc = function(id) return ({ [10] = "Loup gris", [20] = "Maître des griffons" })[id] end }
		Polestar.QoL.CurrentStep = function() error("must not inspect other goals") end
		local macro, name = B.GuideNameMacro({ t = "kill", npc = 10, subject = "Grey Wolf" }, { npc = 99, target = "Unrelated Wolf" })
		emit({ macro, name })
		macro, name = B.GuideNameMacro({ t = "talk", npc = 20, npcName = "Gryphon Master" })
		emit({ macro, name })
		macro, name = B.GuideNameMacro({ t = "kill", subject = "O'Brien's Wolf" })
		emit({ macro, name })
	`);
	for (const [macro, name] of out) {
		assert.equal(macro.split('\n').filter((line) => line.startsWith('/targetexact')).length, 1);
		const wanted = { name };
		assert.deepEqual(press(macro, [{ name: 'Unrelated Wolf' }, wanted]), { target: wanted, marks: [{ target: wanted, icon: 3 }] });
	}
	assert.deepEqual(out.map((row) => row[1]), ['Loup gris', 'Maître des griffons', "O'Brien's Wolf"]);
});

test('guide name: collect uses the chosen or explicit NPC source, never the item or other droppers', () => {
	const out = run(`
		Polestar.Names = { Npc = function(id) return ({ [10] = "Araignée choisie", [20] = "Loup source" })[id] end }
		Polestar.QuestDB = { IsLoaded = function() error("must not inspect unrelated droppers") end }
		local function result(goal, raw)
			local macro, name = B.GuideNameMacro(goal, raw)
			emit(name or "nil")
		end
		result({ t = "collect", npc = 10, subject = "Spider Silk", source = { kind = "npc", name = "Other Spider" } },
			{ fromNpcs = { { npc = 99, npcName = "Another Spider" } } })
		result({ t = "collect", subject = "Wolf Meat", source = { kind = "npc", name = "Loup source", also = "Other Wolf" } })
		result({ t = "collect", subject = "Wolf Meat" }, { fromId = 20, from = "Source Wolf", fromKind = "npc" })
		result({ t = "collect", subject = "Oats", source = { kind = "object", name = "Sack of Oats" } })
		result({ t = "collect", subject = "Spider Silk", fromNpcs = { { npc = 10, npcName = "Spider" } } })
		result({ t = "collect", subject = "Spider Silk" })
	`);
	assert.deepEqual(out, ['Araignée choisie', 'Loup source', 'Loup source', 'nil', 'nil', 'nil']);
});

test('guide name: absent or dead NPC clears the old target without marking it; combat changes nothing', () => {
	const [macro] = run('emit(B.GuideNameMacro({ t = "kill", subject = "Grey Wolf" }))');
	const oldTarget = { name: 'Unrelated Bear' };
	assert.deepEqual(press(macro, [oldTarget], oldTarget), { target: null, marks: [] });
	assert.deepEqual(press(macro, [{ name: 'Grey Wolf', dead: true }], oldTarget), { target: null, marks: [] });
	assert.deepEqual(press(macro, [{ name: 'Grey Wolf' }], oldTarget, true), { target: oldTarget, marks: [] });
	assert.deepEqual(press(macro, [{ name: 'Grey Wolf' }], null, true), { target: null, marks: [] });
	assert.deepEqual(press(macro, [{ name: 'Grey Wolf', dead: true, distance: 1 }, { name: 'Grey Wolf', distance: 2 }]),
		{ target: null, marks: [] }, 'a nearest corpse is cleared; this macro cannot search past it');
	assert.equal(press(macro.split('\n').slice(1).join('\n'), [], oldTarget).marks[0].target, oldTarget,
		'without the initial clear, an unsuccessful exact match can leave and mark an unrelated target');
});

test('guide name: missing, unsafe and oversized names cannot create an action', () => {
	const out = run(`
		local goals = {
			{}, { t = "note", npcName = "Wolf" }, { t = "talk" },
			{ t = "kill", subject = "" }, { t = "kill", subject = 123 },
			{ t = "kill", subject = "Wolf\\n/run Unsafe()" },
			{ t = "kill", subject = "Wolf\\r/run Unsafe()" },
			{ t = "talk", npcName = "Wolf\\tOther" },
			{ t = "kill", subject = "Wolf; [combat] Bear" },
			{ t = "kill", subject = "[combat] Bear" },
			{ t = "kill", subject = "   " },
			{ t = "kill", subject = string.rep("W", 256) },
			{ t = "kill", subject = string.rep("é", 100) },
		}
		for _, goal in ipairs(goals) do emit(B.GuideNameMacro(goal) == nil) end
		emit(B.GuideNameMacro(nil) == nil)
		local macro = B.GuideNameMacro({ t = "kill", subject = string.rep("W", 100) })
		emit(macro and #macro <= 255 or false)
	`);
	assert.equal(out.length, 15);
	assert.ok(out.every(Boolean));
});

test('guide name: toggle and fixed marker are independent of target-button marking', () => {
	const out = run(`
		local goal = { t = "talk", npcName = "Innkeeper" }
		local function marker()
			local macro = B.GuideNameMacro(goal)
			emit(macro and macro:match("!(%d+)$") or "nil")
		end
		marker()
		Polestar.Set("qol.markTarget", true)
		Polestar.Set("qol.markNpc", "cycle")
		Polestar.Set("qol.guideNameIcon", "6")
		marker()
		marker()
		for _, value in ipairs({ "cycle", "9", "0", "2.5", "3\\n/run Unsafe()" }) do
			Polestar.Set("qol.guideNameIcon", value)
			marker()
		end
		Polestar.Set("qol.guideNameTarget", false)
		marker()
	`);
	assert.deepEqual(out, ['3', '6', '6', '3', '3', '3', '3', '3', 'nil']);
});

test('guide name: disabled by default, Diamond default, eight fixed icon choices', () => {
	const [defaults, control] = run(`
		emit({ Polestar.GetDefault("qol.guideNameTarget"), Polestar.GetDefault("qol.guideNameIcon") })
		local toggle, icon
		for _, spec in ipairs(Polestar.Widgets.OptionsRegistry) do
			for _, c in ipairs(spec.controls) do
				if c.key == "qol.guideNameTarget" then toggle = c end
				if c.key == "qol.guideNameIcon" then icon = c end
			end
		end
		assert(toggle and icon, "guide-name options registered")
		local values = {}
		for _, c in ipairs(icon.choices()) do values[#values + 1] = c.value end
		local active = not icon.disabled()
		Polestar.Set("qol.guideNameTarget", false)
		emit({ toggle.kind, icon.kind, values, active, icon.disabled() })
	`);
	assert.deepEqual(defaults, [false, '3']);
	assert.deepEqual(control, ['toggle', 'dropdown', ['1', '2', '3', '4', '5', '6', '7', '8'], true, true]);
});

test('guide name: only plain literal names, never unit references, markup or escape syntax', () => {
	const [rejected, accepted] = run(String.raw`
		local rejected = {}
		for _, name in ipairs({ " Wolf", "Wolf ", "\\Wolf", "/target", "Wolf|r", "|cff00ff00Wolf|r",
			"|Hunit:player|hWolf|h", "|Ttexture:0|tWolf", "|AWolf:0|a", "Wolf\0Other", "Wolf\127Other",
			"player", "PLAYER", "pet", "vehicle", "target", "targettarget", "focus", "focustarget",
			"mouseover", "mouseovertarget", "npc", "none", "party1", "partypet1", "party1target",
			"raid40", "raidpet40", "raid1targettarget", "arena1", "arenapet1", "boss1", "nameplate1",
			"maintank1", "mainassist1", "playertargetpet" }) do
			if B.GuideNameMacro({ t = "kill", subject = name }) ~= nil then rejected[#rejected + 1] = name end
		end
		emit(rejected)
		local accepted = {}
		for _, name in ipairs({ "Bael'dun Excavator", "Prospector Khazgorm", "Maître des griffons", "小狼", "Target Dummy", "Forest Spider" }) do
			local macro, resolved = B.GuideNameMacro({ t = "kill", subject = name })
			accepted[#accepted + 1] = macro and resolved or false
		end
		emit(accepted)
	`);
	assert.deepEqual(rejected, {});
	assert.deepEqual(accepted, ["Bael'dun Excavator", 'Prospector Khazgorm', 'Maître des griffons', '小狼', 'Target Dummy', 'Forest Spider']);
});

test('guide name: chosen names stay together and a named primary source never becomes another source', () => {
	const out = run(`
		Polestar.Names = { Npc = function(id) return id == 99 and "Raw NPC" or nil end }
		local function result(goal, raw)
			local macro, name = B.GuideNameMacro(goal, raw)
			emit(name or false)
		end
		result({ t = "collect", npcName = "Chosen NPC" }, { npc = 99, npcName = "Raw NPC", from = "Source NPC" })
		result({ t = "kill", npc = 10, subject = "View NPC" }, { npc = 10, target = "Raw NPC" })
		result({ t = "collect", source = { kind = "npc", name = "Primary NPC", also = "Other NPC" } })
		result({ t = "collect" }, { from = "Primary NPC", fromAlso = "Other NPC", fromKind = "npc" })
		result({ t = "collect", source = { kind = "npc", name = "player", also = "Other NPC" } })
		result({ t = "collect" }, { fromNpcs = { { npcName = "First NPC" }, { npcName = "Other NPC" } } })
	`);
	assert.deepEqual(out, ['Chosen NPC', 'View NPC', 'Primary NPC', 'Primary NPC', false, false]);
});

test('guide name: client command aliases, fail closed when absent or malformed, byte limit includes aliases', () => {
	const [localized, bad, boundary] = run(String.raw`
		local goal = { t = "talk", npcName = "Innkeeper" }
		SLASH_CLEARTARGET1, SLASH_TARGET_EXACT1, SLASH_TARGET_MARKER1 = "/effacercible", "/cibleexacte", "/marquecible"
		emit(B.GuideNameMacro(goal))
		local bad = {}
		for _, key in ipairs({ "SLASH_CLEARTARGET1", "SLASH_TARGET_EXACT1", "SLASH_TARGET_MARKER1" }) do
			local original = _G[key]
			_G[key] = nil
			bad[#bad + 1] = B.GuideNameMacro(goal) == nil
			for _, value in ipairs({ "", "targetexact", "/run X()", "/tm\n/run X()", "/tm;", "/tm[combat]", "/tm|r", "/tm\\", "//tm", 123 }) do
				_G[key] = value
				bad[#bad + 1] = B.GuideNameMacro(goal) == nil
			end
			_G[key] = original
		end
		emit(bad)
		SLASH_CLEARTARGET1 = "/" .. string.rep("清", 8)
		SLASH_TARGET_EXACT1 = "/" .. string.rep("目", 8)
		SLASH_TARGET_MARKER1 = "/" .. string.rep("印", 8)
		local base = B.GuideNameMacro({ t = "kill", subject = "W" })
		assert(base and #base < 255)
		local count = 255 - #base + 1
		local exact = B.GuideNameMacro({ t = "kill", subject = string.rep("W", count) })
		local oversized = B.GuideNameMacro({ t = "kill", subject = string.rep("W", count + 1) })
		emit({ #exact, oversized == nil })
	`);
	assert.match(localized, /^\/effacercible \[nocombat\]\n\/cibleexacte \[nocombat\] Innkeeper\n\/effacercible \[nocombat,dead\]\n\/marquecible /);
	assert.equal(bad.length, 33);
	assert.ok(bad.every(Boolean));
	assert.deepEqual(boundary, [255, true]);
});

test('guide name: Forever handler bodies keep marks on repeat and never mark a stale target', () => {
	const out = run(FOREVER_HANDLERS + String.raw`
		-- Import the command aliases by the client's key/number convention:
		-- ChatFrameUtil.lua:794-818. Artificial localized aliases ensure the
		-- generated macro and dispatch agree without assuming English support.
		SLASH_CLEARTARGET1, SLASH_TARGET_EXACT1, SLASH_TARGET_MARKER1 = "/clear-local", "/exact-local", "/mark-local"
		local dispatch = {}
		for key, fn in pairs(handlers) do
			local i, tag = 1, _G["SLASH_" .. key .. "1"]
			while tag do
				dispatch[string.upper(tag)] = fn
				i = i + 1
				tag = _G["SLASH_" .. key .. i]
			end
		end
		local target, nearby, combat, marks, targetCalls
		function SecureCmdOptionParse(msg)
			local conditions, action = msg:match("^%[([^%]]+)%]%s*(.*)$")
			assert(conditions, "test double accepts only generated conditional lines")
			local unit
			for condition in conditions:gmatch("[^,]+") do
				if condition == "@target" then unit = "target"
				elseif condition == "nocombat" then if combat then return nil end
				elseif condition == "exists" then if not target then return nil end
				elseif condition == "dead" then if not (target and target.dead) then return nil end
				elseif condition == "nodead" then if target and target.dead then return nil end
				else error("Unexpected condition: " .. condition) end
			end
			return action, unit
		end
		function ClearTarget() target = nil end
		function TargetUnit(name, exact)
			targetCalls[#targetCalls + 1] = { name, exact }
			-- Model a failed native lookup retaining the target and a corpse
			-- winning the nearest match. The macro must be safe in both cases.
			local best
			for _, unit in ipairs(nearby) do
				if unit.name == name and (not best or unit.distance < best.distance) then best = unit end
			end
			if best then target = best end
		end
		function GetRaidTargetIndex(unit)
			assert(unit == "target")
			return target and target.icon
		end
		function SetRaidTarget(unit, icon)
			assert(unit == "target" and target and not target.dead)
			marks[#marks + 1] = { target.name, icon }
			target.icon = icon
		end
		local macro = B.GuideNameMacro({ t = "collect", source = { kind = "npc", name = "Prospector Khazgorm", also = "Other NPC" } })
		local function play(units, old, inCombat, count, text)
			nearby, target, combat, marks, targetCalls = units, old, inCombat, {}, {}
			for i = 1, count or 1 do
				for line in (text or macro):gmatch("[^\n]+") do
					local command, msg = line:match("^(%S+)%s*(.*)$")
					local fn = assert(dispatch[string.upper(command)], "registered client alias")
					fn(msg:match("^%s*(.-)%s*$"))
				end
			end
			emit({ name = target and target.name or false, icon = target and target.icon or false,
				marks = marks, targetCalls = targetCalls })
		end
		local old = { name = "Unrelated Bear", distance = 1 }
		local live = { name = "Prospector Khazgorm", distance = 2 }
		play({ live }, old, false, 2)
		play({ old }, old, false)
		play({ { name = "Prospector Khazgorm", distance = 1, dead = true }, live }, old, false)
		play({ live }, old, true)
		-- The real handler calls TargetUnit(name,true); it does not itself
		-- clear on failed lookup. Removing our initial clear demonstrates why
		-- it is required before an exists/nodead mark condition.
		play({ old }, old, false, 1, macro:match("^[^\n]+\n(.*)$"))
	`);
	assert.equal(out[0].name, 'Prospector Khazgorm');
	assert.equal(out[0].icon, 3);
	assert.deepEqual(out[0].marks, [['Prospector Khazgorm', 3]], 'the real ! handler skips an already assigned marker');
	assert.deepEqual(out[0].targetCalls, [['Prospector Khazgorm', true], ['Prospector Khazgorm', true]]);
	for (const row of out.slice(1, 3)) {
		assert.equal(row.name, false);
		assert.deepEqual(row.marks, {});
	}
	assert.equal(out[3].name, 'Unrelated Bear');
	assert.deepEqual(out[3].marks, {});
	assert.deepEqual(out[3].targetCalls, {});
	assert.deepEqual(out[4].marks, [['Unrelated Bear', 3]], 'control case proves the initial clear is necessary');
});
