/**
 * email-verify — static lists (role accounts, free mailbox providers,
 * disposable domains). Deliberately small and hand-curated: the upstream
 * Rust tool embeds a 55k-domain disposable list, which is a data file
 * concern, not a code concern. Extend here or via EMAIL_VERIFY_EXTRA_DISPOSABLE.
 */

const ROLE_ACCOUNTS = new Set([
  "abuse", "admin", "administrador", "administrator", "alerts", "all", "billing", "careers",
  "compras", "contact", "contacto", "customerservice", "dev", "developer", "devnull",
  "facturacion", "finance", "ftp", "help", "hostmaster", "info", "informes", "inquiries",
  "investors", "jobs", "legal", "list", "mail", "mailer-daemon", "marketing", "media",
  "news", "newsletter", "no-reply", "noreply", "nobody", "notifications", "office",
  "operations", "orders", "pedidos", "postmaster", "press", "privacy", "recepcion",
  "recursoshumanos", "remove", "reply", "rh", "root", "sales", "security", "service",
  "servicio", "soporte", "spam", "support", "sysadmin", "team", "test", "unsubscribe",
  "usenet", "uucp", "ventas", "webmaster", "www",
]);

const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "hotmail.com.mx", "hotmail.fr",
  "outlook.com", "outlook.es", "outlook.com.mx", "live.com", "live.com.mx", "live.mx", "msn.com",
  "yahoo.com", "yahoo.com.mx", "yahoo.es", "ymail.com", "rocketmail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "protonmail.com", "proton.me", "pm.me", "prodigy.net.mx", "infinitum.com.mx",
  "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "terra.com.mx",
]);

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com", "anonbox.net",
  "burnermail.io", "byom.de", "dispostable.com", "dropmail.me", "emailondeck.com", "fakeinbox.com",
  "getairmail.com", "getnada.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
  "guerrillamailblock.com", "harakirimail.com", "inboxkitten.com", "jetable.org", "mail-temp.com",
  "mail7.io", "maildrop.cc", "mailinator.com", "mailinator.net", "mailnesia.com", "mailsac.com",
  "minutemail.com", "mintemail.com", "mohmal.com", "moakt.com", "mytemp.email", "nada.email",
  "sharklasers.com", "spam4.me", "spamgourmet.com", "tempail.com", "temp-mail.io", "temp-mail.org",
  "tempmail.com", "tempmail.net", "tempmailo.com", "tempr.email", "throwawaymail.com",
  "trashmail.com", "trashmail.de", "trashmail.net", "yopmail.com", "yopmail.fr", "yopmail.net",
  "mailcatch.com", "spambox.us", "grr.la", "pokemail.net", "spam.la", "tmpmail.org", "tmpmail.net",
]);

function extraDisposable(): Set<string> {
  const raw = process.env.EMAIL_VERIFY_EXTRA_DISPOSABLE ?? "";
  return new Set(raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean));
}

export function isRoleAccount(localPart: string): boolean {
  return ROLE_ACCOUNTS.has(localPart.toLowerCase());
}

export function isFreeProvider(domain: string): boolean {
  return FREE_PROVIDERS.has(domain.toLowerCase());
}

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return DISPOSABLE_DOMAINS.has(d) || extraDisposable().has(d);
}
