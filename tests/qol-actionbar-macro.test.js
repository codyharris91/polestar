'use strict';
// The real macro manager and target builder against local native-API doubles.
// These verify ownership and write scheduling, not execution of a client macro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');

const FILES = { name: 'Polestar', files: ['Core/Init.lua', 'Core/Compat.lua', 'Theme/Theme.xml', 'QoL/QoL.xml'] };

// Slots compact after deletion/reordering. Each native write synchronously
// fires UPDATE_MACROS, so missing write guards fail here, not just in game.
const NATIVE = String.raw`
Constants = Constants or {}
Constants.MacroConsts = { MAX_ACCOUNT_MACROS = 120, MAX_CHARACTER_MACROS = 30 }
local BASE = Constants.MacroConsts.MAX_ACCOUNT_MACROS
macroMock = { account = {}, character = {}, calls = {}, cursor = nil }
local m = macroMock
local function slot(index)
	if index > BASE then return m.character, index - BASE end
	return m.account, index
end
local function writeAllowed()
	assert(not stub.inCombat, "macro write during combat")
	assert(not (MacroFrame and MacroFrame:IsShown()), "macro write while editor is open")
end
function GetNumMacros() return #m.account, #m.character end
function GetMacroInfo(index)
	local list, i = slot(index)
	local entry = list[i]
	if entry then return entry.name, entry.icon or 134400, entry.body end
end
function GetMacroBody(index) return select(3, GetMacroInfo(index)) end
function GetCursorInfo() if m.cursor then return unpack(m.cursor) end end
function CreateMacro(name, icon, body, perCharacter)
	writeAllowed()
	m.calls[#m.calls + 1] = { "create", name, body, perCharacter }
	if m.createFailure then return nil end
	local list = perCharacter and m.character or m.account
	list[#list + 1] = { name = name, icon = icon, body = m.truncate and body:sub(1, 12) or body }
	stub.fire("UPDATE_MACROS")
	if m.onWrite then m.onWrite() end
	return (perCharacter and BASE or 0) + #list
end
function EditMacro(index, name, icon, body)
	writeAllowed()
	local list, i = slot(index)
	local entry = assert(list[i], "editing missing macro slot")
	m.calls[#m.calls + 1] = { "edit", index, body }
	if m.editFailure then return nil end
	entry.name, entry.icon = name or entry.name, icon or entry.icon
	entry.body = m.truncate and body:sub(1, 12) or body
	stub.fire("UPDATE_MACROS")
	if m.onWrite then m.onWrite() end
	return index
end
function PickupMacro(index)
	writeAllowed()
	assert(GetMacroInfo(index), "picking up missing macro")
	m.calls[#m.calls + 1] = { "pickup", index }
	if not m.pickupFailure then m.cursor = { "macro", index } end
end
function RunMacro() error("manager must not execute macros") end
function RunMacroText() error("manager must not execute macros") end
C_Macro = { RunMacroText = RunMacroText }
function UseAction() error("manager must not execute actions") end
function PlaceAction() error("player chooses the action-bar slot") end
function m.editor()
	if not MacroFrame then
		MacroFrame = CreateFrame("Frame", "MacroFrame", UIParent)
		MacroFrame:Hide()
		stub.fire("ADDON_LOADED", "Blizzard_MacroUI")
	end
	return MacroFrame
end
function m.count(kind)
	local count = 0
	for _, call in ipairs(m.calls) do if call[1] == kind then count = count + 1 end end
	return count
end
`;

const PRELUDE = `
local A, Q, B, q, m = Polestar.QoL.ActionBarMacro, Polestar.QoL, Polestar.QoL.Buttons, stub.qol, macroMock
local function setting(key, value) Polestar.Set("qol." .. key, value); stub.runTimers() end
local function step(name) q.step({ { t = "kill", target = name } }) end
local function refresh() A.Refresh(); stub.runTimers() end
local function owned() return Q.State().actionBarMacro end
local function body() return m.character[1] and m.character[1].body end
`;

function run(script, { before = '', saved, login = true } = {}) {
	return runAddon({ stubs: ['stub_qol.lua'], before: NATIVE + before, addons: [FILES], saved,
		login, script: PRELUDE + script }).emitted;
}

test('action-bar macro: explicit character creation and pickup, independent of the floating button', () => {
	const [out] = run(`
		m.account[1] = { name = "Personal", body = "/say hello" }
		setting("targetButton", false)
		setting("markTarget", true)
		q.step({ { t = "kill", target = "Wolf" }, { t = "kill", target = "Boar" } })
		assert(m.count("create") == 0, "login and guide changes must not create a macro")
		local placed = A.Place()
		local first = body()
		local record = owned()
		m.cursor = nil
		local again = A.Place()
		emit({ supported = A.Supported(), placed = placed, again = again, managed = A.IsManaged(),
			name = m.character[1].name, body = first, character = m.calls[1][4],
			state = { record.name, record.body, record.enabled }, cursor = m.cursor,
			creates = m.count("create"), edits = m.count("edit"), pickups = m.count("pickup"), account = m.account[1].body })
	`);
	assert.equal(out.supported, true);
	assert.equal(out.placed, true);
	assert.equal(out.again, true);
	assert.equal(out.managed, true);
	assert.equal(out.name, 'Polestar Target');
	assert.equal(out.character, true);
	assert.match(out.body, /\/targetexact Wolf\n/);
	assert.match(out.body, /\/targetexact \[noexists\] Boar/);
	assert.match(out.body, /\/tm .* !8$/);
	assert.doesNotMatch(out.body, /\/(?:click|run|cast|use)\b/);
	assert.deepEqual(out.state, ['Polestar Target', out.body, true]);
	assert.deepEqual(out.cursor, ['macro', 121]);
	assert.deepEqual([out.creates, out.edits, out.pickups], [1, 0, 2]);
	assert.equal(out.account, '/say hello');
});

test('action-bar macro: quest and settings updates replace the body, completion removes stale targets, Stop preserves it', () => {
	const [out] = run(`
		setting("markTarget", true)
		q.step({ { t = "kill", target = "Wolf" }, { t = "kill", target = "Boar" } })
		assert(A.Place()); m.cursor = nil
		q.engine.view.goals[1].status = "done"
		stub.fire("QUEST_LOG_UPDATE"); stub.runTimers()
		local questBody = body()
		setting("markMob", "2")
		local marked = body()
		setting("markTarget", false)
		local unmarked = body()
		q.engine.step, q.engine.view, q.engine.guide = nil, nil, nil
		Polestar.Fire("STEP_CHANGED"); stub.runTimers()
		local empty, count = body(), m.count("edit")
		refresh(); stub.fire("UPDATE_MACROS"); stub.runTimers()
		assert(m.count("edit") == count, "unchanged body and synchronous write events must not loop")
		local stopped = A.Stop()
		step("Bear")
		emit({ quest = questBody, marked = marked, unmarked = unmarked, empty = empty, after = body(),
			stopped = stopped, enabled = owned().enabled, managed = A.IsManaged(), pickups = m.count("pickup") })
	`);
	assert.match(out.quest, /\/targetexact Boar/);
	assert.doesNotMatch(out.quest, /Wolf/);
	assert.match(out.marked, / !2$/);
	assert.doesNotMatch(out.unmarked, /\/tm /);
	assert.equal(out.empty, '# Polestar: no active target');
	assert.equal(out.after, out.empty);
	assert.equal(out.stopped, true);
	assert.equal(out.enabled, false);
	assert.equal(out.managed, true, 'Stop retains ownership while disabling updates');
	assert.equal(out.pickups, 1);
});

test('action-bar macro: fresh slot scanning survives another macro being inserted ahead of it', () => {
	const [out] = run(`
		step("Wolf"); assert(A.Place()); m.cursor = nil
		table.insert(m.character, 1, { name = "Other", body = "/say keep me" })
		stub.fire("UPDATE_MACROS"); stub.runTimers()
		step("Bear")
		local edited
		for _, call in ipairs(m.calls) do if call[1] == "edit" then edited = call[2] end end
		assert(A.Place())
		emit({ index = edited, cursor = m.cursor, other = m.character[1].body,
			body = m.character[2].body, creates = m.count("create"), managed = A.IsManaged() })
	`);
	assert.equal(out.index, 122);
	assert.deepEqual(out.cursor, ['macro', 122]);
	assert.equal(out.other, '/say keep me');
	assert.match(out.body, /\/targetexact Bear/);
	assert.equal(out.creates, 1);
	assert.equal(out.managed, true);
});

test('action-bar macro: edits, renames, deletion and duplicate names relinquish ownership without writing', () => {
	for (const mutation of [
		'm.character[1].body = "/say my edit"',
		'm.character[1].name = "My renamed macro"',
		'table.remove(m.character, 1)',
		'table.insert(m.character, { name = "Polestar Target", body = m.character[1].body })',
	]) {
		const [out] = run(`
			step("Wolf"); assert(A.Place()); m.cursor = nil
			${mutation}
			stub.fire("UPDATE_MACROS"); stub.runTimers()
			step("Bear"); refresh()
			emit({ managed = A.IsManaged(), state = owned() ~= nil,
				creates = m.count("create"), edits = m.count("edit"), pickups = m.count("pickup") })
		`);
		assert.deepEqual(out, { managed: false, state: false, creates: 1, edits: 0, pickups: 1 }, mutation);
	}
});

test('action-bar macro: combat defers only the latest body and never queues a pickup', () => {
	const [out] = run(`
		step("Wolf"); assert(A.Place()); m.cursor = nil
		local first = body()
		q.combat(true)
		step("Bear"); step("Boar")
		setting("markTarget", true); setting("markMob", "4")
		local placed = A.Place()
		assert(body() == first and m.count("edit") == 0)
		q.combat(false); stub.runTimers()
		emit({ placed = placed, body = body(), edits = m.count("edit"),
			pickups = m.count("pickup"), cursor = m.cursor or false, managed = A.IsManaged() })
	`);
	assert.equal(out.placed, false);
	assert.match(out.body, /\/targetexact Boar/);
	assert.doesNotMatch(out.body, /Bear|Wolf/);
	assert.match(out.body, / !4$/);
	assert.equal(out.edits, 1);
	assert.equal(out.pickups, 1);
	assert.equal(out.cursor, false);
	assert.equal(out.managed, true);
});

test('action-bar macro: the macro editor defers writes and closing revalidates unsaved user edits', () => {
	const [out] = run(`
		step("Wolf"); assert(A.Place()); m.cursor = nil
		local editor = m.editor()
		editor:Show(); step("Bear"); step("Boar")
		assert(not A.Place(), "placing cannot write while an editor is open")
		assert(m.count("edit") == 0)
		editor:Hide(); stub.runTimers()
		local resumed = body()
		assert(m.count("edit") == 1)
		editor:Show(); step("Tiger")
		-- Saving an edit on close happens before queued manager work resumes.
		m.character[1].body = "/say user saved this"
		stub.fire("UPDATE_MACROS")
		editor:Hide(); stub.runTimers(); refresh()
		emit({ resumed = resumed, body = body(), managed = A.IsManaged(), state = owned() ~= nil,
			edits = m.count("edit"), creates = m.count("create"), pickups = m.count("pickup") })
	`);
	assert.match(out.resumed, /\/targetexact Boar/);
	assert.equal(out.body, '/say user saved this');
	assert.deepEqual([out.managed, out.state, out.edits, out.creates, out.pickups], [false, false, 1, 1, 1]);
});

test('action-bar macro: explicit creation refuses blocked contexts and name collisions', () => {
	const cases = [
		'q.combat(true)',
		'm.cursor = { "item", 17 }',
		'm.editor():Show()',
		'for i = 1, Constants.MacroConsts.MAX_CHARACTER_MACROS do m.character[i] = { name = "Other " .. i, body = "/say hi" } end',
		'm.character[1] = { name = "Polestar Target", body = "/say existing" }',
		'm.account[1] = { name = "Polestar Target", body = "/say account macro" }',
		'PickupMacro = nil',
		'Constants.MacroConsts = nil',
		'step(string.rep("W", 400))',
	];
	for (const setup of cases) {
		const [out] = run(`
			step("Wolf")
			${setup}
			local prior = #m.character
			emit({ placed = A.Place(), before = prior, after = #m.character,
				creates = m.count("create"), edits = m.count("edit"), pickups = m.count("pickup"), state = owned() ~= nil })
		`);
		assert.equal(out.placed, false, setup);
		assert.equal(out.after, out.before, setup);
		assert.deepEqual([out.creates, out.edits, out.pickups, out.state], [0, 0, 0, false], setup);
	}
});

test('action-bar macro: native failures and truncated readback never establish or silently renew ownership', () => {
	const [failed, truncated, edited] = run(`
		step("Wolf")
		m.createFailure = true
		emit({ placed = A.Place(), managed = A.IsManaged(), count = #m.character, pickups = m.count("pickup") })
		m.createFailure, m.truncate = false, true
		emit({ placed = A.Place(), managed = A.IsManaged(), state = owned() ~= nil, pickups = m.count("pickup") })
		m.character, m.truncate = {}, false
		assert(A.Place()); m.cursor = nil
		m.truncate = true
		step("Bear"); refresh()
		local edits = m.count("edit")
		refresh(); stub.fire("UPDATE_MACROS"); stub.runTimers()
		emit({ managed = A.IsManaged(), state = owned() ~= nil, edits = edits, after = m.count("edit") })
	`);
	assert.deepEqual(failed, { placed: false, managed: false, count: 0, pickups: 0 });
	assert.deepEqual(truncated, { placed: false, managed: false, state: false, pickups: 0 });
	assert.deepEqual(edited, { managed: false, state: false, edits: 1, after: 1 });
});

test('action-bar macro: login resumes only a verified saved owner, never creates a missing macro', () => {
	for (const exists of [true, false]) {
		const [out] = run(`
			emit({ managed = A.IsManaged(), creates = m.count("create"), edits = m.count("edit"),
				body = body() or false, pickups = m.count("pickup") })
		`, { before: exists ? 'macroMock.character[1] = { name = "Polestar Target", body = "/targetexact Old Wolf" }' : '',
			saved: { Polestar: 'PolestarCharDB = { qol = { actionBarMacro = { name = "Polestar Target", body = "/targetexact Old Wolf", enabled = true } } }' } });
		assert.equal(out.managed, exists);
		assert.equal(out.creates, 0);
		assert.equal(out.pickups, 0);
		assert.equal(out.edits, exists ? 1 : 0);
		assert.equal(out.body, exists ? '# Polestar: no active target' : false);
	}
});

test('action-bar macro: options create, stop and explicitly resume without creating a duplicate', () => {
	const [out] = run(`
		local create, stop, tab
		for _, spec in ipairs(Polestar.Widgets.OptionsRegistry) do
			if spec.section == "Action-bar macro" then
				tab = spec.tab
				for _, control in ipairs(spec.controls) do
					if control.label == "Create target macro" then create = control end
					if control.label == "Stop macro updates" then stop = control end
				end
			end
		end
		assert(create and stop and not create.disabled())
		step("Wolf"); create.onClick(); m.cursor = nil
		assert(A.IsManaged() and owned().enabled)
		stop.onClick(); step("Bear")
		local stopped = body()
		create.onClick(); m.cursor = nil
		local resumed = body()
		PickupMacro = nil
		local disabled = create.disabled()
		stop.onClick()
		emit({ tab = tab, stopped = stopped, resumed = resumed, enabled = owned().enabled,
			disabled = disabled, stopAvailable = not stop.disabled or not stop.disabled(),
			creates = m.count("create"), pickups = m.count("pickup") })
	`);
	assert.equal(out.tab, 'Buttons');
	assert.match(out.stopped, /\/targetexact Wolf/);
	assert.match(out.resumed, /\/targetexact Bear/);
	assert.equal(out.enabled, false);
	assert.equal(out.disabled, true);
	assert.equal(out.stopAvailable, true);
	assert.deepEqual([out.creates, out.pickups], [1, 2]);
});

test('action-bar macro: synchronous cursor changes and a failed pickup never replace another cursor item or report success', () => {
	const [changed, failed] = run(`
		step("Wolf")
		-- Another addon's synchronous macro callback can claim the cursor.
		m.onWrite = function() m.cursor = { "item", 17 } end
		local placed = A.Place()
		emit({ placed = placed, cursor = m.cursor, pickups = m.count("pickup"), managed = A.IsManaged() })
		m.onWrite, m.cursor, m.pickupFailure = nil, nil, true
		placed = A.Place()
		emit({ placed = placed, cursor = m.cursor or false, creates = m.count("create"), managed = A.IsManaged() })
	`);
	assert.deepEqual(changed, { placed: false, cursor: ['item', 17], pickups: 0, managed: true });
	assert.deepEqual(failed, { placed: false, cursor: false, creates: 1, managed: true });
});
