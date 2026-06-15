// Reddit story-picker: turns a Bright & Early edition into ready-to-post Reddit
// submissions — each story matched to the subreddits it fits, with a title and
// both links (the original source and the branded /s/ page). For growth/outreach;
// run by hand, copy the picks you like, and post 1–3 a day (not all at once).
//
// Usage:
//   node scripts/reddit-picker.mjs            # today's edition (latest.json)
//   node scripts/reddit-picker.mjs 2026-06-08 # a specific archived edition

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SITE } from "./lib/pages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Default subreddits per section. r/UpliftingNews is the broad home for almost
// everything; the rest are topical. (Always check each sub's rules before posting.)
const SECTION_SUBS = {
  "Global Wins": ["r/UpliftingNews", "r/GoodNews"],
  "Fair Play & Triumphs": ["r/UpliftingNews", "r/sports"],
  "Future Proof": ["r/UpliftingNews", "r/Futurology", "r/technology"],
  "Kind Humans": ["r/HumansBeingBros", "r/MadeMeSmile", "r/UpliftingNews"],
  "Earth Restored": ["r/UpliftingNews", "r/conservation", "r/environment"],
};

// Keyword refinements — add niche subs when the headline/summary matches.
const KEYWORD_SUBS = [
  { re: /\b(dog|puppy|cat|kitten|pet|animal|wildlife|species|elephant|whale|bird|rhino|tiger|lion)\b/i, subs: ["r/Awwducational", "r/likeus"] },
  { re: /\b(dog|puppy|cat|kitten|rescue pet)\b/i, subs: ["r/aww", "r/AnimalsBeingBros"] },
  { re: /\b(space|nasa|rocket|astronaut|mars|moon|satellite|telescope)\b/i, subs: ["r/space"] },
  { re: /\b(cancer|treatment|trial|vaccine|gene|therapy|disease|patients?|medical|drug)\b/i, subs: ["r/science", "r/medicine"] },
  { re: /\b(solar|wind|clean energy|renewable|battery|climate|emissions)\b/i, subs: ["r/RenewableEnergy"] },
  { re: /\b(ocean|reef|coral|marine|river|wetland|forest|reforest)\b/i, subs: ["r/conservation", "r/marineconservation"] },
  { re: /\b(teacher|student|school|kid|child|teen|young)\b/i, subs: ["r/HumansBeingBros"] },
  { re: /\b(soccer|football|cricket|tennis|hockey|baseball|basketball|olympic)\b/i, subs: ["r/sports"] },
];

export function subsFor(story) {
  const text = `${story.headline} ${story.summary || ""}`;
  const subs = [...(SECTION_SUBS[story.section] || ["r/UpliftingNews"])];
  for (const { re, subs: extra } of KEYWORD_SUBS) {
    if (re.test(text)) subs.push(...extra);
  }
  return [...new Set(subs)].slice(0, 4);
}

async function main() {
  const arg = process.argv[2];
  const file = arg ? join(ROOT, "public", "data", "editions", `${arg}.json`) : join(ROOT, "public", "data", "latest.json");
  const ed = JSON.parse(await readFile(file, "utf8"));
  if (!ed.stories?.length) {
    console.log("(empty edition — nothing to post)");
    return;
  }

  // Best bets first: warmest, broadest-appeal stories to lead with today.
  const ranked = [...ed.stories].sort((a, b) => (b.positivity || 0) - (a.positivity || 0));

  console.log(`\n📋 Reddit picks for the ${ed.date} edition (${ed.storyCount} stories)`);
  console.log(`   Post 1–3 of these today, spaced out. Use the SOURCE link for strict`);
  console.log(`   news subs (r/UpliftingNews etc.); the /s/ link drives traffic to the site.\n`);

  ranked.forEach((s, i) => {
    const flag = i < 3 ? "⭐ BEST BET  " : "            ";
    console.log(`${flag}[${s.section}]`);
    console.log(`  Title:  ${s.headline}`);
    console.log(`  Subs:   ${subsFor(s).join("  ")}`);
    console.log(`  Source: ${s.url}`);
    console.log(`  /s/:    ${SITE}/s/${s.id}.html`);
    console.log("");
  });

  console.log(`💡 Tips: match each sub's title rules (some require the article's real`);
  console.log(`   title, no editorializing). Don't blast all at once — Reddit flags that`);
  console.log(`   as spam. If a sub bans self-promo, post the SOURCE and mention Bright &`);
  console.log(`   Early only if asked.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Reddit picker failed:", err.message);
    process.exit(1);
  });
}
