const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const config = require("./config.cjs");

const PORT = config.port;
const DATA_FILE = path.join(__dirname, "data.json");
const INDEX_FILE = path.join(__dirname, "index.html");
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const STEP_TTL = 15 * 60 * 1000;
const MAX_BODY = 10 * 1024 * 1024;
const MAX_PHOTO_CHARS = 2_800_000;
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : Boolean(process.env.RENDER || process.env.NODE_ENV === "production");
const buckets = new Map();
const seed = {
  nextUserId: 1,
  nextMessageId: 1,
  nextAnnouncementId: 2,
  nextEmailLogId: 1,
  users: [],
  messages: [],
  emailLogs: [],
  usedLoginCodeHashes: [],
  mailConfig: { mode: "manual", domain: "", baseUrl: "https://api.mailgun.net", encryptedApiKey: "" },
  announcements: [{
    id: 1,
    title: "Bienvenue dans votre espace privé",
    body: "Votre demande sera étudiée avec attention. L’équipe vous préviendra par email dès qu’elle sera confirmée.",
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
data.emailLogs = Array.isArray(data.emailLogs) ? data.emailLogs : [];
data.announcements = Array.isArray(data.announcements) ? data.announcements : clone(seed.announcements);
data.usedLoginCodeHashes = Array.isArray(data.usedLoginCodeHashes) ? data.usedLoginCodeHashes : [];
data.mailConfig = { ...seed.mailConfig, ...(data.mailConfig || {}) };

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
function setSession(res, value, ttl = SESSION_TTL) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...value, expiresAt: Date.now() + ttl });
  res.setHeader("Set-Cookie", `cc_session=${token}; ${cookieFlags()}; Max-Age=${Math.floor(ttl / 1000)}`);
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
  return current?.role === "user" ? data.users.find((item) => item.id === current.id) : null;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let done = false;
    const fail = (message, status) => { if (done) return; done = true; const error = new Error(message); error.status = status; reject(error); };
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) { fail("Requête trop volumineuse.", 413); req.resume(); return; }
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
function approvalEmail(user, code) {
  const subject = "Votre espace Cœur & Connexions est confirmé";
  const text = [
    "♡ Cœur & Connexions", "",
    "Votre demande est confirmée", "",
    `Bonjour ${user.firstName},`, "",
    "Votre espace est maintenant confirmé par l’équipe. Lors de votre première connexion, saisissez le code secret ci-dessous :", "",
    code, "Ce code est personnel, à usage unique et valable 30 jours. Ne le partagez avec personne.", "",
    "Cœur & Connexions facilite la prise de contact mais ne garantit ni l’identité, ni les intentions, ni le comportement des utilisateurs.",
  ].join("\n");
  return { to: user.email, subject, text, html: `<p>Bonjour ${escapeHtml(user.firstName)},</p><p>Votre espace est confirmé. Votre code de connexion :</p><h2>${code}</h2><p>Ce code est personnel, à usage unique et valable 30 jours.</p>` };
}
function passwordResetEmail(user, code) {
  const subject = "Réinitialisation de votre mot de passe — Cœur & Connexions";
  const text = [
    "♡ Cœur & Connexions", "",
    `Bonjour ${user.firstName},`, "",
    "Vous avez demandé à modifier votre mot de passe. Saisissez le code suivant dans votre espace :", "",
    code, "",
    "Ce code est valable 15 minutes et ne peut être utilisé qu’une seule fois.", "",
    "Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.",
  ].join("\n");
  return { to: user.email, subject, text, html: `<p>Bonjour ${escapeHtml(user.firstName)},</p><p>Votre code de réinitialisation :</p><h2>${code}</h2><p>Ce code est valable 15 minutes et ne peut être utilisé qu’une seule fois.</p>` };
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function mailPublicConfig() {
  return { mode: data.mailConfig.mode, domain: data.mailConfig.domain, baseUrl: data.mailConfig.baseUrl, apiKeyConfigured: Boolean(data.mailConfig.encryptedApiKey) };
}
function normalizedMailInput(input) {
  const mode = input.mode === "mailgun" ? "mailgun" : "manual";
  const baseUrl = String(input.baseUrl || "https://api.mailgun.net").trim().replace(/\/+$/, "");
  const domain = String(input.domain || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  if (mode === "mailgun") {
    if (!apiKey && !data.mailConfig.encryptedApiKey) throw new Error("La clé API Mailgun est requise.");
    if (!domain) throw new Error("Le domaine Mailgun est requis.");
    let parsed;
    try { parsed = new URL(baseUrl); } catch (_error) { throw new Error("L’URL de base Mailgun est invalide."); }
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("L’URL de base doit commencer par http:// ou https://.");
  }
  return { mode, baseUrl, domain, apiKey: apiKey || reveal(data.mailConfig.encryptedApiKey) || "" };
}
async function mailgunRequest(settings, endpoint, options = {}) {
  const response = await fetch(`${settings.baseUrl}${endpoint}`, {
    ...options,
    headers: { Authorization: `Basic ${Buffer.from(`api:${settings.apiKey}`).toString("base64")}`, ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_error) { payload = { message: text }; }
  if (!response.ok) throw new Error(payload.message || `Mailgun a répondu avec le statut ${response.status}.`);
  return payload;
}
async function verifyMailgun(settings) {
  await mailgunRequest(settings, `/v3/domains/${encodeURIComponent(settings.domain)}`);
  return true;
}
async function sendMailgun(settings, email) {
  const form = new URLSearchParams({
    from: `Cœur & Connexions <mailgun@${settings.domain}>`,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  return mailgunRequest(settings, `/v3/${encodeURIComponent(settings.domain)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}
function createEmailLog(email, provider, status, failureReason = null, extra = {}) {
  const log = {
    id: data.nextEmailLogId++,
    provider,
    recipient: email.to,
    subject: email.subject,
    status,
    failureReason,
    createdAt: new Date().toISOString(),
    ...extra,
  };
  data.emailLogs.unshift(log);
  writeData();
  return log;
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
        mail: mailPublicConfig(),
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
      photos: input.profilePhoto ? [input.profilePhoto] : [], status: "pending", firstLoginVerified: false,
      loginCodeHash: secretHash(code), loginCodeExpiresAt: null, pendingLoginCode: protect(code),
      termsAcceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    };
    data.users.push(user); writeData();
    return json(res, 201, { user: publicUser(user), pendingApproval: true });
  }
  if (method === "POST" && pathname === "/api/auth/forgot-password") {
    const input = await readBody(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (limited(req, res, "forgot", { ip: 10, id: 3, windowMs: 900_000 }, email)) return;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "Saisissez une adresse email valide." });
    const generic = { ok: true, message: "Si cette adresse correspond à un compte confirmé, un code de réinitialisation sera envoyé." };
    const user = data.users.find((item) => item.email === email && item.status === "active");
    if (!user) return json(res, 200, generic);
    const code = uniqueCode();
    user.passwordResetCodeHash = secretHash(code);
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    user.passwordResetVerifiedAt = null;
    user.pendingPasswordResetCode = protect(code);
    const emailMessage = passwordResetEmail(user, code);
    writeData();
    if (data.mailConfig.mode === "mailgun") {
      const settings = { ...data.mailConfig, apiKey: reveal(data.mailConfig.encryptedApiKey) };
      try {
        await sendMailgun(settings, emailMessage);
        const emailLog = createEmailLog(emailMessage, "Mailgun", "sent", null, { kind: "password_reset" });
        return json(res, 200, { ...generic, delivery: "automatic", emailLogId: emailLog.id });
      } catch (error) {
        createEmailLog(emailMessage, "Mailgun", "failed", error.message || "Envoi impossible.", { kind: "password_reset" });
        return json(res, 502, { error: `L’envoi du code a échoué : ${error.message || "vérifiez la configuration Mailgun."}` });
      }
    }
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(emailMessage.to)}&su=${encodeURIComponent(emailMessage.subject)}&body=${encodeURIComponent(emailMessage.text)}`;
    const emailLog = createEmailLog(emailMessage, "Envoi manuel", "draft", null, { kind: "password_reset", gmailUrl });
    return json(res, 200, { ...generic, delivery: "manual", emailLogId: emailLog.id });
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
    if (!user || !verifyPassword(String(input.password || ""), user.passwordHash)) return json(res, 401, { error: "Identifiants invalides." });
    if (user.status !== "active") return json(res, 403, { error: "Votre inscription est encore en attente de confirmation par l’administrateur." });
    if (!user.firstLoginVerified) {
      if (!user.loginCodeHash || !user.loginCodeExpiresAt || new Date(user.loginCodeExpiresAt) < new Date()) {
        const code = uniqueCode();
        user.loginCodeHash = secretHash(code);
        user.pendingLoginCode = protect(code);
        user.loginCodeExpiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
        writeData();
      }
      setSession(res, { role: "pending_2fa", id: user.id }, STEP_TTL);
      return json(res, 200, { role: "user_pending", requiresCode: true, user: publicUser(user) });
    }
    setSession(res, { role: "user", id: user.id });
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
    const token = parseCookies(req).cc_session; if (token) sessions.set(token, { role: "user", id: user.id, expiresAt: Date.now() + SESSION_TTL });
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
    const current = getSession(req);
    if (!current || current.role !== "password_reset") return json(res, 401, { error: "Cette vérification a expiré. Recommencez la procédure." });
    const user = data.users.find((item) => item.id === current.id);
    const input = await readBody(req);
    if (!user || !user.passwordResetVerifiedAt || !user.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt) < new Date()) {
      return json(res, 401, { error: "Cette vérification a expiré. Recommencez la procédure." });
    }
    if (String(input.password || "").length < 8) return json(res, 400, { error: "Le nouveau mot de passe doit contenir au moins 8 caractères." });
    if (input.password !== input.passwordConfirmation) return json(res, 400, { error: "Les deux mots de passe ne correspondent pas." });
    user.passwordHash = passwordHash(String(input.password));
    user.passwordResetCodeHash = null;
    user.passwordResetExpiresAt = null;
    user.passwordResetVerifiedAt = null;
    user.pendingPasswordResetCode = null;
    writeData();
    setSession(res, { role: "user", id: user.id });
    return json(res, 200, { ok: true, user: publicUser(user) });
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(req).cc_session; if (token) sessions.delete(token);
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
    if (!adminRequired(req, res)) return; return json(res, 200, data.users.map(publicUser));
  }
  if (method === "GET" && pathname === "/api/admin/email-logs") {
    if (!adminRequired(req, res)) return; return json(res, 200, data.emailLogs);
  }
  if (method === "GET" && pathname === "/api/admin/mail-config") {
    if (!adminRequired(req, res)) return; return json(res, 200, mailPublicConfig());
  }
  if (method === "POST" && pathname === "/api/admin/mail-config/test") {
    if (!adminRequired(req, res)) return;
    try {
      const settings = normalizedMailInput(await readBody(req));
      if (settings.mode === "mailgun") await verifyMailgun(settings);
      data.mailConfig = { mode: settings.mode, domain: settings.domain, baseUrl: settings.baseUrl, encryptedApiKey: settings.apiKey ? protect(settings.apiKey) : data.mailConfig.encryptedApiKey };
      writeData();
      return json(res, 200, { ok: true, message: settings.mode === "mailgun" ? "Connexion Mailgun vérifiée et enregistrée." : "Le mode manuel est enregistré.", config: mailPublicConfig() });
    } catch (error) { return json(res, 400, { error: error.message || "Vérification Mailgun impossible." }); }
  }
  const approve = pathname.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
  if (method === "POST" && approve) {
    if (!adminRequired(req, res)) return;
    const user = data.users.find((item) => item.id === Number(approve[1]));
    if (!user) return json(res, 404, { error: "Profil introuvable." });
    user.status = "active"; user.approvedAt = new Date().toISOString(); user.firstLoginVerified = false;
    const code = reveal(user.pendingLoginCode) || uniqueCode();
    user.loginCodeHash = secretHash(code); user.loginCodeExpiresAt = new Date(Date.now() + 30 * 86400000).toISOString(); user.pendingLoginCode = null;
    const email = approvalEmail(user, code); writeData();
    if (data.mailConfig.mode === "mailgun") {
      const settings = { ...data.mailConfig, apiKey: reveal(data.mailConfig.encryptedApiKey) };
      try {
        await sendMailgun(settings, email);
        const emailLog = createEmailLog(email, "Mailgun", "sent");
        return json(res, 200, { user: publicUser(user), sent: true, emailLog });
      } catch (error) {
        const emailLog = createEmailLog(email, "Mailgun", "failed", error.message || "Envoi impossible.");
        return json(res, 502, { error: `Profil confirmé, mais l’envoi Mailgun a échoué : ${error.message}`, user: publicUser(user), emailLog });
      }
    }
    const emailLog = createEmailLog(email, "Envoi manuel", "draft");
    return json(res, 200, { user: publicUser(user), sent: false, email: { to: email.to, subject: email.subject, body: email.text, gmailUrl: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email.to)}&su=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.text)}` }, emailLog });
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
  return json(res, 404, { error: "Route introuvable." });
}
function serveHtml(res) {
  const body = fs.readFileSync(INDEX_FILE, "utf8");
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
    return serveHtml(res);
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message });
    process.stderr.write(`${error.stack || error}\n`);
    return json(res, 500, { error: "Erreur serveur." });
  }
});
server.listen(PORT, "0.0.0.0", () => process.stdout.write(`Cœur & Connexions écoute sur le port ${PORT}\n`));