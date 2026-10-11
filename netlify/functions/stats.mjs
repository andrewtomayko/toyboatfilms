// Privacy-friendly visitor stats for toyboatfilms.com.
//
// POST (public):  the site sends small anonymous events. No cookies, no IP addresses stored.
//   { t: "pv", src, dev }        a visit (src = referring site or utm source, dev = phone|tablet|desktop)
//   { t: "vo", v }               a video popup opened (v = video slug)
//   { t: "vt", v, s }            seconds the video popup stayed open
//   { t: "cf" } / { t: "cs" }    contact form opened / inquiry sent
// Visitors are counted once per day with a hash of IP + browser + a random salt that changes daily
// and is thrown away, so nobody can be recognized across days.
//
// GET ?days=7|30|90 (Netlify login required): daily summaries for the /stats page.
//
// Storage (Netlify Blobs): raw events under ev/<date>/..., rolled up into day/<date> once a day is over.

import { createHash, randomUUID } from "node:crypto";
import { connectLambda, getStore } from "@netlify/blobs";

const PRODUCTION_HOSTS = new Set(["toyboatfilms.com", "www.toyboatfilms.com"]);
const BOTS = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor|curl|wget|python/i;
const SLUG = /^[a-z0-9-]{1,120}$/;
const SOURCE = /^[a-z0-9.\-]{1,80}$/;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: body === undefined ? "" : JSON.stringify(body),
});

const header = (event, name) => {
  const h = event.headers || {};
  return String(h[name] || h[name.toLowerCase()] || "");
};

const dayOf = (date) => date.toISOString().slice(0, 10); // UTC day

function emptyDay() {
  return { visits: 0, sources: {}, devices: {}, countries: {}, videos: {}, contactOpens: 0, inquiries: 0 };
}

function addEvents(sum, events) {
  const visitors = new Set(sum._visitors || []);
  const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };
  for (const e of events) {
    if (e.t === "pv") {
      if (visitors.has(e.vid)) continue; // one visit per visitor per day
      visitors.add(e.vid);
      sum.visits++;
      bump(sum.sources, e.src || "direct");
      bump(sum.devices, e.dev || "desktop");
      if (e.c) bump(sum.countries, e.c);
    } else if (e.t === "vo" || e.t === "vt") {
      const v = (sum.videos[e.v] ||= { opens: 0, secs: 0 });
      if (e.t === "vo") v.opens++; else v.secs += e.s;
    } else if (e.t === "cf") sum.contactOpens++;
    else if (e.t === "cs") sum.inquiries++;
  }
  sum._visitors = [...visitors];
  return sum;
}

async function rawEvents(store, day) {
  const { blobs } = await store.list({ prefix: `ev/${day}/` });
  const events = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return { keys: blobs.map((b) => b.key), events: events.filter(Boolean) };
}

// Finished days are summarized once and their raw events deleted; today is summarized live.
async function daySummary(store, day, today) {
  if (day === today) {
    const { events } = await rawEvents(store, day);
    const s = addEvents(emptyDay(), events);
    delete s._visitors;
    return s;
  }
  const saved = await store.get(`day/${day}`, { type: "json" });
  if (saved) return saved;
  const { keys, events } = await rawEvents(store, day);
  const s = addEvents(emptyDay(), events);
  delete s._visitors;
  await store.setJSON(`day/${day}`, s);
  await Promise.all([...keys, `salt/${day}`].map((k) => store.delete(k)));
  return s;
}

async function dailySalt(store, day) {
  let salt = await store.get(`salt/${day}`);
  if (!salt) {
    salt = randomUUID();
    await store.set(`salt/${day}`, salt);
  }
  return salt;
}

export const handler = async (event, context) => {
  connectLambda(event);
  const host = header(event, "host").toLowerCase();
  const store = getStore(PRODUCTION_HOSTS.has(host) ? "stats" : "stats-preview");
  const now = new Date();
  const today = dayOf(now);

  // ----- collect -----
  if (event.httpMethod === "POST") {
    const ua = header(event, "user-agent");
    if (!ua || BOTS.test(ua)) return reply(204);
    let e;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
      if (raw.length > 2000) return reply(204);
      e = JSON.parse(raw);
    } catch { return reply(204); }

    const rec = { t: e && e.t };
    if (rec.t === "pv") {
      rec.src = SOURCE.test(String(e.src || "")) ? e.src : "direct";
      rec.dev = ["phone", "tablet", "desktop"].includes(e.dev) ? e.dev : "desktop";
      const country = header(event, "x-country").toUpperCase();
      if (/^[A-Z]{2}$/.test(country)) rec.c = country;
    } else if (rec.t === "vo" || rec.t === "vt") {
      if (!SLUG.test(String(e.v || ""))) return reply(204);
      rec.v = e.v;
      if (rec.t === "vt") {
        rec.s = Math.round(Number(e.s));
        if (!(rec.s >= 1 && rec.s <= 3600)) return reply(204);
      }
    } else if (rec.t !== "cf" && rec.t !== "cs") {
      return reply(204);
    }

    const ip = header(event, "x-nf-client-connection-ip") || header(event, "x-forwarded-for").split(",")[0].trim();
    const salt = await dailySalt(store, today);
    rec.vid = createHash("sha256").update(`${salt}|${ip}|${ua}`).digest("hex").slice(0, 16);
    await store.setJSON(`ev/${today}/${now.getTime()}-${randomUUID().slice(0, 8)}`, rec);
    return reply(204);
  }

  // ----- report (login required) -----
  if (event.httpMethod === "GET") {
    const user = context.clientContext && context.clientContext.user;
    if (!user) return reply(401, { error: "Please log in." });
    const allowed = (process.env.INVOICES_ALLOWED_EMAILS || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(user.email || "").toLowerCase())) {
      return reply(403, { error: "This account can't view stats." });
    }

    const days = Math.min(365, Math.max(1, parseInt((event.queryStringParameters || {}).days, 10) || 30));
    const dates = [];
    for (let i = days - 1; i >= 0; i--) dates.push(dayOf(new Date(now.getTime() - i * 86400000)));
    try {
      const summaries = await Promise.all(dates.map((d) => daySummary(store, d, today)));
      return reply(200, { days: dates.map((date, i) => ({ date, ...summaries[i] })) });
    } catch (err) {
      console.error(err);
      return reply(500, { error: "Stats could not be loaded." });
    }
  }

  return reply(405, { error: "Method not allowed." });
};
