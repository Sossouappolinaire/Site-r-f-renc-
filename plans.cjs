const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MEDIA_DIR = path.join(__dirname, "media");
const EXPORT_DIR = path.join(__dirname, "exports");
const TZ = process.env.APP_TZ || "Africa/Porto-Novo";
const MAX_VIDEO_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_BODY = 26 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 16;
const VIDEO_TTL_MS = (Number(process.env.VIDEO_DELETE_SECONDS) || 600) * 1000;
const CHAT_GRACE_MS = (Number(process.env.CHAT_GRACE_SECONDS) || 600) * 1000;
const PSEUDOS = ["Étoile", "Lune", "Soleil", "Rose", "Faucon", "Opale", "Cèdre", "Océan", "Jade", "Lotus", "Aigle", "Perle"];
const EXT = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MIME = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

const dayKey = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
const timeKey = (iso) => new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const digits = (v) => String(v || "").replace(/\D/g, "");

function httpError(message, status = 400) { const e = new Error(message); e.status = status; return e; }

function mp4Seconds(buf) {
  const i = buf.indexOf("mvhd");
  if (i < 0 || i + 40 > buf.length) return null;
  const t = i + 4;
  const v = buf[t];
  const scale = v === 1 ? buf.readUInt32BE(t + 20) : buf.readUInt32BE(t + 12);
  const dur = v === 1 ? Number(buf.readBigUInt64BE(t + 24)) : buf.readUInt32BE(t + 16);
  return scale ? dur / scale : null;
}

function saveMedia(value, kind) {
  const m = /^data:((?:video\/(?:mp4|webm|quicktime))|(?:image\/(?:jpeg|png|webp|gif)));base64,([A-Za-z0-9+/]+=*)$/.exec(String(value || ""));
  if (!m || !m[1].startsWith(kind + "/")) throw httpError(kind === "video" ? "La vidéo doit être au format MP4, MOV ou WebM." : "La photo doit être une image JPEG, PNG, WebP ou GIF.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > (kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) throw httpError(kind === "video" ? "Vidéo trop lourde (18 Mo maximum)." : "Photo trop lourde (2 Mo maximum).");
  const head = buf.subarray(0, 12);
  const ok = m[1] === "video/webm" ? head.readUInt32BE(0) === 0x1a45dfa3
    : kind === "video" ? ["ftyp", "moov", "wide", "mdat", "free"].includes(head.subarray(4, 8).toString("latin1"))
    : m[1] === "image/jpeg" ? head[0] === 0xff && head[1] === 0xd8
    : m[1] === "image/png" ? head[0] === 0x89 && head[1] === 0x50
    : m[1] === "image/gif" ? head.subarray(0, 3).toString("latin1") === "GIF"
    : head.subarray(0, 4).toString("latin1") === "RIFF";
  if (!ok) throw httpError("Fichier invalide.");
  if (kind === "video" && m[1] !== "video/webm") {
    const s = mp4Seconds(buf);
    if (s !== null && s > MAX_VIDEO_SECONDS) throw httpError("La vidéo dure plus de 15 secondes.");
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const name = crypto.randomBytes(16).toString("hex") + EXT[m[1]];
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf, { mode: 0o600 });
  return name;
}

const mediaUrl = (name) => (name ? `/api/media/${name}` : null);
const csvCell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };

module.exports = function createPlans(ctx) {
  const { data, writeData, json, readBody, getSession, currentUser, adminRequired, userRequired, limited } = ctx;
  data.plans = Array.isArray(data.plans) ? data.plans : [];
  data.archive = Array.isArray(data.archive) ? data.archive : [];
  data.settings = data.settings && typeof data.settings === "object" ? data.settings : { passLink: "" };
  data.nextPlanId = data.nextPlanId || 1;
  data.nextInterestId = data.nextInterestId || 1;
  data.nextChatId = data.nextChatId || 1;
  data.lastPurgeDay = data.lastPurgeDay || dayKey();
  data.mediaViews = data.mediaViews && typeof data.mediaViews === "object" ? data.mediaViews : {};

  const err = (res, status, message) => json(res, status, { error: message });
  const userById = (id) => data.users.find((u) => u.id === id);
  const fullName = (id) => { const u = userById(id); return u ? `${u.firstName} ${u.lastName}` : "Inconnu"; };
  const chosenOf = (plan) => plan.interests.find((i) => i.id === plan.chosenInterestId) || null;
  const label = (plan) => `${plan.gender === "femme" ? "Une femme" : plan.gender === "homme" ? "Un homme" : "Une personne"} souhaite ${plan.target === "homme" ? "un homme" : "une femme"} ce soir`;

  function csv(rows) {
    const head = ["Date", "Heure", "Plan", "Demandeur", "Répondant", "Auteur", "Message"];
    const lines = [head, ...rows.map((r) => [r.day, timeKey(r.at), r.pseudo, r.requester, r.responder, r.author, r.body])];
    return "\ufeff" + lines.map((l) => l.map(csvCell).join(";")).join("\r\n") + "\r\n";
  }

  function purge(newDay) {
    try {
      const rows = data.archive.filter((r) => r.day === data.lastPurgeDay);
      if (rows.length) { fs.mkdirSync(EXPORT_DIR, { recursive: true }); fs.writeFileSync(path.join(EXPORT_DIR, `discussions-${data.lastPurgeDay}.csv`), csv(rows)); }
    } catch (_e) { /* l'archive reste dans data.json */ }
    for (const plan of data.plans) {
      plan.messages = [];
      if (plan.day !== newDay) { plan.status = "closed"; plan.chatActive = false; }
    }
    data.lastPurgeDay = newDay;
    writeData();
  }
  setInterval(() => { const k = dayKey(); if (k !== data.lastPurgeDay) purge(k); }, 30 * 1000).unref();

  function expirePass(plan) {
    for (const i of plan.interests) {
      if (i.id === plan.chosenInterestId) i.status = "expired";
      else if (i.status === "rejected") i.status = i.prev || "presented";
    }
    plan.status = "open"; plan.chosenInterestId = null; plan.passClickedAt = null; plan.chatActive = false; plan.chatRequested = false;
    plan.expiredCount = (plan.expiredCount || 0) + 1;
  }
  const overdue = (plan) => plan.status === "chosen" && plan.passClickedAt && !plan.chatActive && Date.now() - new Date(plan.passClickedAt).getTime() > CHAT_GRACE_MS;
  setInterval(() => { let n = 0; for (const plan of data.plans) if (overdue(plan)) { expirePass(plan); n++; } if (n) writeData(); }, 10 * 1000).unref();

  function sweepVideos() {
    let n = 0;
    for (const [name, t] of Object.entries(data.mediaViews)) {
      if (Date.now() - new Date(t).getTime() < VIDEO_TTL_MS) continue;
      try { fs.unlinkSync(path.join(MEDIA_DIR, name)); } catch (_e) { /* déjà supprimée */ }
      for (const plan of data.plans) {
        if (plan.video === name) { plan.video = null; plan.videoDeleted = true; }
        for (const i of plan.interests) if (i.video === name) { i.video = null; i.videoDeleted = true; }
      }
      delete data.mediaViews[name]; n++;
    }
    if (n) writeData();
  }
  setInterval(sweepVideos, 15 * 1000).unref();
  sweepVideos();
  const deleteAt = (name) => (name && data.mediaViews[name] ? new Date(new Date(data.mediaViews[name]).getTime() + VIDEO_TTL_MS).toISOString() : null);

  function requesterView(plan) {
    const out = { id: plan.id, pseudo: plan.pseudo, status: plan.status, note: plan.note, label: label(plan), createdAt: plan.createdAt, videoUrl: mediaUrl(plan.video), chatActive: plan.chatActive, passClicked: Boolean(plan.passClickedAt), expired: (plan.expiredCount || 0) > 0 && plan.status === "open", interests: [] };
    const shown = plan.status === "chosen" ? plan.interests.filter((i) => i.status === "chosen") : plan.interests.filter((i) => i.status === "presented");
    out.interests = shown.map((i) => ({ id: i.id, photoUrl: mediaUrl(i.photo), status: i.status }));
    if (plan.status === "chosen" && !plan.chatActive && data.settings.passLink) out.passLink = data.settings.passLink;
    return out;
  }

  function adminView(plan) {
    return {
      id: plan.id, pseudo: plan.pseudo, status: plan.status, day: plan.day, createdAt: plan.createdAt, note: plan.note, label: label(plan),
      requester: fullName(plan.userId), phone: userById(plan.userId)?.phone || "", whatsapp: plan.whatsapp, videoUrl: mediaUrl(plan.video), videoDeleted: Boolean(plan.videoDeleted), videoDeleteAt: deleteAt(plan.video),
      chatActive: plan.chatActive, chatRequested: plan.chatRequested, chatRequestedAt: plan.chatRequestedAt || null, passClickedAt: plan.passClickedAt, graceMs: CHAT_GRACE_MS, chosenInterestId: plan.chosenInterestId,
      interests: plan.interests.map((i) => ({ id: i.id, name: fullName(i.userId), whatsapp: i.whatsapp, status: i.status, createdAt: i.createdAt, photoUrl: mediaUrl(i.photo), videoUrl: mediaUrl(i.video), videoDeleted: Boolean(i.videoDeleted), videoDeleteAt: deleteAt(i.video) })),
      messages: plan.messages.map((m) => ({ id: m.id, author: m.userId === plan.userId ? `${fullName(m.userId)} (demandeur)` : fullName(m.userId), body: m.body, at: m.at })),
    };
  }

  function canSeeMedia(session, name) {
    if (session.role === "admin") return true;
    if (session.role !== "user") return false;
    for (const plan of data.plans) {
      if (plan.video === name) return plan.userId === session.id;
      for (const i of plan.interests) {
        if (i.video === name) return i.userId === session.id;
        if (i.photo === name) return i.userId === session.id || (plan.userId === session.id && ["presented", "chosen"].includes(i.status));
      }
    }
    return false;
  }

  function sendMedia(req, res, name) {
    const file = path.join(MEDIA_DIR, name);
    if (!fs.existsSync(file)) return err(res, 404, "Fichier introuvable.");
    const size = fs.statSync(file).size;
    const base = { "Content-Type": MIME[path.extname(name)] || "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (!m) { res.writeHead(200, { ...base, "Content-Length": size }); return fs.createReadStream(file).pipe(res); }
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2] || 0));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  function participant(plan, user) {
    if (plan.userId === user.id) return "requester";
    const chosen = chosenOf(plan);
    return chosen && chosen.userId === user.id ? "responder" : null;
  }

  async function handle(req, res, url) {
    const method = req.method;
    const p = url.pathname;
    if (!/^\/api\/(plans|media\/|admin\/(plans|settings|export))/.test(p)) return false;
    const today = dayKey();
    let m;

    if (method === "GET" && (m = p.match(/^\/api\/media\/([a-f0-9]{32}\.(?:mp4|webm|mov|jpg|png|webp|gif))$/))) {
      const session = getSession(req);
      if (!session || !canSeeMedia(session, m[1])) { err(res, 403, "Accès refusé."); return true; }
      if (session.role === "admin" && /\.(mp4|webm|mov)$/.test(m[1]) && !data.mediaViews[m[1]]) { data.mediaViews[m[1]] = new Date().toISOString(); writeData(); }
      sendMedia(req, res, m[1]); return true;
    }

    /* ---------- Membres ---------- */
    if (method === "GET" && p === "/api/plans/open") {
      if (!userRequired(req, res)) return true;
      const user = currentUser(req);
      json(res, 200, data.plans.filter((pl) => pl.status === "open" && pl.day === today && pl.userId !== user.id && pl.target === user.gender)
        .map((pl) => ({ id: pl.id, pseudo: pl.pseudo, label: label(pl), note: pl.note, interested: pl.interests.some((i) => i.userId === user.id) })));
      return true;
    }
    if (method === "GET" && p === "/api/plans/mine") {
      if (!userRequired(req, res)) return true;
      const user = currentUser(req);
      const requests = data.plans.filter((pl) => pl.userId === user.id && pl.day === today).map(requesterView);
      const responses = [];
      for (const pl of data.plans) {
        if (pl.day !== today) continue;
        for (const i of pl.interests) if (i.userId === user.id) responses.push({ planId: pl.id, pseudo: pl.pseudo, label: label(pl), status: i.status, chatActive: pl.chatActive });
      }
      json(res, 200, { requests, responses });
      return true;
    }
    if (method === "POST" && p === "/api/plans") {
      if (!userRequired(req, res)) return true;
      if (limited(req, res, "plan", { ip: 20, windowMs: 3600_000 })) return true;
      const user = currentUser(req);
      const input = await readBody(req, MAX_PLAN_BODY);
      const target = user.gender === "femme" ? "homme" : user.gender === "homme" ? "femme" : input.target;
      if (!["homme", "femme"].includes(target)) return err(res, 400, "Précisez si vous cherchez un homme ou une femme."), true;
      const whatsapp = digits(input.whatsapp);
      if (whatsapp.length < 8) return err(res, 400, "Indiquez un numéro WhatsApp valide."), true;
      if (data.plans.some((pl) => pl.userId === user.id && pl.day === today && pl.status !== "closed")) return err(res, 409, "Vous avez déjà une demande en cours aujourd’hui."), true;
      const video = saveMedia(input.video, "video");
      const plan = {
        id: data.nextPlanId++, userId: user.id, pseudo: PSEUDOS[crypto.randomInt(PSEUDOS.length)] + crypto.randomInt(10, 100),
        gender: user.gender, target, note: String(input.note || "").trim().slice(0, 300), whatsapp, video, status: "pending", day: today,
        createdAt: new Date().toISOString(), interests: [], chosenInterestId: null, passClickedAt: null, chatActive: false, chatRequested: false, messages: [],
      };
      data.plans.push(plan); writeData();
      json(res, 201, requesterView(plan)); return true;
    }
    if (method === "POST" && (m = p.match(/^\/api\/plans\/(\d+)\/interest$/))) {
      if (!userRequired(req, res)) return true;
      if (limited(req, res, "interest", { ip: 40, windowMs: 3600_000 })) return true;
      const user = currentUser(req);
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      if (!plan || plan.status !== "open" || plan.day !== today || plan.userId === user.id || plan.target !== user.gender) return err(res, 404, "Demande indisponible."), true;
      if (plan.interests.some((i) => i.userId === user.id)) return err(res, 409, "Vous avez déjà répondu."), true;
      const input = await readBody(req, MAX_PLAN_BODY);
      const whatsapp = digits(input.whatsapp);
      if (whatsapp.length < 8) return err(res, 400, "Indiquez un numéro WhatsApp valide."), true;
      const video = saveMedia(input.video, "video");
      const photo = saveMedia(input.photo || user.profilePhoto, "image");
      plan.interests.push({ id: data.nextInterestId++, userId: user.id, photo, video, whatsapp, status: "new", createdAt: new Date().toISOString() });
      writeData(); json(res, 201, { ok: true }); return true;
    }
    if (method === "POST" && (m = p.match(/^\/api\/plans\/(\d+)\/choose$/))) {
      if (!userRequired(req, res)) return true;
      const user = currentUser(req);
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      if (!plan || plan.userId !== user.id || plan.status !== "open" || plan.day !== today) return err(res, 404, "Demande introuvable."), true;
      const input = await readBody(req);
      const pick = plan.interests.find((i) => i.id === Number(input.interestId) && i.status === "presented");
      if (!pick) return err(res, 400, "Choisissez une personne proposée."), true;
      for (const i of plan.interests) { i.prev = i.status; i.status = i === pick ? "chosen" : "rejected"; }
      plan.status = "chosen"; plan.chosenInterestId = pick.id; plan.chatActive = false; plan.chatRequested = false;
      writeData(); json(res, 200, requesterView(plan)); return true;
    }
    if (method === "POST" && (m = p.match(/^\/api\/plans\/(\d+)\/pass$/))) {
      if (!userRequired(req, res)) return true;
      const user = currentUser(req);
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      if (!plan || plan.userId !== user.id || plan.status !== "chosen" || plan.day !== today) return err(res, 404, "Demande introuvable."), true;
      if (!plan.passClickedAt) { plan.passClickedAt = new Date().toISOString(); writeData(); }
      json(res, 200, { ok: true }); return true;
    }
    if (method === "POST" && p === "/api/plans/success") {
      if (!userRequired(req, res)) return true;
      const user = currentUser(req);
      const mine = data.plans.filter((pl) => pl.userId === user.id && pl.day === today);
      const plan = mine.find((pl) => pl.status === "chosen" && pl.passClickedAt);
      if (!plan) {
        const blocked = mine.some((pl) => pl.status !== "closed" && (pl.expiredCount || 0) > 0);
        return json(res, 403, { error: blocked ? "Le délai de 10 minutes est dépassé : cette page est bloquée. Revenez sur le site et choisissez une autre personne." : "Cette page s’active uniquement après avoir appuyé sur le bouton « Payer maintenant pour être en contact ».", blocked }), true;
      }
      if (overdue(plan)) { expirePass(plan); writeData(); return json(res, 403, { error: "Le délai de 10 minutes est dépassé : cette page est bloquée. Revenez sur le site et choisissez une autre personne.", blocked: true }), true; }
      const chosen = chosenOf(plan);
      const contact = chosen && userById(chosen.userId);
      if (!contact) return err(res, 404, "Contact introuvable."), true;
      if (!plan.chatActive) { plan.chatActive = true; plan.chatRequested = false; plan.autoOpened = true; plan.successAt = new Date().toISOString(); writeData(); }
      const me = userById(user.id);
      json(res, 200, {
        planId: plan.id, locked: false,
        me: { name: `${me.firstName} ${me.lastName}`, phone: me.phone, whatsapp: plan.whatsapp },
        contact: { name: contact.firstName, whatsapp: chosen.whatsapp, photoUrl: mediaUrl(chosen.photo) },
      });
      return true;
    }
    if (method === "GET" && (m = p.match(/^\/api\/plans\/(\d+)\/chat$/))) {
      if (!userRequired(req, res)) return true;
      const user = currentUser(req);
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      const role = plan && participant(plan, user);
      if (!role) return err(res, 404, "Discussion introuvable."), true;
      if (plan.day !== today || plan.status === "closed") return json(res, 200, { locked: true, closed: true }), true;
      if (!plan.chatActive && role === "requester") {
        if (!plan.chatRequested) { plan.chatRequested = true; plan.chatRequestedAt = new Date().toISOString(); writeData(); }
      }
      if (!plan.chatActive) return json(res, 200, { locked: true }), true;
      json(res, 200, { locked: false, with: role === "requester" ? "votre contact" : plan.pseudo, messages: plan.messages.map((x) => ({ id: x.id, mine: x.userId === user.id, body: x.body, at: x.at })) });
      return true;
    }
    if (method === "POST" && (m = p.match(/^\/api\/plans\/(\d+)\/chat$/))) {
      if (!userRequired(req, res)) return true;
      if (limited(req, res, "chat", { ip: 300, windowMs: 3600_000 })) return true;
      const user = currentUser(req);
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      const role = plan && participant(plan, user);
      if (!role || !plan.chatActive || plan.day !== today) return err(res, 403, "La discussion n’est pas ouverte."), true;
      const input = await readBody(req);
      const body = String(input.body || "").trim().slice(0, 1000);
      if (!body) return err(res, 400, "Votre message est vide."), true;
      const at = new Date().toISOString();
      const chosen = chosenOf(plan);
      plan.messages.push({ id: data.nextChatId++, userId: user.id, body, at });
      data.archive.push({ at, day: today, planId: plan.id, pseudo: plan.pseudo, requester: fullName(plan.userId), responder: chosen ? fullName(chosen.userId) : "", author: fullName(user.id), body });
      writeData(); json(res, 201, { ok: true }); return true;
    }

    /* ---------- Administrateur ---------- */
    if (method === "GET" && p === "/api/admin/plans") {
      if (!adminRequired(req, res)) return true;
      json(res, 200, data.plans.filter((pl) => pl.status !== "closed" || pl.day === today || pl.day === data.lastPurgeDay).slice(-100).reverse().map(adminView));
      return true;
    }
    if (method === "GET" && p === "/api/admin/settings") {
      if (!adminRequired(req, res)) return true;
      json(res, 200, { passLink: data.settings.passLink || "" }); return true;
    }
    if (method === "POST" && p === "/api/admin/settings") {
      if (!adminRequired(req, res)) return true;
      const input = await readBody(req);
      const link = String(input.passLink || "").trim();
      if (link) { let u; try { u = new URL(link); } catch (_e) { return err(res, 400, "Lien invalide."), true; } if (!["https:", "http:"].includes(u.protocol)) return err(res, 400, "Le lien doit commencer par https://"), true; }
      data.settings.passLink = link ? new URL(link).href : ""; writeData(); json(res, 200, { passLink: data.settings.passLink }); return true;
    }
    if (method === "GET" && p === "/api/admin/export.csv") {
      if (!adminRequired(req, res)) return true;
      const date = url.searchParams.get("date");
      const rows = date ? data.archive.filter((r) => r.day === date) : data.archive;
      const body = csv(rows);
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="discussions-${date || "toutes"}.csv"`, "Content-Length": Buffer.byteLength(body) });
      res.end(body); return true;
    }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/plans\/(\d+)\/(open|close|activate-chat|close-chat)$/))) {
      if (!adminRequired(req, res)) return true;
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      if (!plan) return err(res, 404, "Demande introuvable."), true;
      if (m[2] === "open") { if (plan.status !== "pending") return err(res, 400, "Déjà traitée."), true; plan.status = "open"; }
      else if (m[2] === "close") { plan.status = "closed"; plan.chatActive = false; }
      else if (m[2] === "activate-chat") { if (plan.status !== "chosen") return err(res, 400, "Aucune personne choisie."), true; plan.chatActive = true; plan.chatRequested = false; }
      else plan.chatActive = false;
      writeData(); json(res, 200, adminView(plan)); return true;
    }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/plans\/(\d+)\/interests\/(\d+)\/present$/))) {
      if (!adminRequired(req, res)) return true;
      const plan = data.plans.find((pl) => pl.id === Number(m[1]));
      const interest = plan && plan.interests.find((i) => i.id === Number(m[2]));
      if (!plan || plan.status !== "open" || !interest || interest.status !== "new") return err(res, 400, "Action impossible."), true;
      interest.status = "presented"; writeData(); json(res, 200, adminView(plan)); return true;
    }
    return false;
  }
  return { handle };
};
