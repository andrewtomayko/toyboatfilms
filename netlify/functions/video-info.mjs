// Looks up a YouTube or Vimeo link for the editor's "Add video": title, year, description and a
// thumbnail (as a data URL, so the editor can crop it and save it into the site).
// Login required, so this can't be used as an open proxy.
//
//   GET ?url=<YouTube or Vimeo link>  ->  { title, year, description, thumbnail, ratio }
//   (ratio = the video's width / height, used to fit the homepage banner)

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36";
const MAX_IMAGE = 6 * 1024 * 1024;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

const get = (url, accept) => fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...(accept ? { Accept: accept } : {}) } });

// Drop credit/link lines ("Video production: northgrown.com", shop links) and tidy blank lines
function cleanDescription(text) {
  return String(text || "")
    .split("\n").filter((line) => !/https?:\/\/|www\.|\.com\b/i.test(line))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function imageDataUrl(url) {
  const res = await get(url);
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000 || buf.length > MAX_IMAGE) return null; // YouTube's "missing" placeholder is tiny
  return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
}

async function vimeo(link) {
  const res = await get(`https://vimeo.com/api/oembed.json?width=1920&url=${encodeURIComponent(link)}`, "application/json");
  if (!res.ok) throw Object.assign(new Error("Vimeo couldn’t find that video. Is it private?"), { status: 404 });
  const o = await res.json();
  return {
    title: o.title || "",
    year: String(o.upload_date || "").slice(0, 4),
    description: cleanDescription(o.description),
    thumbnail: o.thumbnail_url ? await imageDataUrl(o.thumbnail_url) : null,
    ratio: o.width > 0 && o.height > 0 ? +(o.width / o.height).toFixed(4) : null,
  };
}

async function youtube(id) {
  const out = { title: "", year: "", description: "", thumbnail: null, ratio: null };
  const o = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`);
  if (!o.ok) throw Object.assign(new Error("YouTube couldn’t find that video, or it doesn’t allow embedding."), { status: 404 });
  const meta = await o.json();
  out.title = meta.title || "";
  if (meta.width > 0 && meta.height > 0) out.ratio = +(meta.width / meta.height).toFixed(4);
  try {
    const page = await (await get(`https://www.youtube.com/watch?v=${id}&hl=en`)).text();
    const desc = page.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (desc) out.description = cleanDescription(JSON.parse(`"${desc[1]}"`));
    const year = page.match(/"(?:publishDate|uploadDate)":"(\d{4})/);
    if (year) out.year = year[1];
  } catch { /* title alone is still useful */ }
  for (const size of ["maxresdefault", "sddefault", "hqdefault"]) {
    out.thumbnail = await imageDataUrl(`https://i.ytimg.com/vi/${id}/${size}.jpg`);
    if (out.thumbnail) break;
  }
  return out;
}

export const handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) return reply(401, { error: "Please log in." });
  const allowed = (process.env.INVOICES_ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.email || "").toLowerCase())) return reply(403, { error: "Not allowed." });

  const link = String((event.queryStringParameters || {}).url || "").trim();
  let u;
  try { u = new URL(link); } catch { return reply(400, { error: "That doesn’t look like a link." }); }
  const host = u.hostname.replace(/^(www|m)\./, "");

  try {
    if (host === "youtu.be" || host.endsWith("youtube.com")) {
      const id = host === "youtu.be" ? u.pathname.slice(1).split("/")[0]
        : u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
      if (!/^[\w-]{11}$/.test(id || "")) return reply(400, { error: "Couldn’t find the video ID in that YouTube link." });
      return reply(200, await youtube(id));
    }
    if (host.endsWith("vimeo.com")) return reply(200, await vimeo(link));
    return reply(400, { error: "Paste a YouTube or Vimeo link." });
  } catch (err) {
    return reply(err.status || 502, { error: err.status ? err.message : "Couldn’t reach YouTube or Vimeo. Try again." });
  }
};
