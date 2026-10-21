'use strict';
// Upgrade arrows on bag items (addon/Polestar/Gear/Bags.lua): the reward
// panel's green arrow on each item in the bags that Gear calls an upgrade, in
// the client's bags (each container frame's UpdateItems, post-hooked) and in
// Baganator (a corner widget); redrawn as the verdicts change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');

const ADDON = { name: 'Polestar', files: ['Core/Core.xml', 'Theme/Theme.xml', 'Gear/Gear.xml'] };

// Items in the generated ItemDB format (tools/lib/itemdb/stats.js encode).
const ITEMS = `{
	[9001] = "1 20 15 2 4 3 str5 sta3 armor150",
	[9002] = "1 25 20 2 4 3 str10 sta4 armor170",
	[9004] = "1 20 15 2 4 1 int10 spi5 armor30",
	[9005] = "1 35 30 2 4 4 str8 sta8 armor300",
	[9006] = "1 25 20 2 4 3 str10 sta4 armor170 crit1",
	[9040] = "16 20 15 2 4 1 sta3",
}`;

// A level 30 Troll Warrior wearing the 9001 helm. In the bags: 9002 (a better
// helm, +62%), 9004 (a cloth cap, a downgrade), 9005 (plate: an upgrade only
// at level 40) and 9040 (a cloak for the empty back slot).
const BAGS = `
g.equip(1, "item:9001")
g.bag(0, 1, "item:9002"); g.bag(0, 2, "item:9004"); g.bag(0, 3, "item:9005"); g.bag(0, 4, "item:9040")
`;

const HELPERS = `
local T = Polestar.Theme
local function arrow(button)
	for _, r in ipairs(button.regions) do
		if type(r.texture) == "string" and r.texture:find("qol%-upgrade$") then return r end
	end
	return nil
end
local function arrows(bag, combined)
	local out = {}
	for slot = 1, 16 do
		local a = arrow(g.bagButton(bag, slot, combined))
		if a and a:IsShown() then out[#out + 1] = slot end
	end
	return out
end
local function keys(t)
	local out = {}
	for k in pairs(t) do out[#out + 1] = tostring(k) end
	table.sort(out)
	return table.concat(out, ",")
end
`;

function run(script, { before = '' } = {}) {
	return runAddon({
		stubs: ['stub_world.lua', 'stub_gear.lua'],
		before: `w = stub.world; g = stub.gear
w.class, w.className, w.classID, w.level = "WARRIOR", "Warrior", 1, 30
w.race, w.raceName, w.raceID, w.faction = "Troll", "Troll", 8, "Horde"
${before}`,
		addons: [ADDON],
		login: true,
		script: `G = Polestar.Gear
Polestar.ItemDB.Register({ schema = 1, build = "test" }, ${ITEMS})
${HELPERS}
${script}`,
	}).emitted;
}

test('the client\'s bags: a green arrow on each upgrade, top-left under the search overlay; none on a downgrade or an item for a later level', () => {
	const [marked, look, untouched, under] = run(`${BAGS}
		local button = g.bagButton(0, 1)
		local before = keys(button)
		g.openBag(0)
		emit(arrows(0))
		local a = arrow(button)
		local r, gr, b = a:GetVertexColor()
		local sr, sg, sb = T.Color("success")
		local point, rel, relPoint = a:GetPoint(1)
		emit({ tint = r == sr and gr == sg and b == sb, layer = a.layer, sublayer = a.sublayer, size = { a:GetSize() },
			point = point, onButton = rel == button, relPoint = relPoint })
		emit(keys(button) == before)
		emit(table.concat(stub.underGameFrames, "; "))
	`);
	assert.deepEqual(marked, [1, 4], 'the better helm and the cloak for the empty slot');
	assert.deepEqual(look, { tint: true, layer: 'OVERLAY', sublayer: 3, size: [20, 20], point: 'TOPLEFT', onButton: true, relPoint: 'TOPLEFT' });
	assert.equal(untouched, true, "nothing is written into the bag button's table");
	assert.equal(under, '', 'no frame is made under a game frame');
});

test('the client\'s bags: arrows follow the verdict (a better piece worn, a bag change, the setting, gear advice off), redrawn once per burst', () => {
	const [first, worn, added, off, on, gearOff, burst] = run(`${BAGS}
		g.openBag(0)
		emit(arrows(0))
		g.equip(1, "item:9006")
		stub.advance(0.25)
		emit(arrows(0))
		g.bag(0, 5, "item:9040")
		emit(arrows(0))
		Polestar.Set("gear.bagArrows", false); stub.advance(0.25)
		emit(arrows(0))
		Polestar.Set("gear.bagArrows", true); stub.advance(0.25)
		emit(arrows(0))
		Polestar.Set("gear.enabled", false); stub.advance(0.25)
		emit(arrows(0))
		Polestar.Set("gear.enabled", true); stub.advance(0.25)
		local redraws, redraw = 0, G.Bags.Redraw
		G.Bags.Redraw = function() redraws = redraws + 1; redraw() end
		for _ = 1, 10 do stub.fire("GET_ITEM_INFO_RECEIVED", 9002, true) end
		stub.advance(0.25)
		emit(redraws)
	`);
	assert.deepEqual(first, [1, 4]);
	assert.deepEqual(worn, [4], 'the 9002 helm is no upgrade over the 9006 helm now worn');
	assert.deepEqual(added, [4, 5], 'a cloak put in the bag gets its arrow as the bag updates');
	assert.deepEqual(off, {}, 'gear.bagArrows off (an empty list)');
	assert.deepEqual(on, [4, 5]);
	assert.deepEqual(gearOff, {}, 'gear advice off (an empty list)');
	assert.equal(burst, 1, 'ten new verdicts in a burst redraw the bags once');
});

test('the client\'s bags: the combined backpack gets the arrows too; closed bags are left alone', () => {
	const [combined, closed] = run(`${BAGS}
		g.openCombined()
		emit(arrows(0, true))
		g.closeBags()
		g.equip(1, "item:9006")
		stub.advance(0.25)
		emit(arrows(0, true))
	`);
	assert.deepEqual(combined, [1, 4]);
	assert.deepEqual(closed, [1, 4], 'a closed frame keeps its arrows until the client updates it as it opens');
});

// Baganator's corner widget API (Baganator/API/Main.lua, RegisterCornerWidget:
// onUpdate(widget, details) -> show, onInit(button) -> region; the arrow's
// place and visibility are Baganator's).
const BAGANATOR = `
__widgets, __refreshes = {}, {}
Baganator = {
	API = {
		RegisterCornerWidget = function(label, id, onUpdate, onInit, position, isFast)
			__widgets[#__widgets + 1] = { label = label, id = id, onUpdate = onUpdate, onInit = onInit, position = position }
		end,
		IsCornerWidgetActive = function(id) return id == "polestar_upgrade" end,
		RequestItemButtonsRefresh = function(reasons) __refreshes[#__refreshes + 1] = reasons or "all" end,
	},
	Constants = { RefreshReason = { ItemWidgets = 4, Searches = 16 } },
}`;

test('Baganator: a top-left corner widget shows the arrow on upgrades, and is refreshed when the verdicts change', () => {
	const [reg, look, verdicts, refreshes] = run(
		`${BAGS}
		local w = __widgets[1]
		emit({ count = #__widgets, label = w.label, id = w.id, corner = w.position.corner, priority = w.position.priority })
		local button = CreateFrame("Button", nil, UIParent)
		local a = w.onInit(button)
		emit({ texture = a.texture:match("([%w-]+)$"), size = { a:GetSize() }, layer = a.layer })
		emit({
			w.onUpdate(a, { itemLink = "item:9002" }), w.onUpdate(a, { itemLink = "item:9004" }),
			w.onUpdate(a, { itemLink = "item:9005" }), w.onUpdate(a, { itemLink = "item:9040" }),
			w.onUpdate(a, {}), w.onUpdate(a, nil),
		})
		__refreshes = {}
		g.equip(1, "item:9006")
		stub.advance(0.25)
		emit(__refreshes)
	`,
		{ before: BAGANATOR },
	);
	assert.deepEqual(reg, { count: 1, label: 'Polestar', id: 'polestar_upgrade', corner: 'top_left', priority: 1 });
	assert.deepEqual(look, { texture: 'qol-upgrade', size: [20, 20], layer: 'OVERLAY' });
	assert.deepEqual(verdicts, [true, false, false, true, false, false]);
	assert.deepEqual(refreshes, [[4]], 'one item-widget refresh for the new verdicts');
});

test('Baganator loaded after Polestar: the widget registers as it loads, once', () => {
	const [before, after] = run(`
		emit(#(__widgets or {}))
		${BAGANATOR}
		stub.addonLoaded("Baganator")
		stub.addonLoaded("Baganator")
		emit(#__widgets)
	`);
	assert.equal(before, 0);
	assert.equal(after, 1);
});

test('the client\'s bags: an item for an empty slot gets the arrow even when the weights give it no value; a loss, a later-level item and a filled slot do not', () => {
	const [out] = run(`${BAGS}
		-- The wrist slot is empty. A warrior's weights give spell hit nothing.
		local function wrist(id, req, stat, n)
			g.defineItem("item:" .. id, { equipLoc = "INVTYPE_WRIST", classID = 4, subclassID = 3, minLevel = req, stats = { [stat] = n } })
		end
		wrist(8001, 10, "ITEM_MOD_HIT_SPELL_RATING_SHORT", 2) -- worth nothing, no loss
		wrist(8002, 10, "ITEM_MOD_STRENGTH_SHORT", -5) -- a loss
		wrist(8003, 40, "ITEM_MOD_HIT_SPELL_RATING_SHORT", 2) -- for a later level
		g.bag(0, 5, "item:8001"); g.bag(0, 6, "item:8002"); g.bag(0, 7, "item:8003")
		g.openBag(0)
		local empty = arrows(0)
		local verdict = { G.IsUpgrade("item:8001"), G.FillsEmptySlot("item:8001") }
		wrist(8005, 10, "ITEM_MOD_STRENGTH_SHORT", 1)
		g.equip(9, "item:8005")
		stub.advance(0.25)
		emit({ empty = empty, verdict = verdict, filled = arrows(0) })
	`);
	assert.deepEqual(out.empty, [1, 4, 5], 'the helm and the cloak as before, and the zero-value bracer; not the loss, not the level 40 one');
	assert.deepEqual(out.verdict, [false, true], 'IsUpgrade is unchanged: no gain, no upgrade');
	assert.deepEqual(out.filled, [1, 4], 'with the slot filled, the zero-value bracer is no upgrade');
});

test('the client\'s bags: an item the class cannot use gets no empty-slot arrow (a wand for a warrior, whose ranged slot is empty)', () => {
	const [out] = run(`${BAGS}
		g.defineItem("item:8101", { equipLoc = "INVTYPE_RANGEDRIGHT", classID = 2, subclassID = 19, minLevel = 10, stats = { ITEM_MOD_INTELLECT_SHORT = 2 } })
		g.bag(0, 5, "item:8101")
		g.openBag(0)
		emit({ arrows = arrows(0), fills = G.FillsEmptySlot("item:8101") })
	`);
	assert.deepEqual(out, { arrows: [1, 4], fills: false });
});

// EllesmereUI Bags' item overlay API (EllesmereUIBags/EUI_Bags_Slots.lua):
// RegisterItemOverlayIcon(name, fn(button, data)) runs on every painted slot;
// the arrow goes on the button's _textOverlay; RefreshInventory rebuilds its
// whole window, which Polestar leaves to it.
const ELLESMERE = `
EUI_Bags = { itemOverlayIcons = {}, refreshes = 0, shown = true }
function EUI_Bags.RegisterItemOverlayIcon(name, fn) EUI_Bags.itemOverlayIcons[name] = fn end
function EUI_Bags:IsShown() return self.shown end
function EUI_Bags:RefreshInventory() self.refreshes = self.refreshes + 1 end
function slot(link, bag, n)
	local button = CreateFrame("Button", nil, UIParent)
	button._textOverlay = CreateFrame("Frame", nil, button)
	return button, { bag = bag, slot = n, itemLink = link }
end
function paint(button, data) EUI_Bags.itemOverlayIcons.Polestar(button, data) end
function shown(button)
	for _, r in ipairs(button._textOverlay.regions) do
		if type(r.texture) == "string" and r.texture:find("qol%-upgrade$") then return r:IsShown() end
	end
	return false
end`;

test('EllesmereUI Bags: a painter puts the arrow bottom-left on the slot\'s overlay for upgrades, and takes it off when the verdict changes', () => {
	const [reg, verdicts, look, after] = run(
		`${BAGS}
		emit({ names = keys(EUI_Bags.itemOverlayIcons) })
		local a, da = slot("item:9002", 0, 1)
		local b, db = slot("item:9004", 0, 2)
		local c = slot(nil, 0, 0)
		paint(a, da); paint(b, db); paint(c, {})
		emit({ shown(a), shown(b), shown(c) })
		local r
		for _, x in ipairs(a._textOverlay.regions) do if x.texture then r = x end end
		emit({ size = { r:GetSize() }, layer = r.layer, point = r.points[1].point })
		g.equip(1, "item:9006")
		paint(a, da)
		emit(shown(a))
	`,
		{ before: ELLESMERE },
	);
	assert.deepEqual(reg, { names: 'Polestar' });
	assert.deepEqual(verdicts, [true, false, false]);
	assert.deepEqual(look, { size: [20, 20], layer: 'OVERLAY', point: 'BOTTOMLEFT' });
	assert.equal(after, false, 'a better piece worn: the same slot is no upgrade');
});

test('EllesmereUI Bags: the link comes from the bag slot when the data has none; the setting and gear advice off take the arrow off', () => {
	const [fromSlot, off, disabled] = run(
		`${BAGS}
		local a, da = slot(nil, 0, 1)
		paint(a, da)
		emit(shown(a))
		Polestar.Set("gear.bagArrows", false)
		paint(a, da)
		emit(shown(a))
		Polestar.Set("gear.bagArrows", true)
		Polestar.Set("gear.enabled", false)
		paint(a, da)
		emit(shown(a))
	`,
		{ before: ELLESMERE },
	);
	assert.equal(fromSlot, true);
	assert.equal(off, false);
	assert.equal(disabled, false);
});

test('EllesmereUI Bags: new verdicts re-mark the shown slots from their last painted link, in combat too, without rebuilding its window', () => {
	const [out] = run(
		`${BAGS}
		local a, da = slot("item:9002", 0, 1)
		paint(a, da)
		local before = shown(a)
		g.equip(1, "item:9006")
		stub.advance(0.25)
		local better = shown(a)
		stub.inCombat = true
		g.equip(1, "item:9001")
		stub.advance(0.25)
		emit({ before = before, better = better, combat = shown(a), refreshes = EUI_Bags.refreshes })
	`,
		{ before: ELLESMERE },
	);
	assert.deepEqual(out, { before: true, better: false, combat: true, refreshes: 0 });
});

test('EllesmereUI Bags loaded after Polestar: the painter registers as it loads, once', () => {
	const [before, after] = run(`
		emit(EUI_Bags == nil)
		${ELLESMERE}
		stub.addonLoaded("EllesmereUIBags")
		stub.addonLoaded("EllesmereUIBags")
		emit(keys(EUI_Bags.itemOverlayIcons))
	`);
	assert.equal(before, true);
	assert.equal(after, 'Polestar');
});

test('Leave bag arrows to Pawn hides the bag arrows only while Pawn is installed', () => {
	const [off, withPawn, hidden, noPawn] = run(`${BAGS}
		emit(G.Bags.IsOn())
		C_AddOns = { IsAddOnLoaded = function(n) return n == "Pawn" end }
		Polestar.Set("gear.hideForPawn", true)
		emit(G.Bags.IsOn())
		Polestar.Set("gear.hideForPawn", false)
		emit(G.Bags.IsOn())
		C_AddOns = nil
		Polestar.Set("gear.hideForPawn", true)
		emit(G.Bags.IsOn())
	`);
	assert.equal(off, true);
	assert.equal(withPawn, false);
	assert.equal(hidden, true);
	assert.equal(noPawn, true);
});

test('EllesmereUI Bags: the arrow takes the new success colour when the look changes', () => {
	const [out] = run(
		`${BAGS}
		local a, da = slot("item:9002", 0, 1)
		paint(a, da)
		local r
		for _, x in ipairs(a._textOverlay.regions) do if x.texture then r = x end end
		Polestar.Set("ui.skin", "halo")
		local want = { T.Color("success") }
		local got = { r:GetVertexColor() }
		emit({ want = { want[1], want[2], want[3] }, got = { got[1], got[2], got[3] } })
	`,
		{ before: ELLESMERE },
	);
	assert.deepEqual(out.got, out.want);
});
