const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const XLSX = require("xlsx");
const config = require("./config");

const PORT = config.port;
const ADMIN_EMAIL = config.adminEmail;
const ADMIN_PASSWORD = config.adminPassword;
const SESSION_SECRET = config.sessionSecret;
const DATA_FILE = path.join(__dirname, "data.json");
const INDEX_FILE = path.join(__dirname, "index.html");
const sessions = new Map();

const seed = {
  nextUserId: 1,
  nextMessageId: 1,
  nextAnnouncementId: 2,
  nextMatchId: 1,
  nextEmailLogId: 1,
  users: [],
  messages: [],
  emailLogs: [],
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
data.emailLogs = Array.isArray(data.emailLogs) ? data.emailLogs : [];
data.nextEmailLogId = Number(data.nextEmailLogId || 1);

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

function protectCode(code) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(SESSION_SECRET).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(String(code), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

function revealCode(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || "").split(":");
  if (!ivHex || !tagHex || !encryptedHex) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(SESSION_SECRET).digest(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf8");
  } catch (_error) {
    return null;
  }
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

function approvalEmail(user, code) {
  const subject = "Votre espace Cœur & Connexions est confirmé";
  const body = [
    "♡ Cœur & Connexions",
    "",
    "Votre demande est confirmée",
    "",
    `Bonjour ${user.firstName},`,
    "",
    "Votre espace est maintenant confirmé par l’équipe. Lors de votre première connexion, saisissez le code secret ci-dessous :",
    "",
    code,
    "Ce code est personnel, à usage unique et valable 30 jours. Ne le partagez avec personne.",
    "",
    "En continuant, vous confirmez accepter les conditions de discrétion, de respect et de responsabilité présentées lors de votre inscription.",
    "",
    "Cœur & Connexions facilite la prise de contact mais ne garantit ni l’identité, ni les intentions, ni le comportement des utilisateurs. Chaque personne reste responsable de ses échanges et de ses décisions. L’administrateur n’est pas partie aux relations, conversations ou engagements entre utilisateurs. En cas de problème, utilisez le signalement depuis votre espace et contactez les autorités compétentes si nécessaire."
  ].join("\n");
  return {
    to: user.email,
    subject,
    body,
    gmailUrl: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(user.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  };
}

function createEmailLog(email, status = "draft", failureReason = null) {
  const log = {
    id: data.nextEmailLogId++,
    provider: "Gmail manuel",
    recipient: email.to,
    subject: email.subject,
    status,
    failureReason,
    createdAt: new Date().toISOString()
  };
  data.emailLogs.unshift(log);
  writeData(data);
  return log;
}

const userExportColumns = [
  "id", "firstName", "lastName", "phone", "email", "gender",
  "accountType", "encounterType", "planType", "profilePhoto",
  "introductionVideo", "photos", "status", "firstLoginVerified",
  "termsAcceptedAt", "createdAt", "approvedAt"
];

function exportableUser(user) {
  return {
    id: user.id,
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    phone: user.phone || "",
    email: user.email || "",
    gender: user.gender || "",
    accountType: user.accountType || "",
    encounterType: user.encounterType || "",
    planType: user.planType || "",
    profilePhoto: user.profilePhoto || "",
    introductionVideo: user.introductionVideo || "",
    photos: JSON.stringify(user.photos || []),
    status: user.status || "pending",
    firstLoginVerified: Boolean(user.firstLoginVerified),
    termsAcceptedAt: user.termsAcceptedAt || "",
    createdAt: user.createdAt || "",
    approvedAt: user.approvedAt || ""
  };
}

function workbookFromUsers(users) {
  const sheet = XLSX.utils.json_to_sheet(users.map(exportableUser), { header: userExportColumns });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Utilisateurs");
  return workbook;
}

function workbookRowsFromBase64(dataBase64) {
  const raw = String(dataBase64 || "").replace(/^data:.*?;base64,/, "");
  if (!raw) throw new Error("Fichier Excel vide.");
  const workbook = XLSX.read(Buffer.from(raw, "base64"), { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Aucune feuille Excel trouvée.");
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("Le fichier Excel ne contient aucune ligne.");
  return rows;
}

function importValue(row, names) {
  const key = names.find((name) => Object.prototype.hasOwnProperty.call(row, name));
  return key ? row[key] : "";
}

function importPhotos(value) {
  if (Array.isArray(value)) return value;
  if (!String(value || "").trim()) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function mergeImportedUser(row, existing) {
  const isNew = !existing;
  const email = String(importValue(row, ["email", "Email", "EMAIL"])).trim().toLowerCase();
  const firstName = String(importValue(row, ["firstName", "Prénom", "prenom"])).trim();
  const lastName = String(importValue(row, ["lastName", "Nom", "nom"])).trim();
  if (!email || !firstName || !lastName) return { error: "Chaque ligne doit contenir un prénom, un nom et un email." };
  const target = existing || {
    id: data.nextUserId++,
    passwordHash: hashPassword(crypto.randomBytes(24).toString("hex")),
    loginCodeHash: null,
    loginCodeExpiresAt: null,
    pendingLoginCode: null,
    firstLoginVerified: false,
    termsAcceptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  target.firstName = firstName;
  target.lastName = lastName;
  target.phone = String(importValue(row, ["phone", "Téléphone", "telephone"])).trim();
  target.email = email;
  target.gender = String(importValue(row, ["gender", "Genre", "genre"]) || "autre");
  target.accountType = String(importValue(row, ["accountType", "Type de compte"]) || "rencontre");
  target.encounterType = String(importValue(row, ["encounterType", "Recherche", "recherche"]) || "tous");
  target.planType = String(importValue(row, ["planType", "Formule", "formule"]) || "rencontre_simple");
  target.profilePhoto = String(importValue(row, ["profilePhoto", "Photo de profil"]) || "") || null;
  target.introductionVideo = String(importValue(row, ["introductionVideo", "Vidéo"]) || "") || null;
  target.photos = importPhotos(importValue(row, ["photos", "Photos"])) ;
  if (!target.profilePhoto && target.photos[0]) target.profilePhoto = target.photos[0];
  const status = String(importValue(row, ["status", "Statut", "statut"]) || target.status || "pending").toLowerCase();
  target.status = isNew ? "pending" : (["pending", "active"].includes(status) ? status : "pending");
  target.firstLoginVerified = ["true", "1", "oui", "yes"].includes(String(importValue(row, ["firstLoginVerified", "Première connexion vérifiée"])).toLowerCase());
  target.termsAcceptedAt = String(importValue(row, ["termsAcceptedAt", "Conditions acceptées"]) || target.termsAcceptedAt);
  target.createdAt = String(importValue(row, ["createdAt", "Date de création"]) || target.createdAt);
  target.approvedAt = String(importValue(row, ["approvedAt", "Date de confirmation"]) || "") || null;
  if (isNew) {
    target.firstLoginVerified = false;
    target.approvedAt = null;
    target.loginCodeHash = null;
    target.loginCodeExpiresAt = null;
    target.pendingLoginCode = null;
  }
  return { user: target, created: !existing };
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
        sessionSecretConfigured: Boolean(SESSION_SECRET && SESSION_SECRET !== "change-me-before-production"),
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
    const registrationCode = uniqueCode();
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
      loginCodeHash: codeHash(registrationCode),
      loginCodeExpiresAt: null,
      pendingLoginCode: protectCode(registrationCode),
      termsAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    data.users.push(user);
    writeData(data);
    return json(res, 201, { user: publicUser(user), pendingApproval: true });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const input = await body(req);
    const email = String(input.email || "").trim().toLowerCase();
    if (email === ADMIN_EMAIL && !ADMIN_PASSWORD) {
      return json(res, 503, { code: "ADMIN_NOT_CONFIGURED", error: "Le compte administrateur est détecté, mais ADMIN_PASSWORD n’est pas chargé sur le serveur Render." });
    }
    if (email === ADMIN_EMAIL && String(input.password || "") === ADMIN_PASSWORD) {
      setSession(res, { role: "admin", id: 0 });
      return json(res, 200, { role: "admin", user: { firstName: "Équipe", lastName: "Cœur", email: ADMIN_EMAIL, status: "active", accountType: "admin", photoCount: 0 } });
    }
    if (email === ADMIN_EMAIL) {
      return json(res, 401, { code: "ADMIN_PASSWORD_INVALID", error: "Le mot de passe administrateur ne correspond pas à ADMIN_PASSWORD." });
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
    const code = revealCode(user.pendingLoginCode) || uniqueCode();
    user.loginCodeHash = codeHash(code);
    user.loginCodeExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    user.pendingLoginCode = null;
    writeData(data);
    const email = approvalEmail(user, code);
    const emailLog = createEmailLog(email);
    return json(res, 200, { user: publicUser(user), email, emailLog });
  }

  if (method === "GET" && pathname === "/api/admin/email-logs") {
    if (!adminRequired(req, res)) return;
    return json(res, 200, data.emailLogs);
  }

  if (method === "GET" && pathname === "/api/admin/users/export") {
    if (!adminRequired(req, res)) return;
    const workbook = workbookFromUsers(data.users);
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="coeur-connexions-utilisateurs.xlsx"',
      "Content-Length": buffer.length,
      "Cache-Control": "no-store"
    });
    return res.end(buffer);
  }

  if (method === "POST" && pathname === "/api/admin/users/import-preview") {
    if (!adminRequired(req, res)) return;
    try {
      const input = await body(req);
      const rows = workbookRowsFromBase64(input.dataBase64);
      return json(res, 200, {
        fileName: String(input.fileName || "import.xlsx"),
        rowCount: rows.length,
        columns: Object.keys(rows[0] || {}),
        sample: rows.slice(0, 3).map((row) => ({
          firstName: importValue(row, ["firstName", "Prénom", "prenom"]),
          lastName: importValue(row, ["lastName", "Nom", "nom"]),
          email: importValue(row, ["email", "Email", "EMAIL"])
        }))
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "Fichier Excel invalide." });
    }
  }

  if (method === "POST" && pathname === "/api/admin/users/import") {
    if (!adminRequired(req, res)) return;
    try {
      const input = await body(req);
      const rows = workbookRowsFromBase64(input.dataBase64);
      let created = 0;
      let updated = 0;
      const errors = [];
      rows.forEach((row, index) => {
        const id = Number(importValue(row, ["id", "ID"]));
        const email = String(importValue(row, ["email", "Email", "EMAIL"])).trim().toLowerCase();
        const existing = data.users.find((user) => (id && user.id === id) || (email && user.email === email));
        const result = mergeImportedUser(row, existing);
        if (result.error) {
          errors.push(`Ligne ${index + 2} : ${result.error}`);
          return;
        }
        if (result.created) {
          data.users.push(result.user);
          created += 1;
        } else {
          updated += 1;
        }
      });
      writeData(data);
      return json(res, 200, { imported: created + updated, created, updated, errors });
    } catch (error) {
      return json(res, 400, { error: error.message || "Import Excel impossible." });
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