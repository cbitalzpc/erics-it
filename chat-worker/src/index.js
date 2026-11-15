// Eric's IT live chat: AI assistant + human handoff + admin console backend.
// Served at https://chat.erics-it.com. The website widget and /admin page talk to it.

import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGINS = ["https://erics-it.com", "https://www.erics-it.com", "http://localhost:8765"];
const SESSION_DAYS = 7;
const MAX_TEXT = 2000;
const MAX_VISITOR_MSGS = 60;      // per conversation
const AI_DAILY_CAP = 600;          // AI replies per day, across all chats
const HISTORY_FOR_AI = 16;         // messages of context sent to the model
const RETENTION_DAYS = 90;

const SYSTEM_PROMPT = `You are the virtual assistant on the website of Eric's IT LLC, an IT consulting company on Long Island, NY.
Eric's IT offers: network security, cloud solutions (AWS, Azure, Google Cloud), IT support & maintenance (remote and on-site), data backup & recovery, software implementation, and hardware upgrades & management.
Support is available 24/6 (closed on Shabbos). New clients can email consultation@erics-it.com; existing clients can email support@erics-it.com; phone (516) 755-7980.

How to behave:
- Help visitors with IT questions: give clear, practical, step-by-step answers in plain English. Keep replies short (under about 150 words) unless more detail is needed.
- Never invent prices, contract terms, availability, or facts about the company that are not listed above. If asked, say a technician will confirm.
- Never ask for or accept passwords, credit card numbers, or other secrets. If a visitor shares one, tell them not to and to change it.
- Do not run commands or claim to have access to the visitor's systems.
- Stay on topic (technology and Eric's IT services). Politely decline unrelated requests.
- For ordinary IT questions, just answer them. Do NOT hand off on the first answer, and do not say you are "connecting them" unless you are actually handing off now. You may end with something like "If that doesn't fix it, let me know and I can bring in a technician."
- Hand off to a human technician ONLY when: the visitor asks for a person/technician/Eric; they want to book work, get a quote, pricing, or become a client; it's urgent (business down, suspected hack, ransomware, data loss); or they tell you your suggestions didn't work.
- To hand off, write one short friendly sentence saying you're connecting them with a technician, then end your reply with the exact token [[HANDOFF]]. Never use the token in any other situation.`;

// ─────────────────────────── Worker entry ───────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/" ) return new Response("Eric's IT chat service", { headers: { "content-type": "text/plain" } });

    // Everything else is handled by the single ChatHub Durable Object.
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden origin", { status: 403 });
      const stub = env.HUB.get(env.HUB.idFromName("main"));
      const res = await stub.fetch(request);
      if (res.webSocket) return res;
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    return new Response("Not found", { status: 404 });
  },
};

function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const CID_RE = /^[a-f0-9-]{36}$/;
const now = () => Date.now();
const clip = (s, n = MAX_TEXT) => String(s ?? "").trim().slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─────────────────────────── Email (Resend) ───────────────────────────
// Free tier: 3,000 emails/month. API key is the RESEND_API_KEY secret.
async function sendEmail(env, { to, subject, text, html, replyTo }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Eric's IT Chat <${env.FROM_EMAIL}>`,
      to: [to], subject, text, html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─────────────────────────── Session cookies ───────────────────────────

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function makeSession(env) {
  const payload = b64url(enc.encode(JSON.stringify({ sub: env.ADMIN_EMAIL, exp: now() + SESSION_DAYS * 864e5 })));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function verifySession(env, request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)eit_admin=([^;]+)/);
  if (!m || !env.SESSION_SECRET) return false;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff) return false;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return data.exp > now();
  } catch { return false; }
}

const cookie = (value, maxAge) =>
  `eit_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ─────────────────────────── Durable Object ───────────────────────────

export class ChatHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'bot',
        created INTEGER, updated INTEGER, name TEXT, email TEXT,
        notified INTEGER DEFAULT 0, visitor_msgs INTEGER DEFAULT 0,
        admin_seen INTEGER DEFAULT 0, page TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL,
        sender TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_cid ON messages(cid, id);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
    `);
  }

  // ── HTTP / WebSocket routing ──
  async fetch(request) {
    const url = new URL(request.url);
    const env = this.env;

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const role = url.searchParams.get("role");
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      if (role === "admin") {
        if (!(await verifySession(env, request))) return new Response("Unauthorized", { status: 401 });
        this.ctx.acceptWebSocket(server, ["admin"]);
        server.serializeAttachment({ role: "admin" });
        server.send(JSON.stringify({ type: "list", conversations: this.listConversations() }));
      } else {
        const cid = url.searchParams.get("cid") || "";
        if (!CID_RE.test(cid)) return new Response("Bad conversation id", { status: 400 });
        this.ensureConversation(cid, clip(url.searchParams.get("page"), 200));
        this.ctx.acceptWebSocket(server, [`v:${cid}`]);
        server.serializeAttachment({ role: "visitor", cid });
        server.send(JSON.stringify({ type: "history", messages: this.messages(cid, true), status: this.conv(cid).status }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/api/admin/login" && request.method === "POST") return this.login(request);
    if (url.pathname === "/api/admin/verify" && request.method === "POST") return this.verify(request);
    if (url.pathname === "/api/admin/logout" && request.method === "POST")
      return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
    if (url.pathname === "/api/admin/me")
      return json({ authenticated: await verifySession(env, request), email: env.ADMIN_EMAIL });

    return new Response("Not found", { status: 404 });
  }

  // ── Admin login with emailed one-time code ──
  async login(request) {
    const { email } = await request.json().catch(() => ({}));
    if (String(email || "").trim().toLowerCase() !== this.env.ADMIN_EMAIL.toLowerCase())
      return json({ ok: true }); // don't reveal which emails are valid
    const last = this.kvGet("login_last");
    if (last && now() - Number(last) < 60_000) return json({ ok: false, error: "Please wait a minute before requesting another code." }, 429);

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    this.kvSet("login_code", JSON.stringify({ code, tries: 0 }), now() + 10 * 60_000);
    this.kvSet("login_last", String(now()), now() + 60_000);
    try {
      await sendEmail(this.env, {
        to: this.env.ADMIN_EMAIL,
        subject: `Your Eric's IT admin login code: ${code}`,
        text: `Your login code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Your Eric's IT chat admin login code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
      });
    } catch (e) {
      console.error("login email failed", e.message);
      return json({ ok: false, error: "Couldn't send the login email. Check the email service setup." }, 500);
    }
    return json({ ok: true });
  }

  async verify(request) {
    const { code } = await request.json().catch(() => ({}));
    const raw = this.kvGet("login_code");
    if (!raw) return json({ ok: false, error: "Code expired. Request a new one." }, 400);
    const rec = JSON.parse(raw);
    if (rec.tries >= 5) { this.kvDel("login_code"); return json({ ok: false, error: "Too many attempts. Request a new code." }, 429); }
    if (String(code || "").trim() !== rec.code) {
      rec.tries++;
      this.kvSet("login_code", JSON.stringify(rec), now() + 10 * 60_000);
      return json({ ok: false, error: "That code isn't right." }, 400);
    }
    this.kvDel("login_code");
    return json({ ok: true }, 200, { "Set-Cookie": cookie(await makeSession(this.env), SESSION_DAYS * 86400) });
  }

  // ── WebSocket messages (hibernation API) ──
  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    if (att.role === "admin") return this.onAdmin(ws, msg);
    if (att.role === "visitor") return this.onVisitor(ws, att.cid, msg);
  }

  async webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
  async webSocketError() {}

  // ── Visitor events ──
  async onVisitor(ws, cid, msg) {
    const c = this.conv(cid);
    if (!c) return;

    if (msg.type === "contact") {
      const name = clip(msg.name, 80), email = clip(msg.email, 120);
      this.sql.exec("UPDATE conversations SET name = ?, email = ? WHERE id = ?", name, email, cid);
      this.pushAdminUpdate(cid);
      return;
    }

    if (msg.type === "human") {
      if (c.status === "bot" || c.status === "closed") {
        this.addMessage(cid, "system", "Visitor asked to talk to a person.");
        await this.handoff(cid);
      }
      return;
    }

    if (msg.type !== "msg") return;
    const text = clip(msg.text);
    if (!text) return;
    if (c.visitor_msgs >= MAX_VISITOR_MSGS) {
      return this.sendVisitor(cid, { type: "msg", message: this.addMessage(cid, "bot", "This chat has reached its message limit. Please email support@erics-it.com or call (516) 755-7980.", true) });
    }
    this.sql.exec("UPDATE conversations SET visitor_msgs = visitor_msgs + 1 WHERE id = ?", cid);
    if (c.status === "closed") this.setStatus(cid, "bot");
    this.addMessage(cid, "visitor", text);

    if (this.conv(cid).status === "bot") await this.aiReply(cid);
  }

  async aiReply(cid) {
    const day = new Date().toISOString().slice(0, 10);
    const used = Number(this.kvGet(`ai:${day}`) || 0);
    if (used >= AI_DAILY_CAP) {
      this.addMessage(cid, "bot", "Our assistant is busy right now, so I'm connecting you with a technician.");
      return this.handoff(cid);
    }
    this.kvSet(`ai:${day}`, String(used + 1), now() + 2 * 864e5);
    this.sendVisitor(cid, { type: "typing" });

    const history = this.messages(cid).filter((m) => m.sender === "visitor" || m.sender === "bot").slice(-HISTORY_FOR_AI);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.sender === "visitor" ? "user" : "assistant", content: m.text })),
    ];

    let reply = "";
    try {
      const out = await this.env.AI.run(this.env.AI_MODEL, { messages, max_tokens: 600, temperature: 0.4 });
      reply = (out && (out.response ?? out.result?.response)) || "";
    } catch (e) {
      console.error("AI error", e.message);
    }
    if (!reply.trim()) {
      this.addMessage(cid, "bot", "Sorry, I'm having trouble answering right now. Let me get a technician for you.");
      return this.handoff(cid);
    }

    const wantsHuman = reply.includes("[[HANDOFF]]");
    reply = reply.replace(/\[\[HANDOFF\]\]/g, "").trim();
    if (reply) this.addMessage(cid, "bot", reply);
    if (wantsHuman) await this.handoff(cid);
  }

  async handoff(cid) {
    this.setStatus(cid, "waiting");
    const c = this.conv(cid);
    this.addMessage(cid, "system", "A technician has been notified and will join this chat shortly. You can keep typing; they'll see everything here.");
    if (!c.notified) {
      this.sql.exec("UPDATE conversations SET notified = 1 WHERE id = ?", cid);
      await this.notifyAdmin(cid);
    }
  }

  async notifyAdmin(cid) {
    const c = this.conv(cid);
    const transcript = this.messages(cid).slice(-20);
    const link = `${this.env.SITE_ORIGIN}/admin/#${cid}`;
    const who = [c.name, c.email].filter(Boolean).join(" · ") || "Website visitor";
    const label = { visitor: "Visitor", bot: "Assistant", agent: "You", system: "—" };
    try {
      await sendEmail(this.env, {
        to: this.env.ADMIN_EMAIL,
        replyTo: c.email || undefined,
        subject: `Live chat: ${who} needs a technician`,
        text: `${who} asked for a technician on erics-it.com.\n\nJoin the chat: ${link}\n\n` +
          transcript.map((m) => `${label[m.sender] || m.sender}: ${m.text}`).join("\n"),
        html: `<p><strong>${esc(who)}</strong> asked for a technician on erics-it.com.</p>
          <p><a href="${link}" style="display:inline-block;background:#1d6fff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Join the chat</a></p>
          <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">${transcript
            .map((m) => `<tr><td style="color:#667;vertical-align:top;white-space:nowrap">${label[m.sender] || m.sender}</td><td>${esc(m.text).replace(/\n/g, "<br>")}</td></tr>`)
            .join("")}</table>`,
      });
    } catch (e) {
      console.error("notify email failed", e.message);
    }
  }

  // ── Admin events ──
  async onAdmin(ws, msg) {
    const cid = msg.cid;
    if (msg.type === "list") return ws.send(JSON.stringify({ type: "list", conversations: this.listConversations() }));
    if (!CID_RE.test(cid || "") || !this.conv(cid)) return;

    if (msg.type === "open") {
      this.markSeen(cid);
      ws.send(JSON.stringify({ type: "conv", id: cid, conversation: this.summary(cid), messages: this.messages(cid) }));
      this.pushAdminUpdate(cid);
    } else if (msg.type === "join") {
      if (this.conv(cid).status !== "agent") {
        this.setStatus(cid, "agent");
        this.addMessage(cid, "system", "Eric from Eric's IT has joined the chat.");
      }
    } else if (msg.type === "msg") {
      const text = clip(msg.text);
      if (!text) return;
      if (this.conv(cid).status !== "agent") {
        this.setStatus(cid, "agent");
        this.addMessage(cid, "system", "Eric from Eric's IT has joined the chat.");
      }
      this.addMessage(cid, "agent", text);
      this.markSeen(cid);
    } else if (msg.type === "handback") {
      this.setStatus(cid, "bot");
      this.addMessage(cid, "system", "You're back with the virtual assistant. Ask for a person any time.");
    } else if (msg.type === "close") {
      this.setStatus(cid, "closed");
      this.addMessage(cid, "system", "This chat has been closed. Thanks for contacting Eric's IT! Send a new message any time to start again.");
    } else if (msg.type === "delete") {
      this.sql.exec("DELETE FROM messages WHERE cid = ?", cid);
      this.sql.exec("DELETE FROM conversations WHERE id = ?", cid);
      this.broadcastAdmin({ type: "deleted", id: cid });
    }
  }

  // ── Data helpers ──
  ensureConversation(cid, page) {
    if (!this.conv(cid)) {
      this.sql.exec("INSERT INTO conversations (id, status, created, updated, page) VALUES (?, 'bot', ?, ?, ?)", cid, now(), now(), page);
    }
  }
  conv(cid) { return this.sql.exec("SELECT * FROM conversations WHERE id = ?", cid).toArray()[0]; }

  messages(cid, forVisitor = false) {
    return this.sql.exec("SELECT id, sender, text, ts FROM messages WHERE cid = ? ORDER BY id", cid).toArray();
  }

  addMessage(cid, sender, text, skipBroadcast = false) {
    const ts = now();
    const row = this.sql.exec("INSERT INTO messages (cid, sender, text, ts) VALUES (?, ?, ?, ?) RETURNING id", cid, sender, text, ts).one();
    this.sql.exec("UPDATE conversations SET updated = ? WHERE id = ?", ts, cid);
    const message = { id: row.id, sender, text, ts };
    if (!skipBroadcast) {
      this.sendVisitor(cid, { type: "msg", message });
      this.broadcastAdmin({ type: "msg", cid, message });
      this.pushAdminUpdate(cid);
    }
    return message;
  }

  setStatus(cid, status) {
    this.sql.exec("UPDATE conversations SET status = ?, updated = ? WHERE id = ?", status, now(), cid);
    if (status !== "waiting") this.sql.exec("UPDATE conversations SET notified = 0 WHERE id = ?", cid);
    this.sendVisitor(cid, { type: "status", status });
    this.pushAdminUpdate(cid);
  }

  markSeen(cid) {
    const last = this.sql.exec("SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE cid = ?", cid).one().m;
    this.sql.exec("UPDATE conversations SET admin_seen = ? WHERE id = ?", last, cid);
  }

  summary(cid) {
    return this.sql.exec(`
      SELECT c.id, c.status, c.created, c.updated, c.name, c.email, c.page,
        (SELECT text FROM messages m WHERE m.cid = c.id AND m.sender != 'system' ORDER BY id DESC LIMIT 1) AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.cid = c.id AND m.sender = 'visitor' AND m.id > c.admin_seen) AS unread,
        (SELECT COUNT(*) FROM messages m WHERE m.cid = c.id AND m.sender = 'visitor') AS visitor_count,
        ? AS online
      FROM conversations c WHERE c.id = ?`, this.ctx.getWebSockets(`v:${cid}`).length > 0 ? 1 : 0, cid).toArray()[0];
  }

  listConversations() {
    const cutoff = now() - RETENTION_DAYS * 864e5;
    this.sql.exec("DELETE FROM messages WHERE cid IN (SELECT id FROM conversations WHERE updated < ?)", cutoff);
    this.sql.exec("DELETE FROM conversations WHERE updated < ?", cutoff);
    const ids = this.sql.exec(`SELECT c.id FROM conversations c
      WHERE EXISTS (SELECT 1 FROM messages m WHERE m.cid = c.id AND m.sender = 'visitor')
      ORDER BY c.updated DESC LIMIT 200`).toArray();
    return ids.map((r) => this.summary(r.id));
  }

  pushAdminUpdate(cid) {
    if (!this.ctx.getWebSockets("admin").length) return;
    const s = this.summary(cid);
    if (s && s.visitor_count > 0) this.broadcastAdmin({ type: "update", conversation: s });
  }

  sendVisitor(cid, data) {
    const s = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets(`v:${cid}`)) { try { ws.send(s); } catch {} }
  }
  broadcastAdmin(data) {
    const s = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets("admin")) { try { ws.send(s); } catch {} }
  }

  kvGet(k) {
    const r = this.sql.exec("SELECT v, exp FROM kv WHERE k = ?", k).toArray()[0];
    if (!r) return null;
    if (r.exp && r.exp < now()) { this.kvDel(k); return null; }
    return r.v;
  }
  kvSet(k, v, exp = null) { this.sql.exec("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)", k, v, exp); }
  kvDel(k) { this.sql.exec("DELETE FROM kv WHERE k = ?", k); }
}
