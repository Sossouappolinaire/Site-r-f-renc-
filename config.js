/**
 * Configuration centralisée.
 *
 * Les valeurs sensibles doivent être ajoutées dans les secrets de
 * l’hébergeur (Render, Replit, Railway, etc.), jamais dans ce fichier.
 */
module.exports = {
  port: Number(process.env.PORT || 10000),
  resendApiKey: String(process.env.RESEND_API_KEY || ""),
  emailFrom: String(process.env.EMAIL_FROM || "Cœur & Connexions <onboarding@resend.dev>"),
  adminEmail: String(process.env.ADMIN_EMAIL || "sossoukouam@gmail.com").toLowerCase(),
  adminPassword: String(process.env.ADMIN_PASSWORD || ""),
  sessionSecret: String(process.env.SESSION_SECRET || "change-me-before-production")
};