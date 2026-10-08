module.exports = {
  port: Number(process.env.PORT || 8080),
  adminEmail: String(process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
  adminPassword: String(process.env.ADMIN_PASSWORD || ""),
  adminWhatsapp: String(process.env.ADMIN_WHATSAPP || "").replace(/\D/g, ""),
  sessionSecret: String(process.env.SESSION_SECRET || ""),
};