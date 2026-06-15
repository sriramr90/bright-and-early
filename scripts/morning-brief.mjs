// Your 5-minute morning posting brief. Pulls today's live edition, then:
//   • copies the ready X post to your clipboard (just paste into X)
//   • lists the best 1–3 Reddit communities + titles to post by hand
//   • writes the whole thing to a file and opens it (macOS)
//   • pops a notification
//
// Designed to be fired by a launchd job at 8:55am (see install-morning-brief.sh).
// Your own r/BrightAndEarly is auto-posted separately, so this is just the manual
// high-reach stuff. Run any time: `node scripts/morning-brief.mjs`.

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { buildPost } from "./x-post.mjs";
import { subsFor } from "./reddit-picker.mjs";
import { SITE } from "./lib/pages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIEF_FILE = join(homedir(), "bright-and-early-brief.txt");
const prettyDate = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

// Prefer the live edition; fall back to the local file if offline.
async function loadEdition() {
  try {
    const res = await fetch(`${SITE}/data/latest.json?cb=${Math.floor(Date.now() / 1000)}`);
    if (res.ok) return await res.json();
  } catch {}
  return JSON.parse(await readFile(join(ROOT, "public", "data", "latest.json"), "utf8"));
}

function buildBrief(edition, xPost) {
  const ranked = [...edition.stories].sort((a, b) => (b.positivity || 0) - (a.positivity || 0));
  const picks = ranked.slice(0, 3).map((s, i) => {
    const subs = subsFor(s).join("  ");
    return `  ${i + 1}. ${s.headline}\n     → post to: ${subs}\n     link: ${s.url}`;
  });
  return [
    `☀️  BRIGHT & EARLY — MORNING BRIEF · ${prettyDate(edition.date)}`,
    `    (the X post below is already on your clipboard — just paste)`,
    ``,
    `━━━━━━━ X / TWITTER (@brightearlynews) ━━━━━━━`,
    xPost,
    ``,
    `━━━━━━━ REDDIT — post 1–3 by hand (5 min) ━━━━━━━`,
    `  Pick the strongest fit, use the title as-is or tweak, follow each sub's rules.`,
    ``,
    picks.join("\n\n"),
    ``,
    `  (Your own r/BrightAndEarly is auto-posted — nothing to do there.)`,
    `  More picks any time: node scripts/reddit-picker.mjs`,
    ``,
  ].join("\n");
}

// Pipe text into a command's stdin (e.g. pbcopy).
const pipeTo = (cmd, args, input) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args);
    p.on("error", resolve);
    p.on("close", resolve);
    p.stdin.end(input);
  });
const run = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args);
    p.on("error", resolve);
    p.on("close", resolve);
  });

async function main() {
  const edition = await loadEdition();
  if (!edition.stories?.length) {
    console.log("(no edition yet)");
    return;
  }
  const xPost = buildPost(edition);
  const brief = buildBrief(edition, xPost);

  console.log(brief);
  await writeFile(BRIEF_FILE, brief);

  if (process.platform === "darwin") {
    await pipeTo("pbcopy", [], xPost); // X post → clipboard
    await run("osascript", [
      "-e",
      `display notification "Tap to open · X post copied to clipboard" with title "☀️ Bright & Early — morning brief" sound name "Glass"`,
    ]);
    await run("open", [BRIEF_FILE]); // open the full brief
  }
}

main().catch((err) => {
  console.error("Morning brief failed:", err.message);
  process.exit(1);
});
