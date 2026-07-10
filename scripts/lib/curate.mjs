// The editorial brain: an LLM reads the prefiltered candidates and selects the
// genuinely uplifting ones, writes a warm one-line summary and a fresh headline,
// and files each into a section. This is the "curation" half of the hybrid.
//
// Provider: OpenRouter (https://openrouter.ai) — an OpenAI-compatible gateway,
// so this is a plain chat-completions call. Pick any model via OPENROUTER_MODEL
// (it can route to Claude, GPT, Llama, etc.). We ask for strict JSON in the
// prompt and parse defensively, so it works across models regardless of whether
// a given one supports a structured-output mode.
//
// If OPENROUTER_API_KEY is absent, callers fall back to the local ranking — this
// module is only invoked when a key is present.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini"; // override with OPENROUTER_MODEL

export const SECTIONS = [
  "Global Wins",
  "Fair Play & Triumphs",
  "Future Proof",
  "Kind Humans",
  "Earth Restored",
];

// What belongs on each page — keeps the model filing accurately despite the
// evocative (non-literal) section names.
const SECTION_GUIDE = `- Global Wins — THE FRONT PAGE. Put the 4–5 most heart-warming AND significant stories of the day here, pulled from ANY domain — the ones you'd most want a friend to wake up to. Lead with WARMTH, not mere magnitude (a moving human triumph beats a dry statistic, even a big one). A story on the front page does NOT also appear in its topical section below.
- Fair Play & Triumphs — sport as uplift: incredible comebacks, sportsmanship between rivals, underdogs defying the odds, athletes giving back to their communities, fan-driven good.
- Future Proof — human ingenuity solving real problems: medical milestones and new treatments, clean-energy and engineering advances, science and space breakthroughs.
- Kind Humans — grassroots kindness and community: local heroes, random acts of kindness, neighbours helping neighbours, towns and families lifted up.
- Earth Restored — conservation and wildlife wins: endangered species recovering, reforestation, oceans and habitats protected, successful clean-ups.`;

const SYSTEM = `You are the editor of "Bright & Early", a beloved morning newspaper of genuinely HEART-WARMING news. Apply one test to every story: would a tired person, reading it with their morning coffee, actually SMILE? Not just nod and think "that's good for the world" — but feel a real little lift of warmth or delight. If it only informs, it does not belong.

WHAT EARNS A PLACE (roughly in priority):
- Human warmth: acts of kindness and generosity, strangers helping strangers, communities rallying around someone, reunions, a person's hard-won personal triumph or comeback.
- Animals & wildlife: rescues, recoveries, charming or moving moments, species bouncing back.
- Wonder & delight: a discovery, feat, or first that makes you grin or go "wow".
- Genuine hope: a life saved, a real recovery, an against-the-odds win.

REJECT (even when technically "positive"):
- Dry progress, policy, rankings or statistics that inform but don't warm ("X overtakes Y", "Z% improvement", reports, studies, forecasts) — UNLESS there's a genuinely moving human story at its heart.
- Press releases and corporate/PR/marketing items (e.g. PR Newswire, product launches, funding rounds, company announcements).
- Round-ups and listicles ("what went right this week", "weekly good news roundup"), "good news in history" filler, horoscopes, and meta articles about good news itself.
- Anything dark, tragic, fear-driven, politically inflammatory, or only superficially positive.
- Clickbait, or any headline you can't trust to actually be positive.

WRITING:
- For each story write a warm, human one-line summary (max ~30 words) and a clean, dignified headline. Lead with the people and the feeling, not the number.

FILING — put each story in exactly one of these sections, using the EXACT name:
${SECTION_GUIDE}
- Aim for about 4–5 stories per section (a warm lead plus a few more), max 6. Fill Global Wins first, then distribute the rest.
- NO DUPLICATES — critical. Never select the same story twice, and never two stories about the same underlying event even from different outlets or with different headlines. Pick the single best version. Each candidate id appears at most once, in exactly one section.
- Quality over quantity: a SHORT edition where every story makes someone smile beats a padded one. If only 2–3 stories in a section clear the smile test, that's perfectly fine — leave it short rather than pad with dry filler.
- Order matters: within each section put the single most heart-warming story first — it becomes that page's lead.

Respond with ONLY a JSON object, no prose and no markdown fences, in exactly this shape:
{"stories":[{"id":"<candidate id>","headline":"...","summary":"...","section":"<one of the sections>","positivity":0.0}]}
positivity is the SMILE SCORE from 0 to 1 — how much the story would make a reader smile (be honest; reserve above 0.8 for genuinely delightful, heart-warming stories). Prefer higher-smile stories. Use the exact id from each candidate you select.`;

// POST to OpenRouter with a hard request timeout and a couple of retries, so a
// stalled connection can never wedge the whole build (it can't — an aborted
// request throws and we retry, then fail fast to the caller). Mirrors the
// timeout guard already used in sources/websearch.mjs. Returns the message text.
async function postOpenRouter(key, body, { timeoutMs = 120000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // Optional attribution headers OpenRouter uses for its dashboards.
          "HTTP-Referer": "https://github.com/sriramr90/bright-and-early",
          "X-Title": "Bright & Early",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter returned no content");
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt <= retries) {
        const why = err?.name === "AbortError" ? `timed out after ${timeoutMs / 1000}s` : err.message;
        console.warn(`  ! OpenRouter ${why} (attempt ${attempt}/${retries + 1}); retrying…`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function curate(candidates) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  const catalogue = candidates
    .map((c) => `id: ${c.id}\ntitle: ${c.title}\nsource: ${c.source}\ntopic hint: ${c.section || "?"}\nblurb: ${c.description || "(none)"}`)
    .join("\n\n");

  const content = await postOpenRouter(key, {
    model,
    max_tokens: 16000,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Here are today's candidate stories from across the world. Curate tomorrow morning's edition.\n\n${catalogue}`,
      },
    ],
  });

  const parsed = parseJson(content);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // Safety net: even with the no-duplicates instruction, never let the same
  // candidate (by id or by url) appear twice in the finished edition.
  const seenIds = new Set();
  const seenUrls = new Set();

  // Join the editor's picks back to the original candidate metadata (url, image…).
  return (parsed.stories || [])
    .map((pick) => {
      const original = byId.get(pick.id);
      if (!original) return null;
      if (seenIds.has(pick.id) || seenUrls.has(original.url)) return null;
      seenIds.add(pick.id);
      seenUrls.add(original.url);
      return {
        headline: pick.headline || original.title,
        summary: pick.summary || original.description,
        section: SECTIONS.includes(pick.section) ? pick.section : SECTIONS[0],
        positivity: typeof pick.positivity === "number" ? pick.positivity : 0.5,
        url: original.url,
        image: original.image,
        source: original.source,
        publishedAt: original.publishedAt,
        _text: original._text, // carry body text forward so resummarize() can use it
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.positivity - a.positivity);
}

// Lever B, pass 2: the editor has already chosen the stories from their blurbs.
// Now that we've fetched each chosen article's real body text (`_text`), have the
// model rewrite the one-line summary so it carries a SPECIFIC, smile-worthy detail
// — a name, a number, a vivid fact — instead of the thin RSS blurb. Only stories
// that actually gained body text are sent; the rest keep their pass-1 summary.
const RESUMMARIZE_SYSTEM = `You are the editor of "Bright & Early", a morning newspaper of genuinely heart-warming news. For each story you'll get its headline, your current one-line summary, and an excerpt of the real article. Rewrite the summary so it carries ONE specific, concrete, smile-worthy detail drawn from the article — a person's name, a number, a vivid fact — while staying warm and human. Keep it to a single sentence, max ~30 words, leading with the people and the feeling, not the number. Do NOT invent anything: use only facts present in the excerpt. If the excerpt adds nothing worth including, return the summary unchanged.

Respond with ONLY a JSON object, no prose and no markdown fences, in exactly this shape:
{"stories":[{"id":"<id>","summary":"..."}]}`;

export async function resummarize(stories) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return stories;
  const enriched = stories.filter((s) => s._text && s.id);
  if (!enriched.length) return stories;
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  const catalogue = enriched
    .map((s) => `id: ${s.id}\nheadline: ${s.headline}\ncurrent summary: ${s.summary || "(none)"}\narticle excerpt: ${s._text}`)
    .join("\n\n");

  const content = await postOpenRouter(key, {
    model,
    max_tokens: 8000,
    messages: [
      { role: "system", content: RESUMMARIZE_SYSTEM },
      { role: "user", content: `Rewrite each summary with a specific detail from its article.\n\n${catalogue}` },
    ],
  }, { timeoutMs: 90000 });

  const parsed = parseJson(content);
  const byId = new Map((parsed.stories || []).map((p) => [p.id, p.summary]));
  return stories.map((s) => {
    const better = byId.get(s.id);
    return better && better.trim() ? { ...s, summary: better.trim() } : s;
  });
}

// Tolerant JSON extraction: strip markdown fences, take the outermost {...},
// and—if that still fails (e.g. the model's array got truncated mid-stream)—
// salvage every complete story object we can find so a near-miss isn't a total
// loss that drops us back to the local ranking.
export function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  const core = start !== -1 && end !== -1 ? t.slice(start, end + 1) : t;

  try {
    return JSON.parse(core);
  } catch {
    // Salvage: story objects are flat (no nested braces), so grab each one.
    const stories = [];
    const re = /\{[^{}]*\}/g;
    let m;
    while ((m = re.exec(t))) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && obj.id) stories.push(obj);
      } catch {
        /* skip a partial/garbled object */
      }
    }
    if (stories.length) return { stories };
    throw new Error("could not parse model JSON");
  }
}
