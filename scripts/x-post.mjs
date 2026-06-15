// Composes a ready-to-paste X (Twitter) post from the morning's edition and
// (optionally) sends it to you on Telegram so you can post it by hand. Runs in
// the daily GitHub Action on the schedule, after the edition is built.
//
// Delivery: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to receive it on Telegram;
// with no env it just prints the post (handy for local previews / testing).

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, randomBytes } from "node:crypto";
import { SITE } from "./lib/pages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX = 280;
const HANDLE = "@brightearlynews";
const HASHTAGS = "#GoodNews #UpliftingNews #Positivity #Hope #GoodVibes";

const prettyDate = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" });

// Build a single post under the 280-char limit. We lead with 1–2 of the warmest
// headlines as teasers, then the link. Headlines are trimmed to fit, never the link.
export function buildPost(edition) {
  const order = edition.sections || [];
  // Prefer Global Wins (front-page) stories, then fall back to edition order.
  const ranked = [...edition.stories].sort((a, b) => {
    const ga = a.section === order[0] ? 0 : 1;
    const gb = b.section === order[0] ? 0 : 1;
    return ga - gb || (b.positivity || 0) - (a.positivity || 0);
  });

  const link = `${SITE}`;
  const head = `🌅 Good news from ${prettyDate(edition.date)} —`;
  const tail = `${edition.storyCount} stories to start your day with a smile:\n${link}\n\n${HASHTAGS} ${HANDLE}`;

  // Fit as many teaser headlines as the budget allows (each on its own • line).
  const budget = MAX - head.length - tail.length - 4; // padding for newlines
  const teasers = [];
  let used = 0;
  for (const s of ranked) {
    let h = s.headline.replace(/\s+/g, " ").trim();
    const line = `\n• ${h}`;
    if (used + line.length > budget) {
      // Try a trimmed version of this headline if at least one teaser exists.
      if (teasers.length) break;
      h = h.slice(0, Math.max(0, budget - 4)).replace(/\s+\S*$/, "") + "…";
    }
    const finalLine = `\n• ${h}`;
    if (used + finalLine.length > budget && teasers.length) break;
    teasers.push(h);
    used += finalLine.length;
    if (teasers.length >= 2) break;
  }

  const post = `${head}${teasers.map((t) => `\n• ${t}`).join("")}\n\n${tail}`;
  return post.length <= MAX ? post : post.slice(0, MAX - 1) + "…";
}

async function sendTelegram(post, edition) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("  (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — printing post only)\n");
    console.log(post);
    return;
  }
  // Send the post wrapped in a code block: on mobile Telegram, tapping it copies
  // the exact text. Inside ```...``` only backslash and backtick need escaping.
  const fenced = "```\n" + post.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "\n```";
  const text = `🐦 *X post for ${prettyDate(edition.date)}* \\(${post.length}/280 — tap to copy\\):\n\n${fenced}`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Telegram ${res.status}: ${detail.slice(0, 300)}`);
  }
  console.log(`  🐦 Sent today's X post to Telegram (${post.length}/280 chars)`);
}

// --- Auto-post to X (Twitter) via OAuth 1.0a user context ----------------------
// No SDK: we sign the request ourselves. Note that for v2 JSON-body endpoints the
// JSON body is NOT part of the OAuth signature base string — only the oauth_* params.

const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function postToX(post) {
  const ck = process.env.X_API_KEY;
  const cs = process.env.X_API_SECRET;
  const tok = process.env.X_ACCESS_TOKEN;
  const ts = process.env.X_ACCESS_TOKEN_SECRET;
  if (!ck || !cs || !tok || !ts) {
    console.log("  (no X_* keys — skipping X auto-post)");
    return;
  }
  const url = "https://api.twitter.com/2/tweets";
  const oauth = {
    oauth_consumer_key: ck,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: tok,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(oauth).sort().map((k) => `${pct(k)}=${pct(oauth[k])}`).join("&");
  const base = ["POST", pct(url), pct(paramStr)].join("&");
  const signingKey = `${pct(cs)}&${pct(ts)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const auth = "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text: post }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  console.log(`  🐦 Posted to X: https://x.com/brightearlynews/status/${data?.data?.id}`);
}

async function main() {
  const edition = JSON.parse(await readFile(join(ROOT, "public", "data", "latest.json"), "utf8"));
  if (!edition.stories?.length) {
    console.log("  (empty edition — skipping X post)");
    return;
  }
  const post = buildPost(edition);

  // Each channel is independent — one failing shouldn't block the other.
  let failed = false;
  for (const send of [sendTelegram, postToX]) {
    try {
      await send(post, edition);
    } catch (err) {
      failed = true;
      console.error(`  ! ${send.name} failed: ${err.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

// Only run when invoked directly (so other scripts can import buildPost).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("X post failed:", err.message);
    process.exit(1);
  });
}
