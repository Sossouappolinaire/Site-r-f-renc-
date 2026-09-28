const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const config = require("./config");

const PORT = config.port;
const ADMIN_EMAIL = config.adminEmail;
const ADMIN_PASSWORD = config.adminPassword;
const SESSION_SECRET = config.sessionSecret;
const EMAIL_FROM = config.emailFrom;
const RESEND_API_KEY = config.resendApiKey;
const DATA_FILE = path.join(__dirname, "data.json");
const INDEX_FILE = path.join(__dirname, "index.html");
const sessions = new Map();

const seed = {
  nextUserId: 1,
  nextMessageId: 1,
  nextAnnouncementId: 2,
  nextMatchId: 1,
  users: [],
  messages: [],
  usedLoginCodeHashes: [],
  announcements: [{
    id: 1,
    title: "Bienvenue dans votre espace privé",
    body: "Votre demande sera étudiée avec attention. L’équipe vous préviendra par email dès qu’elle sera confirmée.",
    createdAt: new Date().toISOString()
  }],
  matches: []
};

function readData() {
  try {
    const current = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...JSON.parse(JSON.stringify(seed)), ...current };
  } catch (_error) {
    return JSON.parse(JSON.stringify(seed));
  }
}

function writeData(value) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(value, null, 2));
}

let data = readData();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function html(res) {
  const body = fs.readFileSync(INDEX_FILE, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function codeHash(code) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(String(code)).digest("hex");
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function uniqueCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  } while (data.users.some((user) => user.loginCodeHash === codeHash(code)) || data.usedLoginCodeHashes.includes(codeHash(code)));
  return code;
}

async function sendEmail({ to, subject, html: content }) {
  if (!RESEND_API_KEY) {
    console.log(`[email:console] To: ${to} | Subject: ${subject}\n${content}`);
    return { delivered: false, mode: "console" };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html: content })
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Le service email a refusé l’envoi (${response.status}): ${message.slice(0, 180)}`);
  }
  return { delivered: true, mode: "resend" };
}

function emailLayout(title, content) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f7f0f4;color:#271c32;font-family:Arial,sans-serif;padding:32px">
    <div style="max-width:620px;margin:auto;background:#fff;border-radius:24px;padding:36px;box-shadow:0 12px 40px #44234216">
      <div style="font-size:20px;font-weight:800;color:#542c58">♡ Cœur & Connexions</div>
      <h1 style="font-family:Georgia,serif;font-weight:500;font-size:34px;color:#542c58">${title}</h1>
      ${content}
      <hr style="border:0;border-top:1px solid #eadde4;margin:28px 0">
      <p style="font-size:12px;line-height:1.6;color:#86768b">Cœur & Connexions facilite la prise de contact mais ne garantit ni l’identité, ni les intentions, ni le comportement des utilisateurs. Chaque personne reste responsable de ses échanges et de ses décisions. L’administrateur n’est pas partie aux relations, conversations ou engagements entre utilisateurs. En cas de problème, utilisez le signalement depuis votre espace et contactez les autorités compétentes si nécessaire.</p>
    </div>
  </body></html>`;
}

function sendAdminNewRegistration(user) {
  return sendEmail({
    to: ADMIN_EMAIL,
    subject: `Nouvelle inscription à examiner — ${user.firstName} ${user.lastName}`,
    html: emailLayout("Une nouvelle demande vous attend", `<p>${user.firstName} ${user.lastName} vient de créer un espace avec l’adresse <strong>${user.email}</strong>.</p><p>Connectez-vous à l’espace administrateur pour examiner le profil et confirmer ou refuser la demande.</p>`)
  });
}

function sendApprovalEmail(user, code) {
  return sendEmail({
    to: user.email,
    subject: "Votre espace Cœur & Connexions est confirmé",
    html: emailLayout("Votre demande est confirmée", `<p>Bonjour ${user.firstName},</p><p>Votre espace est maintenant confirmé par l’équipe. Lors de votre première connexion, saisissez le code secret ci-dessous :</p><div style="margin:26px 0;padding:18px;text-align:center;background:#fff0f4;border-radius:16px;color:#542c58;font-size:36px;font-weight:800;letter-spacing:9px">${code}</div><p>Ce code est personnel, à usage unique et valable 30 jours. Ne le partagez avec personne.</p><p>En continuant, vous confirmez accepter les conditions de discrétion, de respect et de responsabilité présentées lors de votre inscription.</p>`)
  });
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((out, item) => {
    const index = item.indexOf("=");
    if (index > 0) out[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
    return out;
  }, {});
}

function setSession(res, value) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, value);
  res.setHeader("Set-Cookie", `cc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  return token;
}

function session(req) {
  const token = parseCookies(req).cc_session;
  return token ? sessions.get(token) : null;
}

function userFromRequest(req) {
  const current = session(req);
  return current?.role === "user" ? data.users.find((user) => user.id === current.id) : null;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 15_000_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_error) { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    gender: user.gender,
    accountType: user.accountType,
    encounterType: user.encounterType,
    planType: user.planType,
    photoCount: user.photos?.length || 0,
    status: user.status,
    profilePhoto: user.profilePhoto || null,
    firstLoginVerified: Boolean(user.firstLoginVerified),
    createdAt: user.createdAt,
    approvedAt: user.approvedAt || null
  };
}

function profilePreview(user, accepted, confirmed) {
  return {
    id: user.id,
    displayName: `${user.firstName} ${user.lastName}`,
    gender: user.gender,
    photoOne: accepted && confirmed ? user.photos?.[0] || null : null,
    photoTwo: accepted && confirmed ? user.photos?.[1] || null : null,
    accepted: Boolean(accepted),
    confirmed: Boolean(confirmed)
  };
}

function messageForUser(message, userId) {
  if (!message.selectedUserIds) return message;
  const chosen = message.selectedUserIds.map((id) => {
    const candidate = data.users.find((user) => user.id === id);
    const match = data.matches.find((item) => item.userId === userId && item.candidateId === id);
    return candidate ? profilePreview(candidate, match?.accepted, match?.confirmed) : null;
  }).filter(Boolean);
  return { ...message, selectedProfiles: chosen };
}

function adminRequired(req, res) {
  const current = session(req);
  if (!current || current.role !== "admin") {
    json(res, 401, { error: "Accès administrateur requis." });
    return false;
  }
  return true;
}

function userRequired(req, res) {
  if (!userFromRequest(req)) {
    json(res, 401, { error: "Connectez-vous pour continuer." });
    return false;
  }
  return true;
}

async function api(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    return json(res, 200, {
      status: "ok",
      config: {
        adminEmailConfigured: Boolean(ADMIN_EMAIL),
        adminPasswordConfigured: Boolean(ADMIN_PASSWORD),
        resendApiKeyConfigured: Boolean(RESEND_API_KEY),
        sessionSecretConfigured: Boolean(SESSION_SECRET && SESSION_SECRET !== "change-me-before-production"),
        emailFrom: EMAIL_FROM
      }
    });
  }

  if (method === "POST" && pathname === "/api/auth/register") {
    const input = await body(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (!input.firstName || !input.lastName || !input.phone || !email || !input.password || input.password !== input.passwordConfirmation || !input.termsAccepted) {
      return json(res, 400, { error: "Vérifiez vos informations et acceptez les conditions pour continuer." });
    }
    if (String(input.password).length < 8) return json(res, 400, { error: "Le mot de passe doit contenir au moins 8 caractères." });
    if (data.users.some((user) => user.email === email)) return json(res, 409, { error: "Un compte existe déjà avec cet email." });
    const user = {
      id: data.nextUserId++,
      firstName: String(input.firstName).trim(),
      lastName: String(input.lastName).trim(),
      phone: String(input.phone).trim(),
      email,
      passwordHash: hashPassword(String(input.password)),
      gender: input.gender || "autre",
      accountType: input.accountType || "rencontre",
      encounterType: input.encounterType || "tous",
      planType: input.planType || "rencontre_simple",
      profilePhoto: input.profilePhoto || null,
      introductionVideo: input.introductionVideo || null,
      photos: input.profilePhoto ? [input.profilePhoto] : [],
      status: "pending",
      firstLoginVerified: false,
      loginCodeHash: null,
      loginCodeExpiresAt: null,
      termsAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    data.users.push(user);
    writeData(data);
    sendAdminNewRegistration(user).catch((error) => console.error("[email admin]", error.message));
    return json(res, 201, { user: publicUser(user), pendingApproval: true });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const input = await body(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (email === ADMIN_EMAIL && ADMIN_PASSWORD && String(input.password || "") === ADMIN_PASSWORD) {
      setSession(res, { role: "admin", id: 0 });
      return json(res, 200, { role: "admin", user: { firstName: "Équipe", lastName: "Cœur", email: ADMIN_EMAIL, status: "active", accountType: "admin", photoCount: 0 } });
    }
    const user = data.users.find((candidate) => candidate.email === email);
    if (!user || !verifyPassword(String(input.password || ""), user.passwordHash)) return json(res, 401, { error: "Identifiants invalides." });
    if (user.status !== "active") return json(res, 403, { code: "PENDING_APPROVAL", error: "Votre inscription est encore en attente de confirmation par l’administrateur." });
    if (!user.firstLoginVerified) {
      if (!user.loginCodeHash || !user.loginCodeExpiresAt || new Date(user.loginCodeExpiresAt) < new Date()) {
        const code = uniqueCode();
        user.loginCodeHash = codeHash(code);
        user.loginCodeExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        writeData(data);
        sendApprovalEmail(user, code).catch((error) => console.error("[email code]", error.message));
      }
      setSession(res, { role: "pending_2fa", id: user.id });
      return json(res, 200, { role: "user_pending", requiresCode: true, user: publicUser(user) });
    }
    setSession(res, { role: "user", id: user.id });
    return json(res, 200, { role: "user", user: publicUser(user) });
  }

  if (method === "POST" && pathname === "/api/auth/verify-code") {
    const current = session(req);
    if (!current || current.role !== "pending_2fa") return json(res, 401, { error: "Cette vérification a expiré. Recommencez la connexion." });
    const user = data.users.find((candidate) => candidate.id === current.id);
    const input = await body(req);
    if (!user || !/^\d{6}$/.test(String(input.code || ""))) return json(res, 400, { error: "Saisissez un code à 6 chiffres." });
    if (!user.loginCodeExpiresAt || new Date(user.loginCodeExpiresAt) < new Date() || !sameSecret(codeHash(input.code), user.loginCodeHash)) {
      return json(res, 401, { error: "Code incorrect ou expiré." });
    }
    if (!data.usedLoginCodeHashes.includes(user.loginCodeHash)) data.usedLoginCodeHashes.push(user.loginCodeHash);
    user.loginCodeHash = null;
    user.loginCodeExpiresAt = null;
    user.firstLoginVerified = true;
    writeData(data);
    const token = parseCookies(req).cc_session;
    if (token) sessions.set(token, { role: "user", id: user.id });
    return json(res, 200, { role: "user", user: publicUser(user) });
  }

  if (method === "POST" && pathname === "/api/auth/resend-code") {
    const current = session(req);
    if (!current || !["pending_2fa", "user"].includes(current.role)) return json(res, 401, { error: "Session de connexion absente." });
    const user = data.users.find((candidate) => candidate.id === current.id);
    if (!user) return json(res, 404, { error: "Compte introuvable." });
    const code = uniqueCode();
    user.loginCodeHash = codeHash(code);
    user.loginCodeExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    writeData(data);
    try {
      const delivery = await sendApprovalEmail(user, code);
      return json(res, 200, { ok: true, delivery: delivery.mode });
    } catch (error) {
      return json(res, 502, { error: error.message });
    }
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(req).cc_session;
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "cc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/me") {
    const current = session(req);
    if (!current || current.role === "pending_2fa") return json(res, 401, { error: "Session absente." });
    if (current.role === "admin") return json(res, 200, { firstName: "Équipe", lastName: "Cœur", email: ADMIN_EMAIL, status: "active", accountType: "admin", photoCount: 0 });
    return json(res, 200, publicUser(userFromRequest(req)));
  }

  if (method === "GET" && pathname === "/api/announcements") {
    if (!session(req)) return json(res, 401, { error: "Connectez-vous pour continuer." });
    return json(res, 200, data.announcements);
  }

  if (method === "GET" && pathname === "/api/messages") {
    const current = session(req);
    if (!current || current.role === "pending_2fa") return json(res, 401, { error: "Connectez-vous pour continuer." });
    if (current.role === "admin") return json(res, 200, data.messages);
    return json(res, 200, data.messages.filter((message) => message.userId === current.id).map((message) => messageForUser(message, current.id)));
  }

  if (method === "POST" && pathname === "/api/messages") {
    if (!userRequired(req, res)) return;
    const input = await body(req);
    if (!String(input.body || "").trim()) return json(res, 400, { error: "Votre message ne peut pas être vide." });
    const message = { id: data.nextMessageId++, userId: userFromRequest(req).id, senderRole: "user", body: String(input.body).trim(), createdAt: new Date().toISOString(), read: false };
    data.messages.push(message);
    writeData(data);
    return json(res, 201, message);
  }

  if (method === "POST" && pathname === "/api/profile/photos") {
    if (!userRequired(req, res)) return;
    const input = await body(req);
    if (!Array.isArray(input.photos) || input.photos.length !== 3) return json(res, 400, { error: "Ajoutez exactement trois photos." });
    const user = userFromRequest(req);
    user.photos = input.photos;
    user.profilePhoto = input.photos[0];
    writeData(data);
    return json(res, 200, publicUser(user));
  }

  const matchAccept = pathname.match(/^\/api\/matches\/(\d+)\/accept$/);
  if (method === "POST" && matchAccept) {
    if (!userRequired(req, res)) return;
    const id = Number(matchAccept[1]);
    const currentUser = userFromRequest(req);
    const pending = data.messages.some((message) => (message.selectedUserIds || []).includes(id));
    if (!pending) return json(res, 404, { error: "Proposition introuvable." });
    data.matches.filter((match) => match.userId === currentUser.id).forEach((match) => { match.accepted = false; });
    let match = data.matches.find((item) => item.userId === currentUser.id && item.candidateId === id);
    if (!match) {
      match = { id: data.nextMatchId++, userId: currentUser.id, candidateId: id, accepted: true, confirmed: false };
      data.matches.push(match);
    } else match.accepted = true;
    writeData(data);
    return json(res, 200, match);
  }

  if (method === "GET" && pathname === "/api/admin/users") {
    if (!adminRequired(req, res)) return;
    return json(res, 200, data.users.map(publicUser));
  }

  const approve = pathname.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
  if (method === "POST" && approve) {
    if (!adminRequired(req, res)) return;
    const user = data.users.find((candidate) => candidate.id === Number(approve[1]));
    if (!user) return json(res, 404, { error: "Profil introuvable." });
    user.status = "active";
    user.approvedAt = new Date().toISOString();
    user.firstLoginVerified = false;
    const code = uniqueCode();
    user.loginCodeHash = codeHash(code);
    user.loginCodeExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    writeData(data);
    try {
      const delivery = await sendApprovalEmail(user, code);
      return json(res, 200, { user: publicUser(user), delivery: delivery.mode });
    } catch (error) {
      return json(res, 502, { error: `Compte confirmé mais email non envoyé : ${error.message}` });
    }
  }

  if (method === "POST" && pathname === "/api/admin/announcements") {
    if (!adminRequired(req, res)) return;
    const input = await body(req);
    if (!input.title || !input.body) return json(res, 400, { error: "Le titre et le contenu sont requis." });
    const announcement = { id: data.nextAnnouncementId++, title: String(input.title), body: String(input.body), createdAt: new Date().toISOString() };
    data.announcements.unshift(announcement);
    writeData(data);
    return json(res, 201, announcement);
  }

  const reply = pathname.match(/^\/api\/admin\/messages\/(\d+)\/reply$/);
  if (method === "POST" && reply) {
    if (!adminRequired(req, res)) return;
    const input = await body(req);
    const parent = data.messages.find((message) => message.id === Number(reply[1]));
    if (!parent || !String(input.body || "").trim() || !Array.isArray(input.selectedUserIds)) return json(res, 400, { error: "Sélection et message requis." });
    const response = { id: data.nextMessageId++, userId: parent.userId, senderRole: "admin", body: String(input.body), createdAt: new Date().toISOString(), read: false, selectedUserIds: input.selectedUserIds.map(Number) };
    data.messages.push(response);
    writeData(data);
    return json(res, 201, response);
  }

  const confirm = pathname.match(/^\/api\/admin\/matches\/(\d+)\/confirm$/);
  if (method === "POST" && confirm) {
    if (!adminRequired(req, res)) return;
    const match = data.matches.find((item) => item.id === Number(confirm[1]));
    if (!match) return json(res, 404, { error: "Mise en relation introuvable." });
    match.confirmed = true;
    writeData(data);
    return json(res, 200, match);
  }

  return json(res, 404, { error: "Route introuvable." });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return html(res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error instanceof Error ? error.message : "Erreur serveur." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`Cœur & Connexions écoute sur le port ${PORT}\n`);
});