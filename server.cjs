const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const config = require("./config.cjs");

const PORT = config.port;
const DATA_FILE = path.join(__dirname, "data.json");
const INDEX_FILE = path.join(__dirname, "index.html");
const SUCCESS_FILE = path.join(__dirname, "success.html");
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const STEP_TTL = 15 * 60 * 1000;
const REMEMBER_TTL = 30 * 24 * 3600 * 1000;
const SHORT_TTL = 12 * 3600 * 1000;
const CODE_TTL = 30 * 86400000;
const RESET_TTL = 60 * 60 * 1000;
const ONLINE_MS = 2 * 60 * 1000;
let presenceDirty = false;
const MAX_BODY = 10 * 1024 * 1024;
const MAX_PHOTO_CHARS = 2_800_000;
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : Boolean(process.env.RENDER || process.env.NODE_ENV === "production");
const buckets = new Map();
const seed = {
  nextUserId: 1,
  nextMessageId: 1,
  nextAnnouncementId: 2,
  users: [],
  messages: [],
  usedLoginCodeHashes: [],
  announcements: [{
    id: 1,
    title: "Bienvenue dans votre espace privé",
    body: "Votre compte est actif dès l’inscription. Conservez précieusement le code secret affiché à la fin de votre inscription : il vous sera demandé lors de votre première connexion.",
    createdAt: new Date().toISOString(),
  }],
};

if (!config.sessionSecret) {
  process.stderr.write("SESSION_SECRET est obligatoire avant de démarrer le serveur.\n");
  process.exit(1);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((item) => item.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || "unknown");
}
function hit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) { bucket = { count: 0, reset: now + windowMs }; buckets.set(key, bucket); }
  bucket.count += 1;
  return bucket.count <= max ? 0 : Math.ceil((bucket.reset - now) / 1000);
}
function limited(req, res, name, limits, id) {
  let wait = hit(`${name}:ip:${clientIp(req)}`, limits.ip, limits.windowMs);
  if (id && limits.id) wait = Math.max(wait, hit(`${name}:id:${id}`, limits.id, limits.windowMs));
  if (!wait) return false;
  res.setHeader("Retry-After", String(wait));
  json(res, 429, { error: "Trop de tentatives. Réessayez dans quelques minutes." });
  return true;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] !== "cross-site";
  try { return new URL(origin).host === req.headers.host; } catch (_error) { return false; }
}
function safeEqual(a, b) {
  const x = crypto.createHmac("sha256", config.sessionSecret).update(String(a)).digest();
  const y = crypto.createHmac("sha256", config.sessionSecret).update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function validPhoto(value) {
  const text = String(value || "");
  return text.length <= MAX_PHOTO_CHARS && /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(text);
}
const PHOTO_ERROR = "Chaque photo doit être une image JPEG, PNG, WebP ou GIF de 2 Mo maximum.";
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function readData() {
  try { return { ...clone(seed), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; }
  catch (_error) { return clone(seed); }
}
function writeData() {
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
let data = readData();
data.users = Array.isArray(data.users) ? data.users : [];
data.messages = Array.isArray(data.messages) ? data.messages : [];
data.announcements = Array.isArray(data.announcements) ? data.announcements : clone(seed.announcements);
data.usedLoginCodeHashes = Array.isArray(data.usedLoginCodeHashes) ? data.usedLoginCodeHashes : [];
const plans = require("./plans.cjs")({ data, writeData, json, readBody, getSession, currentUser, adminRequired, userRequired, limited, config });
setInterval(() => { if (presenceDirty) { presenceDirty = false; try { writeData(); } catch (_error) {} } }, 60 * 1000).unref();
function markOnline(user) { user.lastLoginAt = new Date().toISOString(); user.lastSeenAt = Date.now(); user.loggedOutAt = null; writeData(); }
function markOffline(userId) { const user = data.users.find((item) => item.id === userId); if (user) { user.loggedOutAt = new Date().toISOString(); writeData(); } }
function digits(value) { return String(value || "").replace(/\D/g, ""); }
function samePhone(a, b) {
  const x = digits(a).replace(/^0+/, ""), y = digits(b).replace(/^0+/, "");
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && (short === long || long.endsWith(short));
}
function holdUserSessions(user) {
  for (const [token, value] of sessions) if (value.role === "user" && value.id === user.id) sessions.delete(token);
  user.loggedOutAt = new Date().toISOString();
}
function presenceOf(user) {
  const seen = user.lastSeenAt || 0;
  const online = Boolean(!user.loggedOutAt && seen && Date.now() - seen < ONLINE_MS);
  const offlineSince = online ? null : (user.loggedOutAt || (seen ? new Date(seen).toISOString() : null));
  return { online, offlineSince, neverConnected: !user.lastLoginAt };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function secretHash(value) {
  return crypto.createHmac("sha256", config.sessionSecret).update(String(value)).digest("hex");
}
function codeCipherKey() {
  return crypto.createHash("sha256").update(config.sessionSecret).digest();
}
function protect(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", codeCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}
function reveal(value) {
  const [iv, tag, encrypted] = String(value || "").split(":");
  if (!iv || !tag || !encrypted) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", codeCipherKey(), Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]).toString("utf8");
  } catch (_error) { return null; }
}
function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((out, part) => {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return out;
  }, {});
}
const cookieFlags = () => `HttpOnly; SameSite=Lax; Path=/${COOKIE_SECURE ? "; Secure" : ""}`;
function setSession(res, value, ttl = SESSION_TTL, persistent = true) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...value, expiresAt: Date.now() + ttl });
  res.setHeader("Set-Cookie", `cc_session=${token}; ${cookieFlags()}${persistent ? `; Max-Age=${Math.floor(ttl / 1000)}` : ""}`);
}
function getSession(req) {
  const token = parseCookies(req).cc_session;
  const current = token ? sessions.get(token) : null;
  if (current && current.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return current || null;
}
setInterval(() => {
  const now = Date.now();
  for (const [token, value] of sessions) if (value.expiresAt < now) sessions.delete(token);
  for (const [key, bucket] of buckets) if (bucket.reset < now) buckets.delete(key);
}, 10 * 60 * 1000).unref();
function currentUser(req) {
  const current = getSession(req);
  const user = current?.role === "user" ? data.users.find((item) => item.id === current.id) : null;
  if (user) { user.lastSeenAt = Date.now(); presenceDirty = true; }
  return user || null;
}
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let done = false;
    const fail = (message, status) => { if (done) return; done = true; const error = new Error(message); error.status = status; reject(error); };
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > max) { fail("Requête trop volumineuse.", 413); req.resume(); return; }
      raw += chunk;
    });
    req.on("end", () => {
      if (done) return;
      try { done = true; resolve(raw ? JSON.parse(raw) : {}); } catch (_error) { done = false; fail("JSON invalide.", 400); }
    });
    req.on("error", reject);
  });
}
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email,
    phone: user.phone, gender: user.gender, accountType: user.accountType,
    encounterType: user.encounterType, planType: user.planType, photoCount: user.photos?.length || 0,
    profilePhoto: user.profilePhoto || null, status: user.status, firstLoginVerified: Boolean(user.firstLoginVerified),
    createdAt: user.createdAt, approvedAt: user.approvedAt || null,
  };
}
function uniqueCode() {
  let code;
  do { code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"); }
  while (data.users.some((item) => item.loginCodeHash === secretHash(code)) || data.usedLoginCodeHashes.includes(secretHash(code)));
  return code;
}
function adminRequired(req, res) {
  const current = getSession(req);
  if (!current || current.role !== "admin") { json(res, 401, { error: "Accès administrateur requis." }); return false; }
  return true;
}
function userRequired(req, res) {
  if (!currentUser(req)) { json(res, 401, { error: "Connectez-vous pour continuer." }); return false; }
  return true;
}
async function api(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  if (method === "GET" && pathname === "/api/health") {
    return json(res, 200, {
      status: "ok",
      config: {
        adminEmailConfigured: Boolean(config.adminEmail),
        adminPasswordConfigured: Boolean(config.adminPassword),
        sessionSecretConfigured: Boolean(config.sessionSecret),
      },
    });
  }
  if (method === "POST" && pathname === "/api/auth/register") {
    if (limited(req, res, "register", { ip: 10, windowMs: 3600_000 })) return;
    const input = await readBody(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (!input.firstName || !input.lastName || !input.phone || !email || !input.password || input.password !== input.passwordConfirmation || !input.termsAccepted) {
      return json(res, 400, { error: "Vérifiez vos informations et acceptez les conditions pour continuer." });
    }
    if (!input.profilePhoto) return json(res, 400, { error: "Une photo de profil est obligatoire pour créer votre compte." });
    if (!validPhoto(input.profilePhoto)) return json(res, 400, { error: PHOTO_ERROR });
    if (String(input.password).length < 8) return json(res, 400, { error: "Le mot de passe doit contenir au moins 8 caractères." });
    if (data.users.some((item) => item.email === email)) return json(res, 409, { error: "Un compte existe déjà avec cet email." });
    const code = uniqueCode();
    const user = {
      id: data.nextUserId++, firstName: String(input.firstName).trim(), lastName: String(input.lastName).trim(),
      phone: String(input.phone).trim(), email, passwordHash: passwordHash(String(input.password)),
      gender: input.gender || "autre", encounterType: input.encounterType || "tous", accountType: input.accountType || "rencontre",
      planType: input.planType || "rencontre_simple", profilePhoto: input.profilePhoto || null,
      photos: input.profilePhoto ? [input.profilePhoto] : [], status: "active", approvedAt: new Date().toISOString(), firstLoginVerified: false,
      loginCodeHash: secretHash(code), loginCodeExpiresAt: new Date(Date.now() + CODE_TTL).toISOString(), pendingLoginCode: null,
      termsAcceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    };
    data.users.push(user); writeData();
    return json(res, 201, { user: publicUser(user), loginCode: code });
  }
  if (method === "POST" && pathname === "/api/auth/forgot-password") {
    const input = await readBody(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (limited(req, res, "forgot", { ip: 10, id: 5, windowMs: 900_000 }, email)) return;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "Saisissez une adresse email valide." });
    const user = data.users.find((item) => item.email === email && item.status === "active");
    if (!user || !samePhone(input.phone, user.phone)) return json(res, 401, { error: "Ces informations ne correspondent à aucun compte." });
    const code = uniqueCode();
    user.passwordResetCodeHash = secretHash(code);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_TTL).toISOString();
    user.passwordResetVerifiedAt = null;
    user.pendingPasswordResetCode = null;
    writeData();
    return json(res, 200, { ok: true, resetCode: code });
  }
  if (method === "POST" && pathname === "/api/auth/login") {
    const input = await readBody(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (limited(req, res, "login", { ip: 30, id: 10, windowMs: 900_000 }, email)) return;
    const isAdminEmail = Boolean(config.adminEmail) && email === config.adminEmail;
    if (isAdminEmail && !config.adminPassword) return json(res, 503, { error: "ADMIN_PASSWORD n’est pas configuré sur le serveur." });
    if (isAdminEmail && safeEqual(input.password || "", config.adminPassword)) {
      setSession(res, { role: "admin", id: 0 });
      return json(res, 200, { role: "admin", user: { firstName: "Équipe", lastName: "Cœur", email: config.adminEmail, accountType: "admin" } });
    }
    if (isAdminEmail) return json(res, 401, { error: "Identifiants invalides." });
    const user = data.users.find((item) => item.email === email);
    if (!user) return json(res, 401, { error: "Identifiants invalides." });
    const password = String(input.password || "");
    const oldMatches = verifyPassword(password, user.passwordHash);
    if (user.pendingPasswordHash) {
      if (oldMatches || verifyPassword(password, user.pendingPasswordHash)) return json(res, 403, { error: "Votre compte est en attente de confirmation par l’administrateur après la réinitialisation du mot de passe." });
      return json(res, 401, { error: "Identifiants invalides." });
    }
    if (!oldMatches) return json(res, 401, { error: "Identifiants invalides." });
    if (user.status !== "active") { user.status = "active"; user.approvedAt = new Date().toISOString(); user.firstLoginVerified = false; }
    const remember = input.remember === true;
    if (!user.firstLoginVerified) {
      if (!user.loginCodeHash || !user.loginCodeExpiresAt || new Date(user.loginCodeExpiresAt) < new Date()) {
        const code = uniqueCode();
        user.loginCodeHash = secretHash(code);
        user.pendingLoginCode = protect(code);
        user.loginCodeExpiresAt = new Date(Date.now() + CODE_TTL).toISOString();
      }
      let loginCode = null;
      if (user.pendingLoginCode) { loginCode = reveal(user.pendingLoginCode); user.pendingLoginCode = null; }
      writeData();
      setSession(res, { role: "pending_2fa", id: user.id, remember }, STEP_TTL);
      return json(res, 200, { role: "user_pending", requiresCode: true, loginCode, user: publicUser(user) });
    }
    setSession(res, { role: "user", id: user.id }, remember ? REMEMBER_TTL : SHORT_TTL, remember);
    markOnline(user);
    return json(res, 200, { role: "user", user: publicUser(user) });
  }
  if (method === "POST" && pathname === "/api/auth/verify-code") {
    const current = getSession(req);
    if (!current || current.role !== "pending_2fa") return json(res, 401, { error: "Cette vérification a expiré. Recommencez la connexion." });
    const user = data.users.find((item) => item.id === current.id);
    const input = await readBody(req);
    if (limited(req, res, "code", { ip: 20, id: 5, windowMs: 900_000 }, `u${current.id}`)) return;
    if (!user || !/^\d{6}$/.test(String(input.code || ""))) return json(res, 400, { error: "Saisissez un code à 6 chiffres." });
    if (!user.loginCodeExpiresAt || new Date(user.loginCodeExpiresAt) < new Date() || secretHash(input.code) !== user.loginCodeHash) return json(res, 401, { error: "Code incorrect ou expiré." });
    data.usedLoginCodeHashes.push(user.loginCodeHash);
    user.loginCodeHash = null; user.loginCodeExpiresAt = null; user.firstLoginVerified = true; writeData();
    const old = parseCookies(req).cc_session; if (old) sessions.delete(old);
    setSession(res, { role: "user", id: user.id }, current.remember ? REMEMBER_TTL : SHORT_TTL, Boolean(current.remember));
    markOnline(user);
    return json(res, 200, { role: "user", user: publicUser(user) });
  }
  if (method === "POST" && pathname === "/api/auth/verify-reset-code") {
    const input = await readBody(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (limited(req, res, "reset", { ip: 20, id: 5, windowMs: 900_000 }, email)) return;
    const user = data.users.find((item) => item.email === email && item.status === "active");
    if (!user || !/^\d{6}$/.test(String(input.code || "")) || !user.passwordResetCodeHash || !user.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt) < new Date() || secretHash(input.code) !== user.passwordResetCodeHash) {
      return json(res, 401, { error: "Code incorrect ou expiré." });
    }
    user.passwordResetVerifiedAt = new Date().toISOString();
    writeData();
    setSession(res, { role: "password_reset", id: user.id }, STEP_TTL);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && pathname === "/api/auth/reset-password") {
    const token = parseCookies(req).cc_session;
    const current = getSession(req);
    if (!current || current.role !== "password_reset") return json(res, 401, { error: "Cette vérification a expiré. Recommencez la procédure." });
    const user = data.users.find((item) => item.id === current.id);
    const input = await readBody(req);
    if (!user || !user.passwordResetVerifiedAt || !user.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt) < new Date()) {
      return json(res, 401, { error: "Cette vérification a expiré. Recommencez la procédure." });
    }
    if (String(input.password || "").length < 8) return json(res, 400, { error: "Le nouveau mot de passe doit contenir au moins 8 caractères." });
    if (input.password !== input.passwordConfirmation) return json(res, 400, { error: "Les deux mots de passe ne correspondent pas." });
    const whatsappReady = config.adminWhatsapp.length >= 8;
    user.passwordResetCodeHash = null;
    user.passwordResetExpiresAt = null;
    user.passwordResetVerifiedAt = null;
    user.pendingPasswordResetCode = null;
    if (whatsappReady) {
      user.pendingPasswordHash = passwordHash(String(input.password));
      user.passwordChangeRequestedAt = new Date().toISOString();
    } else {
      user.passwordHash = passwordHash(String(input.password));
      user.pendingPasswordHash = null;
      user.passwordChangeRequestedAt = null;
    }
    holdUserSessions(user);
    writeData();
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", `cc_session=; ${cookieFlags()}; Max-Age=0`);
    if (!whatsappReady) return json(res, 200, { ok: true, applied: true, whatsapp: null });
    const text = `Bonjour, j’ai demandé un nouveau mot de passe sur Cœur & Connexions. Nom : ${user.firstName} ${user.lastName}. E-mail : ${user.email}. Merci de le confirmer.`;
    return json(res, 200, { ok: true, pendingAdmin: true, whatsapp: `https://wa.me/${config.adminWhatsapp}?text=${encodeURIComponent(text)}` });
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(req).cc_session; const ended = token ? sessions.get(token) : null; if (ended?.role === "user") markOffline(ended.id); if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", `cc_session=; ${cookieFlags()}; Max-Age=0`);
    return json(res, 200, { ok: true });
  }
  if (method === "GET" && pathname === "/api/me") {
    const current = getSession(req);
    if (!current || current.role === "pending_2fa") return json(res, 401, { error: "Session absente." });
    if (current.role === "admin") return json(res, 200, { firstName: "Équipe", lastName: "Cœur", email: config.adminEmail, accountType: "admin", status: "active" });
    return json(res, 200, publicUser(currentUser(req)));
  }
  if (method === "GET" && pathname === "/api/announcements") {
    if (!getSession(req)) return json(res, 401, { error: "Connectez-vous pour continuer." });
    return json(res, 200, data.announcements);
  }
  if (method === "GET" && pathname === "/api/messages") {
    const current = getSession(req);
    if (!current || current.role === "pending_2fa") return json(res, 401, { error: "Connectez-vous pour continuer." });
    return json(res, 200, current.role === "admin" ? data.messages : data.messages.filter((item) => item.userId === current.id));
  }
  if (method === "POST" && pathname === "/api/messages") {
    if (!userRequired(req, res)) return;
    const input = await readBody(req);
    if (!String(input.body || "").trim()) return json(res, 400, { error: "Votre message ne peut pas être vide." });
    const message = { id: data.nextMessageId++, userId: currentUser(req).id, senderRole: "user", body: String(input.body).trim(), createdAt: new Date().toISOString() };
    data.messages.push(message); writeData(); return json(res, 201, message);
  }
  if (method === "POST" && pathname === "/api/profile/photos") {
    if (!userRequired(req, res)) return;
    const input = await readBody(req);
    if (!Array.isArray(input.photos) || input.photos.length !== 3) return json(res, 400, { error: "Ajoutez exactement trois photos." });
    if (!input.photos.every(validPhoto)) return json(res, 400, { error: PHOTO_ERROR });
    const user = currentUser(req); user.photos = input.photos; user.profilePhoto = input.photos[0]; writeData();
    return json(res, 200, publicUser(user));
  }
  if (method === "GET" && pathname === "/api/admin/users") {
    if (!adminRequired(req, res)) return; return json(res, 200, data.users.map((u) => ({ ...publicUser(u), profilePhoto: null, passwordChangePending: Boolean(u.pendingPasswordHash), ...presenceOf(u) })));
  }
  if (method === "GET" && pathname === "/api/admin/password-requests") {
    if (!adminRequired(req, res)) return;
    return json(res, 200, data.users.filter((u) => u.pendingPasswordHash)
      .map((u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone, requestedAt: u.passwordChangeRequestedAt || null })));
  }
  const pwDecision = pathname.match(/^\/api\/admin\/password-requests\/(\d+)\/(confirm|reject)$/);
  if (method === "POST" && pwDecision) {
    if (!adminRequired(req, res)) return;
    const user = data.users.find((item) => item.id === Number(pwDecision[1]));
    if (!user || !user.pendingPasswordHash) return json(res, 404, { error: "Demande introuvable." });
    if (pwDecision[2] === "confirm") {
      user.passwordHash = user.pendingPasswordHash;
      holdUserSessions(user);
    }
    user.pendingPasswordHash = null;
    user.passwordChangeRequestedAt = null;
    writeData();
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && pathname === "/api/admin/announcements") {
    if (!adminRequired(req, res)) return;
    const input = await readBody(req);
    if (!input.title || !input.body) return json(res, 400, { error: "Le titre et le contenu sont requis." });
    const item = { id: data.nextAnnouncementId++, title: String(input.title), body: String(input.body), createdAt: new Date().toISOString() };
    data.announcements.unshift(item); writeData(); return json(res, 201, item);
  }
  const reply = pathname.match(/^\/api\/admin\/messages\/(\d+)\/reply$/);
  if (method === "POST" && reply) {
    if (!adminRequired(req, res)) return;
    const input = await readBody(req);
    const parent = data.messages.find((item) => item.id === Number(reply[1]));
    if (!parent || !String(input.body || "").trim()) return json(res, 400, { error: "Le message est requis." });
    const message = { id: data.nextMessageId++, userId: parent.userId, senderRole: "admin", body: String(input.body).trim(), createdAt: new Date().toISOString() };
    data.messages.push(message); writeData(); return json(res, 201, message);
  }
  if (await plans.handle(req, res, url)) return;
  return json(res, 404, { error: "Route introuvable." });
}
function serveHtml(res, file = INDEX_FILE) {
  const body = fs.readFileSync(file, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json(res, 403, { error: "Origine non autorisée." });
      return await api(req, res, url);
    }
    if (url.pathname === "/success.html" || url.pathname === "/success") return serveHtml(res, SUCCESS_FILE);
    return serveHtml(res);
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message });
    process.stderr.write(`${error.stack || error}\n`);
    return json(res, 500, { error: "Erreur serveur." });
  }
});
server.listen(PORT, "0.0.0.0", () => process.stdout.write(`Cœur & Connexions écoute sur le port ${PORT}\n`));