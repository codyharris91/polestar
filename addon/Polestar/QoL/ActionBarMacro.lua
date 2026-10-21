-- An explicitly created character macro for the current step's targets.
-- A slot is not an identity: every operation finds the unique saved name
-- and exact last verified body again. Player edits always end ownership.
local ADDON, ns = ...
local QoL, L = ns.QoL, ns.L
local Macro = {}
QoL.ActionBarMacro = Macro

local NAME, EMPTY, LIMIT = "Polestar Target", "# Polestar: no active target", 255
local writing, hookedEditor, rejected = false, nil, nil
local function bounds()
	local c = Constants and Constants.MacroConsts
	local account, character = c and c.MAX_ACCOUNT_MACROS, c and c.MAX_CHARACTER_MACROS
	if type(account) == "number" and account > 0 and account == math.floor(account)
		and type(character) == "number" and character > 0 and character == math.floor(character) then
		return account, character
	end
end

function Macro.Supported()
	local account = bounds()
	local B = QoL.Buttons
	return account ~= nil and type(GetNumMacros) == "function" and type(GetMacroInfo) == "function"
		and type(CreateMacro) == "function" and type(EditMacro) == "function" and type(PickupMacro) == "function"
		and type(GetCursorInfo) == "function" and type(InCombatLockdown) == "function"
		and B ~= nil and type(B.TargetNames) == "function" and type(B.TargetMacro) == "function" and type(B.MarkLine) == "function"
end

local function state()
	return QoL.State().actionBarMacro
end

local function forget(message)
	if state() ~= nil then
		QoL.State().actionBarMacro = nil
		ns.Print(message)
	end
	return false
end

-- Scan all character slots, including holes. On creation also check account
-- names, so an existing player macro is never adopted or shadowed.
local function find(name, includeAccount)
	local account, character = bounds()
	local index, body, count = nil, nil, 0
	for i = includeAccount and 1 or account + 1, account + character do
		local ok, n, _, text = pcall(GetMacroInfo, i)
		if not ok then return nil, nil, nil end
		if n == name then index, body, count = i, text, count + 1 end
	end
	return index, body, count
end

local function owned(s)
	if type(s) ~= "table" or s.name ~= NAME or type(s.body) ~= "string" then
		forget(L["Polestar Target updates stopped because its saved ownership could not be verified."])
		return nil
	end
	local index, body, count = find(s.name)
	if count ~= 1 or body ~= s.body then
		forget(L["Polestar Target was edited, renamed, deleted or duplicated. Automatic updates have stopped; your macros were left unchanged."])
		return nil
	end
	return index
end

function Macro.IsManaged()
	if writing then return false end
	local s = state()
	return s ~= nil and Macro.Supported() and owned(s) ~= nil
end

local function desired()
	local B = QoL.Buttons
	local view, raw = QoL.CurrentStep()
	local names = B.TargetNames(view, raw)
	if #names == 0 then return nil, "empty" end
	local body = B.TargetMacro(names, 1, B.MarkLine("mob"))
	if type(body) ~= "string" or body == "" or #body > LIMIT then return nil, "invalid" end
	return body
end

local function editorOpen()
	local f = MacroFrame
	if f and f ~= hookedEditor and type(f.HookScript) == "function" then
		hookedEditor = f
		f:HookScript("OnHide", function() Macro.Refresh() end)
	end
	return f and f:IsShown()
end

-- UPDATE_MACROS fires synchronously inside Create/Edit. Ignore those own
-- events until the exact readback is checked and ownership is updated.
local function write(index, body)
	writing = true
	local ok, result
	if index then
		ok, result = pcall(EditMacro, index, nil, nil, body)
	else
		ok, result = pcall(CreateMacro, NAME, 134400, body, true)
	end
	local account, character = bounds()
	local verified = ok and type(result) == "number" and result > account and result <= account + character
	if verified then
		local found, actual, count = find(NAME)
		verified = count == 1 and found == result and actual == body
	end
	if verified then
		QoL.State().actionBarMacro = { name = NAME, body = body, enabled = true }
	else
		QoL.State().actionBarMacro = nil
	end
	writing = false
	if not verified then
		ns.Print(L["Polestar Target could not be saved and verified. Automatic updates are off; check your character macros before trying again."])
		return nil
	end
	return result
end

local function sync()
	if writing or not Macro.Supported() or not state() or editorOpen() then return end
	local s = state()
	local index = owned(s)
	if not index or not s.enabled then return end
	local body, reason = desired()
	if reason == "invalid" and rejected ~= reason then
		ns.Print(L["The current targets do not fit in Polestar Target. Its action is cleared until a valid target list is available."])
	end
	rejected = reason
	body = body or EMPTY
	if body ~= s.body then write(index, body) end
end

local refreshSoon = QoL.Coalesce(function()
	if state() then QoL.Secure("actionBarMacro", sync) end
end)

function Macro.Refresh()
	if not writing and ns.IsLoggedIn() and state() then refreshSoon() end
end

function Macro.Place()
	if writing then return false end
	if not Macro.Supported() then
		ns.Print(L["This client does not support creating an action-bar target macro."])
		return false
	end
	if QoL.InLockdown() then
		ns.Print(L["Place Polestar Target after combat ends."])
		return false
	end
	if editorOpen() then
		ns.Print(L["Close the macro editor before placing Polestar Target."])
		return false
	end
	local ok, cursor = pcall(GetCursorInfo)
	if not ok or cursor ~= nil then
		ns.Print(L["Clear your cursor before placing Polestar Target."])
		return false
	end
	local s, index = state(), nil
	if s then
		index = owned(s)
		if not index then return false end
	else
		local _, _, count = find(NAME, true)
		if count == nil or count > 0 then
			ns.Print(L["A macro named Polestar Target already exists, or your macro list could not be read. Rename that macro before creating one with Polestar."])
			return false
		end
		local _, character = bounds()
		local read, _, used = pcall(GetNumMacros)
		if not read or type(used) ~= "number" or used >= character then
			ns.Print(L["There is no free character macro slot for Polestar Target."])
			return false
		end
	end
	local body, reason = desired()
	if not body then
		ns.Print(reason == "empty" and L["The current step has no active targets for Polestar Target."]
			or L["The current targets do not fit in a character macro. Polestar Target was not placed."])
		return false
	end
	if not s or s.body ~= body then
		index = write(index, body)
		if not index then return false end
	else
		s.enabled = true
	end
	-- Scan again: another addon can reorder slots while handling the write.
	index = owned(state())
	if not index then return false end
	-- The write's synchronous event handlers may also have picked something
	-- up. Never replace that cursor payload with this macro.
	ok, cursor = pcall(GetCursorInfo)
	if not ok or cursor ~= nil then
		ns.Print(L["Polestar Target was saved, but your cursor is occupied. Find it in your character macros."])
		return false
	end
	local picked = pcall(PickupMacro, index)
	local read, cursorType, cursorIndex = pcall(GetCursorInfo)
	if not picked or not read or cursorType ~= "macro" or cursorIndex ~= index then
		ns.Print(L["Polestar Target was saved, but could not be picked up. Find it in your character macros."])
		return false
	end
	ns.Print(L["Place Polestar Target on an action bar. It will follow the current step until you stop updates or edit the macro."])
	return true
end

function Macro.Stop()
	local s = state()
	if type(s) ~= "table" then return false end
	if s.enabled then
		s.enabled = false
		ns.Print(L["Polestar Target updates stopped. The macro and its current action were kept."])
	end
	return true
end

QoL.OnStep(Macro.Refresh)
ns.RegisterEvent("QUEST_LOG_UPDATE", Macro.Refresh)
ns.RegisterEvent("UPDATE_MACROS", Macro.Refresh)
ns.On("QUESTDB_LOADED", Macro.Refresh)
ns.On("SETTING_CHANGED", function(path)
	if path == "" or path == "qol" or path == "qol.markTarget" or path == "qol.markMob" or path == "qol.markNpc" then
		Macro.Refresh()
	end
end)
ns.RegisterEvent("ADDON_LOADED", function(_, name)
	if name == "Blizzard_MacroUI" then editorOpen(); Macro.Refresh() end
end)
ns.OnLogin(function() editorOpen(); Macro.Refresh() end)
