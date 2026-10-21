'use strict';
// credits: rewrites addon/Polestar/Core/Credits.lua (the Guiding Stars page).

const usage = `usage: node tools/polestar.js credits

Rewrites addon/Polestar/Core/Credits.lua, the names on the Guiding Stars
page (Options > Guiding Stars, and "Special thanks to" in the windows'
headers):

  supporters    tools/lib/credits.json "supporters": Ko-fi supporters' names,
                highest total first. Amounts are never stored.
  contributors  everyone with a merged pull request on fitzforge/polestar,
                most first, fetched with the GitHub CLI (gh, logged in).
                "exclude" lists logins left out (the maintainer); "names"
                maps a login to the name shown.

Run it before a release.`;

async function run(argv) {
	if (argv.length) {
		console.error(`credits takes no arguments\n\n${usage}`);
		return 2;
	}
	const r = require('../lib/credits').write();
	console.log(`credits: ${r.supporters} supporters, ${r.contributors} contributors -> ${r.out}`);
	return 0;
}

module.exports = { name: 'credits', summary: 'Rewrite the Guiding Stars page\'s names (Core/Credits.lua) from credits.json and GitHub', usage, run };
