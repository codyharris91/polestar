-- Portuguese (Brazil) (ptBR): the guide forever/class/rogue/the-eye-of-bhossca (forever/class/rogue/the-eye-of-bhossca.guide).
-- Written by `node tools/polestar.js i18n guides sync ptBR`, which keeps every translation (docs/TRANSLATING.md, "Guide texts").
-- Translate the right-hand sides; "" shows the English. Keep each {kind:id} as it is: the game shows its
-- name there in Portuguese (Brazil) (the English is listed above the line). A name the English has in the plural, as words,
-- may be written with the singular's token from its "plural, as words" line: "Bandidos ({npc:251918})", "{npc:251918} ×8".
-- A token marked "no name in this language" would show in English: write that name in Portuguese (Brazil) words instead.
-- The comments are rewritten by sync.
return {
	-- Guide
	-- {item:277246} Ruby-Adorned Blade · {area:796} Scarlet Monastery
	["The {item:277246}, C's payment for a solo job inside the {area:796}."] = "A {item:277246}, o pagamento de C por um serviço solo dentro do {area:796}.",

	-- Step 1: C's dead drop
	["C's dead drop"] = "O ponto de entrega de C",
	-- {object:410369} Dead Drop · {area:204} Pyrewood Village · {area:236} Shadowfang Keep
	["The {object:410369} is a chest near {area:204} in southern Silverpine, just south of {area:236}. After the horn job and C's next letter, check it for the new job. The data lists a minimum of 25, but beta players report receiving the invitation at 30 after the horn job and a city visit; this is not a guaranteed mail level. If no new note is offered, continue leveling and check after C writes."] = "",

	-- Step 2: The Scarlet Monastery
	-- {area:796} Scarlet Monastery
	["The {area:796}"] = "{area:796}",
	-- {zone:1420} Tirisfal Glades · {npc:4293} Scarlet Scryer · {item:210963} Scryer's Key · {item:210968} Reliquary Key
	["The monastery stands in the far north-east of {zone:1420}. Go in alone. Before entering, find the disguise in the chest by the outside stables. Recheck it after changing wings: stealth and suspicious actions can remove it. In the Graveyard, pickpocket a {npc:4293} for the {item:210963}; use it on the Personal Letterbox in the Library and read the message. It sends you back to sit at both benches between the statues in the graveyard. Watch for the mechanism's messages, take the {item:210968} from the stone coffer, then return to the Library for the locked reliquary. Avoid fighting through the instance."] = "",
	["Solo route: Graveyard key, Library letter, Graveyard benches and coffer, then Library reliquary for the eye. Read the letter before the bench puzzle; check the disguise each time you change wings."] = "",

	-- Step 3: Back to the dead drop
	["Back to the dead drop"] = "De volta ao ponto de entrega",
	-- {object:410369} Dead Drop
	["Place the eye in the {object:410369} near Pyrewood. Check a capital mailbox for C's payment letter on your next planned city visit, then return here for the reward quest. The payment may not be available immediately; do not repeat the infiltration just because the reward has not appeared."] = "",

	-- No longer in the guide (its English changed or it went away): reuse or delete.
	-- ["Find the Eye of Bhossca inside the {area:796}."] = "Encontre o Olho de Bhossca dentro do {area:796}.",
	-- ["Place the eye in the {object:410369} near Pyrewood. C's payment is the second Eye of Bhossca quest at the same chest."] = "Coloque o olho no {object:410369} perto de Vilarejo Lenhardente. O pagamento de C é a segunda missão Olho de Bhossca, no mesmo baú.",
	-- ["The monastery stands in the far north-east of {zone:1420}. Go in alone; C advises a disguise from the monastery's grounds before you enter."] = "O monastério fica no extremo nordeste de {zone:1420}. Entre sozinho; C recomenda pegar um disfarce nos arredores do monastério antes de entrar.",
	-- ["The {object:410369} is a chest near {area:204} in southern Silverpine, just south of {area:236}. C's next note waits there once you are 25."] = "O {object:410369} é um baú perto de {area:204}, no sul da Floresta de Pinhaprata, logo ao sul de {area:236}. O próximo bilhete de C espera lá quando você tiver nível 25.",
}
