// Private storage for the /invoices app.
//
// Only a logged-in Netlify Identity user may call it (Netlify verifies the login token and fills in
// context.clientContext.user). Set INVOICES_ALLOWED_EMAILS in Netlify to a comma-separated list to
// restrict it further. Data lives in Netlify Blobs, never in the Git repo (which is public).
//
//   GET                      -> { invoices: [...], settings }
//   PUT    ?id=<id>  {...}   -> save one invoice or estimate
//   DELETE ?id=<id>          -> delete one
//   PUT    ?settings=1 {...} -> save company details and logo

import { connectLambda, getStore } from "@netlify/blobs";

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_BODY = 1_000_000; // bytes; a logo plus a long invoice is well under this
const PRODUCTION_HOSTS = new Set(["toyboatfilms.com", "www.toyboatfilms.com"]);

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

function readBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
  if (raw.length > MAX_BODY) throw Object.assign(new Error("Too large"), { status: 413 });
  const data = JSON.parse(raw || "{}");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Object.assign(new Error("Expected an object"), { status: 400 });
  return data;
}

export const handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) return reply(401, { error: "Please log in." });

  const allowed = (process.env.INVOICES_ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.email || "").toLowerCase())) {
    return reply(403, { error: "This account can't open invoices." });
  }

  connectLambda(event);
  // Deploy previews get their own store, so testing never touches real invoices.
  const host = String((event.headers && (event.headers.host || event.headers.Host)) || "").toLowerCase();
  const store = getStore(PRODUCTION_HOSTS.has(host) ? "invoices" : "invoices-preview");
  const q = event.queryStringParameters || {};

  try {
    if (event.httpMethod === "GET") {
      const { blobs } = await store.list({ prefix: "inv/" });
      const invoices = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
      const settings = await store.get("settings", { type: "json" });
      return reply(200, { invoices, settings });
    }

    if (event.httpMethod === "PUT" && q.settings) {
      await store.setJSON("settings", readBody(event));
      return reply(200, { ok: true });
    }

    if (!ID.test(q.id || "")) return reply(400, { error: "Missing or invalid id." });

    if (event.httpMethod === "PUT") {
      await store.setJSON(`inv/${q.id}`, { ...readBody(event), id: q.id });
      return reply(200, { ok: true });
    }

    if (event.httpMethod === "DELETE") {
      await store.delete(`inv/${q.id}`);
      return reply(200, { ok: true });
    }

    return reply(405, { error: "Method not allowed." });
  } catch (err) {
    if (err.status) return reply(err.status, { error: err.message });
    if (err instanceof SyntaxError) return reply(400, { error: "Invalid JSON." });
    console.error(err);
    return reply(500, { error: "Something went wrong saving to storage." });
  }
};
