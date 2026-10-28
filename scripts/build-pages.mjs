// Builds the parts of the site search engines read, from the same data the editor saves.
// Netlify runs this on every deploy (see netlify.toml), so publishing from /admin updates everything:
//
//   /work/<slug>/index.html   a page for each film: title, details, location, description, credits
//   index.html                the homepage grid written into the HTML (the page script redraws it as before)
//   sitemap.xml               the homepage plus every film page
//
// The /work pages are generated, not kept in git. To see them locally: node scripts/build-pages.mjs --local
// (then `git checkout index.html sitemap.xml` before committing).
// Add --save-dates to refresh data/video-dates.json.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);
const ORIGIN = "https://toyboatfilms.com";
const LOCAL = process.argv.includes("--local"); // plain image links instead of Netlify's image resizing

const readJSON = async (p) => JSON.parse(await readFile(new URL(p, ROOT), "utf8"));
const { videos: rawVideos = [] } = await readJSON("data/videos.json");
const site = await readJSON("data/site.json");
const tagList = (site.tags || []).filter((t) => t && t.id && t.label);

/* ---------- Same rules as the homepage script ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const slugify = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function parseVideo(v) {
  let raw = String(v.url || v.id || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) {
    if (v.type === "youtube") return { kind: "youtube", id: raw };
    if (/^\d+$/.test(raw)) return { kind: "vimeo", id: raw };
    raw = "https://" + raw;
  }
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return { kind: "youtube", id: parts[0] };
  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const id = u.searchParams.get("v") || (["embed", "shorts", "live", "v"].includes(parts[0]) ? parts[1] : null);
    return id ? { kind: "youtube", id } : null;
  }
  if (host.endsWith("vimeo.com")) {
    const nums = parts.filter((p) => /^\d+$/.test(p));
    if (!nums.length) return null;
    const id = nums[0];
    const after = parts[parts.indexOf(id) + 1];
    const hash = u.searchParams.get("h") || (after && /^[0-9a-f]{6,}$/i.test(after) ? after : null);
    return { kind: "vimeo", id, hash };
  }
  return null;
}

function embedURL(p, autoplay) {
  if (p.kind === "youtube") {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.id)}?${autoplay ? "autoplay=1&" : ""}rel=0&modestbranding=1&playsinline=1`;
  }
  const h = p.hash ? `h=${encodeURIComponent(p.hash)}&` : "";
  return `https://player.vimeo.com/video/${encodeURIComponent(p.id)}?${h}${autoplay ? "autoplay=1&" : ""}title=0&byline=0&portrait=0&dnt=1`;
}

const detailsOf = (v) => (v.details || []).filter((d) => d && String(d.value ?? "").trim());
const thumbDetailOf = (v) => detailsOf(v).filter((d) => d.thumb).map((d) => d.value).join(" · ");
const CROPS = { Top: 0, Upper: 25, Center: 50, Lower: 75, Bottom: 100 };
function cropOf(v) {
  const n = Number(v.crop);
  if (v.crop !== "" && v.crop != null && Number.isFinite(n)) return Math.min(100, Math.max(0, n));
  return CROPS[v.crop] ?? 50;
}
function thumbAttrs(path, sizes = "(max-width: 800px) 100vw, 50vw") {
  if (!path) return "";
  if (LOCAL || !path.startsWith("/")) return `src="${esc(path)}"`;
  const cdn = (w) => `/.netlify/images?url=${encodeURIComponent(path)}&w=${w}&q=78`;
  const srcset = [640, 960, 1280, 1920].map((w) => `${cdn(w)} ${w}w`).join(", ");
  return `src="${cdn(1280)}" srcset="${srcset}" sizes="${sizes}" data-original="${esc(path)}"`;
}
const filtersOf = (v) => (v.tags || []).filter((id) => tagList.some((t) => t.id === id));
const inAll = (v) => !v.filterOnly || !filtersOf(v).length;

// Published videos with the same slugs the homepage uses for #video/... links
const seen = new Set();
const videos = rawVideos.filter((v) => v && (v.url || v.id) && !v.hidden).map((v, i) => {
  let slug = slugify(v.title) || "video-" + (i + 1);
  while (seen.has(slug)) slug += "-" + (i + 1);
  seen.add(slug);
  return { ...v, title: String(v.title || "").trim(), slug, parsed: parseVideo(v) };
});

/* ---------- Upload date and length (Google wants these for video results) ----------
   Looked up on every build. YouTube often turns away Netlify's servers, so the last known values are kept in
   data/video-dates.json (refresh it from a Mac with: node scripts/build-pages.mjs --local --save-dates). */
const DATES_FILE = new URL("data/video-dates.json", ROOT);
let savedDates = {};
try { savedDates = JSON.parse(await readFile(DATES_FILE, "utf8")); } catch {}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36";
await Promise.all(videos.map(async (v) => {
  if (v.parsed?.kind === "youtube") {
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(v.parsed.id)}&hl=en`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(8000) });
      const page = res.ok ? await res.text() : "";
      v.uploadDate = (page.match(/"(?:uploadDate|publishDate)":"(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
      v.duration = Number((page.match(/"lengthSeconds":"(\d+)"/) || [])[1]) || 0;
    } catch {}
    return;
  }
  if (v.parsed?.kind !== "vimeo") return;
  try {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(v.url)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const o = await res.json();
    v.uploadDate = String(o.upload_date || "").slice(0, 10);
    v.duration = Number(o.duration) || 0;
  } catch {}
}));
for (const v of videos) {
  const saved = savedDates[v.url] || {};
  v.uploadDate ||= saved.uploadDate || "";
  v.duration ||= saved.duration || 0;
}
if (process.argv.includes("--save-dates")) {
  const out = {};
  for (const v of videos) if (v.uploadDate) out[v.url] = { uploadDate: v.uploadDate, duration: v.duration };
  await writeFile(DATES_FILE, JSON.stringify(out, null, 2) + "\n");
}

/* ---------- Shared bits ---------- */
const abs = (path) => (/^https?:/.test(path) ? path : ORIGIN + path);
const pageURL = (v) => `${ORIGIN}/work/${v.slug}/`;
const andrewRole = (v) => (v.credits || []).find((c) => /tomayko/i.test(c.name || ""))?.role || "";
const tagsOf = (v) => filtersOf(v).map((id) => tagList.find((t) => t.id === id).label);
const isoDuration = (s) => `PT${Math.floor(s / 60)}M${Math.round(s % 60)}S`;
const ldJSON = (data) => JSON.stringify(data, null, 2).replace(/</g, "\\u003c");

function summary(v, max = 158) {
  const text = String(v.description || "").replace(/\s+/g, " ").trim();
  if (!text) {
    const role = andrewRole(v);
    return `${v.title}${thumbDetailOf(v) ? ` for ${thumbDetailOf(v)}` : ""}. ${role ? `${role}: ` : "A film by "}Andrew Tomayko, Toy Boat Films${v.location ? `. ${v.location}` : ""}.`;
  }
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s—–-]+$/, "") + "…";
}

// The homepage card, exactly as the page script draws it (the link goes to the film page; a plain click opens the popup)
const cardHTML = (v, i) => `
        <a class="card" href="/work/${esc(v.slug)}/" data-index="${i}">
          <img ${thumbAttrs(v.thumb)} alt="" loading="${i < 2 ? "eager" : "lazy"}" decoding="async" style="object-position:50% ${cropOf(v)}%">
          <div class="overlay">
            <svg class="playIcon" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <circle cx="22" cy="22" r="21"/><path d="M18 15l11 7-11 7z" fill="currentColor" stroke="none"/>
            </svg>
            <p class="cardTitle">${esc(v.title)}</p>
            ${thumbDetailOf(v) ? `<p class="cardClient">${esc(thumbDetailOf(v))}</p>` : ""}
          </div>
        </a>
      `;

/* ---------- Film pages ---------- */
function filmPage(v, i) {
  const role = andrewRole(v);
  const details = detailsOf(v);
  const credits = (v.credits || []).filter((c) => c && (c.role || c.name));
  const tags = tagsOf(v);
  const title = `${v.title} | Andrew Tomayko · Toy Boat Films`;
  const desc = summary(v);
  const image = v.thumb ? abs(v.thumb) : `${ORIGIN}/Assets/reel-poster.jpg`;

  // A few more films to keep watching (next in the homepage order)
  const pool = videos.filter((o) => o !== v && inAll(o));
  const start = Math.max(0, pool.findIndex((o) => videos.indexOf(o) > i));
  const more = [0, 1, 2].map((k) => pool[(start + k) % pool.length]).filter((o, k, a) => o && a.indexOf(o) === k);

  const ld = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: v.title,
    description: String(v.description || "").trim() || desc,
    thumbnailUrl: [image],
    ...(v.uploadDate ? { uploadDate: v.uploadDate } : {}),
    ...(v.duration ? { duration: isoDuration(v.duration) } : {}),
    ...(v.parsed ? { embedUrl: embedURL(v.parsed, false) } : {}),
    url: pageURL(v),
    ...(tags.length ? { genre: tags } : {}),
    ...(v.location ? { contentLocation: { "@type": "Place", name: v.location } } : {}),
    creator: { "@type": "Person", "@id": `${ORIGIN}/#andrew`, name: "Andrew Tomayko", url: `${ORIGIN}/` },
    productionCompany: { "@type": "Organization", "@id": `${ORIGIN}/#toyboat`, name: "Toy Boat Films", url: `${ORIGIN}/` },
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0b0b0b" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${pageURL(v)}" />
  <meta property="og:type" content="video.other" />
  <meta property="og:site_name" content="Toy Boat Films" />
  <meta property="og:title" content="${esc(v.title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${pageURL(v)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/Assets/favicon/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/Assets/favicon/favicon-32x32.png">
  <link rel="apple-touch-icon" href="/Assets/favicon/apple-touch-icon.png">
  <script type="application/ld+json">
${ldJSON(ld)}
  </script>
  <style>
    /* Same look as the homepage popup. Generated by scripts/build-pages.mjs from data/videos.json. */
    :root{ --bg:#0b0b0b; --text:#f2f2f2; --muted:#9a9a9a; --border:#262626; --sidePadding:32px; }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family:system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; }
    a{ color:inherit; }
    :focus-visible{ outline:2px solid currentColor; outline-offset:3px; }
    .btn{ display:inline-block; background:none; border:2px solid currentColor; color:inherit; padding:14px 24px; font:inherit; font-size:13px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; text-decoration:none; cursor:pointer; transition:background .2s ease, color .2s ease; }
    .btn:hover{ background:var(--text); color:var(--bg); }
    .btn-small{ padding:10px 16px; font-size:12px; letter-spacing:.08em; }

    header{ position:sticky; top:0; z-index:10; background:var(--bg); display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:16px; padding:20px var(--sidePadding); }
    .logo{ font-weight:700; letter-spacing:.12em; text-transform:uppercase; text-decoration:none; }
    .mark{ line-height:0; }
    .mark img{ height:38px; width:auto; opacity:.9; }
    .actions{ justify-self:end; display:flex; align-items:center; gap:22px; }
    .navLink{ font-size:12px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; text-decoration:none; padding:8px 0; border-bottom:1px solid transparent; white-space:nowrap; }
    .navLink:hover{ border-bottom-color:var(--text); }

    .player{ position:relative; display:block; width:100%; max-width:min(1600px, 142vh); margin:0 auto; aspect-ratio:16 / 9; background:#000; border:0; padding:0; color:#fff; cursor:pointer; overflow:hidden; }
    .player img{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
    .player svg{ position:absolute; left:50%; top:50%; width:72px; height:72px; transform:translate(-50%, -50%); filter:drop-shadow(0 2px 12px rgba(0,0,0,.5)); transition:transform .3s ease; }
    .player:hover svg{ transform:translate(-50%, -50%) scale(1.08); }
    .player iframe{ position:absolute; inset:0; width:100%; height:100%; border:0; }

    .info{ max-width:1200px; margin:0 auto; padding:48px var(--sidePadding) 24px; display:grid; grid-template-columns:minmax(0, 1.6fr) minmax(0, 1fr); gap:56px; }
    .info.no-credits{ grid-template-columns:minmax(0, 1fr); }
    h1{ margin:0 0 8px; font-size:clamp(22px, 2.6vw, 32px); font-weight:700; letter-spacing:.06em; line-height:1.25; text-transform:uppercase; }
    .meta{ margin:14px 0 0; padding:0; list-style:none; font-size:15px; line-height:1.5; }
    .meta li + li{ margin-top:4px; }
    .meta .label{ margin-right:6px; font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
    .desc{ margin:24px 0 0; max-width:62ch; font-size:16px; line-height:1.7; color:#d6d6d6; white-space:pre-line; }
    h2{ margin:0 0 16px; padding-bottom:12px; border-bottom:1px solid var(--border); font-size:12px; font-weight:400; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
    .credits{ margin:0; display:grid; grid-template-columns:auto 1fr; column-gap:24px; row-gap:10px; font-size:14px; line-height:1.45; }
    .credits dt{ color:var(--muted); text-transform:uppercase; letter-spacing:.1em; font-size:12px; padding-top:2px; }
    .credits dd{ margin:0; }

    .cta{ max-width:1200px; margin:0 auto; padding:32px var(--sidePadding) 64px; display:flex; flex-wrap:wrap; align-items:center; gap:16px 28px; }
    .cta p{ margin:0; font-size:16px; color:#d6d6d6; }

    .more{ border-top:1px solid var(--border); }
    .more h2{ max-width:1200px; margin:0 auto; padding:28px var(--sidePadding) 20px; border:0; }
    .moreGrid{ display:grid; grid-template-columns:repeat(3, 1fr); background:#111; }
    .moreCard{ position:relative; display:block; aspect-ratio:16 / 9; overflow:hidden; text-decoration:none; color:#fff; background:#1a1a1a; }
    .moreCard img{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .8s cubic-bezier(.2,.7,.2,1); }
    .moreCard span{ position:absolute; inset:auto 0 0; padding:40px 20px 16px; background:linear-gradient(transparent, rgba(0,0,0,.75)); font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    .moreCard:hover img{ transform:scale(1.03); }

    footer{ padding:48px var(--sidePadding); text-align:center; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
    footer a{ text-decoration:none; }
    footer a:hover{ color:var(--text); }

    @media (max-width: 800px){
      :root{ --sidePadding:20px; }
      .mark img{ height:30px; }
      .info{ grid-template-columns:minmax(0, 1fr); gap:36px; padding-top:32px; }
      .moreGrid{ grid-template-columns:1fr; }
    }
    @media (max-width: 600px){ .actions .navLink{ display:none; } }
    @media (max-width: 420px){ header{ gap:10px; } .mark img{ height:24px; } .btn-small{ padding:9px 11px; font-size:11px; letter-spacing:.06em; } }
    @media (max-width: 360px){ .mark{ display:none; } }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">Toy Boat</a>
    <a class="mark" href="/" aria-label="Toy Boat Films home"><img src="/Assets/logo-wave-white.png" alt="" width="439" height="171"></a>
    <div class="actions">
      <a class="navLink" href="/">All work</a>
      <a class="btn btn-small" href="/#contact">Book a call</a>
    </div>
  </header>

  <main>
    ${v.parsed ? `<button class="player" type="button" id="play" data-src="${esc(embedURL(v.parsed, true))}" aria-label="Play ${esc(v.title)}">
      <img ${thumbAttrs(v.thumb, "100vw")} alt="${esc(v.title)}${thumbDetailOf(v) ? ` — ${esc(thumbDetailOf(v))}` : ""}" style="object-position:50% ${cropOf(v)}%">
      <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="22" cy="22" r="21"/><path d="M18 15l11 7-11 7z" fill="currentColor" stroke="none"/></svg>
    </button>` : ""}

    <article class="info${credits.length ? "" : " no-credits"}">
      <div>
        <h1>${esc(v.title)}</h1>
        ${details.length || v.location || tags.length ? `<ul class="meta">
          ${details.map((d) => `<li>${d.label ? `<span class="label">${esc(d.label)}:</span>` : ""}${esc(d.value)}</li>`).join("\n          ")}
          ${v.location ? `<li><span class="label">Location:</span>${esc(v.location)}</li>` : ""}
          ${tags.length ? `<li><span class="label">Type:</span>${esc(tags.join(", "))}</li>` : ""}
        </ul>` : ""}
        ${v.description ? `<p class="desc">${esc(String(v.description).trim())}</p>` : ""}
      </div>
      ${credits.length ? `<div>
        <h2>Credits</h2>
        <dl class="credits">
          ${credits.map((c) => `<dt>${esc(c.role)}</dt><dd>${esc(c.name)}</dd>`).join("\n          ")}
        </dl>
      </div>` : ""}
    </article>

    <section class="cta">
      <a class="btn" href="/#contact">Plan your project</a>
      <p>${role ? `${esc(role)}: Andrew Tomayko` : "A film by Andrew Tomayko"} · Toy Boat Films, Poulsbo, WA</p>
    </section>

    ${more.length ? `<section class="more" aria-label="More work">
      <h2>More work</h2>
      <div class="moreGrid">
        ${more.map((o) => `<a class="moreCard" href="/work/${esc(o.slug)}/"><img ${thumbAttrs(o.thumb, "(max-width: 800px) 100vw, 33vw")} alt="" loading="lazy" decoding="async" style="object-position:50% ${cropOf(o)}%"><span>${esc(o.title)}</span></a>`).join("\n        ")}
      </div>
    </section>` : ""}
  </main>

  <footer>
    <a href="/">Andrew Tomayko · Toy Boat Films</a>
  </footer>

  <script>
    // Resized images fall back to the original file if resizing ever fails
    document.querySelectorAll("img[data-original]").forEach((img) => img.addEventListener("error", () => {
      img.removeAttribute("srcset"); img.src = img.dataset.original;
    }, { once: true }));

    // Anonymous counts for /stats, the same as the homepage (off on local copies and ignored devices)
    const SLUG = ${JSON.stringify(v.slug)};
    let off = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    try { off = off || localStorage.getItem("tb-stats-ignore") === "1"; } catch {}
    const send = (event) => {
      if (off) return;
      const body = JSON.stringify(event);
      if (!(navigator.sendBeacon && navigator.sendBeacon("/.netlify/functions/stats", body))) fetch("/.netlify/functions/stats", { method: "POST", body, keepalive: true }).catch(() => {});
    };
    let src = "direct";
    try { const host = new URL(document.referrer).hostname.replace(/^(www|m|l|lm)\\./, ""); if (host && host !== location.hostname) src = host; } catch {}
    const ref = new URLSearchParams(location.search).get("utm_source") || new URLSearchParams(location.search).get("ref");
    if (ref) src = ref.toLowerCase().replace(/[^a-z0-9.\\-]/g, "").slice(0, 80) || "direct";
    send({ t: "pv", src, dev: innerWidth < 768 ? "phone" : innerWidth < 1100 ? "tablet" : "desktop" });

    // Click to play: swap the still for the player
    const play = document.getElementById("play");
    let since = 0;
    if (play) play.addEventListener("click", () => {
      play.innerHTML = '<iframe src="' + play.dataset.src + '" title="' + play.getAttribute("aria-label").slice(5).replace(/"/g, "&quot;") + '" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>';
      play.removeAttribute("aria-label");
      play.style.cursor = "default";
      since = Date.now();
      send({ t: "vo", v: SLUG });
    }, { once: true });
    addEventListener("pagehide", () => {
      const secs = since ? Math.round((Date.now() - since) / 1000) : 0;
      if (secs >= 1) send({ t: "vt", v: SLUG, s: Math.min(secs, 3600) });
      since = 0;
    });
  </script>
</body>
</html>
`;
}

await rm(new URL("work/", ROOT), { recursive: true, force: true });
for (const [i, v] of videos.entries()) {
  const dir = new URL(`work/${v.slug}/`, ROOT);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL("index.html", dir), filmPage(v, i));
}

/* ---------- Homepage grid in the HTML ---------- */
const homePath = new URL("index.html", ROOT);
const home = await readFile(homePath, "utf8");
const START = "<!-- prerender:grid -->", END = "<!-- /prerender:grid -->";
const a = home.indexOf(START), b = home.indexOf(END);
if (a < 0 || b < a) throw new Error("index.html is missing the prerender:grid markers");
const grid = videos.filter(inAll).map(cardHTML).join("");
await writeFile(homePath, home.slice(0, a + START.length) + grid + home.slice(b));

/* ---------- Sitemap ---------- */
const today = new Date().toISOString().slice(0, 10);
const urls = [`  <url>\n    <loc>${ORIGIN}/</loc>\n    <lastmod>${today}</lastmod>\n  </url>`,
  ...videos.map((v) => `  <url>\n    <loc>${pageURL(v)}</loc>\n  </url>`)];
await writeFile(new URL("sitemap.xml", ROOT), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);

console.log(`Built ${videos.length} film pages, the homepage grid and the sitemap.`);
