/**
 * User facts CRUD — structured personal fact storage.
 *
 * Facts are key-value pairs organized by category (personal, preferences,
 * work, health, philosophy). They survive across sessions and are always
 * injected into the Jarvis prompt so the LLM never forgets them.
 *
 * Uses UPSERT (INSERT OR REPLACE) on the (category, key) unique constraint.
 */

import { getDatabase } from "./index.js";
import { redactCredentials } from "../api/mcp-server/redact.js";
import { factSecretDisplay, invalidateSecretRefs } from "../lib/secret-refs.js";

export interface UserFact {
  category: string;
  key: string;
  value: string;
  source: string;
  updated_at: string;
}

/**
 * Credential vocabulary for a fact NAME (key or category), matched against
 * the name's tokens (split on non-alphanumerics and camelCase, lowercased,
 * accents stripped) so `author`, `keyboard` or `monkey` never match.
 * `token` followed by a quantity word (`token_budget`) is not a credential.
 * A bare `key` / `sid` counts only as the LAST token (`service_key`,
 * `connect_sid`), and `key` not after public/primary/foreign/sort/partition/
 * cache/hot/short. `clave` counts only as the last token or before
 * api/acceso/secreta/privada/wifi, never after `palabra` (keyword) — so
 * `clave_interbancaria` / `clave_elector` do not match. ct0 / swid / espn_s2
 * / li_at are session cookies stored under their own names; `s2` and
 * `session` count only as the WHOLE name (ruling 3d: a project credential
 * keyed `s2` / `session` is a cookie; `session_notes` is not).
 * Audit round 4 (3d-b), all whole tokens: plural `keys` / `tokens` as the
 * last token (`api_keys`, `access_keys`, `apiKeys`, `tokens`; not after the
 * `key` exclusions, and `tokens` not after a quantity word — `max_tokens`);
 * `privkey`, `appkey`; `nip` (Spanish PIN), `totp`; `mnemonic`,
 * `recovery_codes`, `backup_codes`, `dsn`.
 * Audit round 5: `otp`, `mfa`, `2fa`, `seed` and `authorization` count only
 * as the LAST token or before code/secret/phrase/key/token/seed/backup/header
 * (`mfa_code`, `wallet_seed`; not `mfa_device`, `otp_phone`, `seed_command`,
 * `authorization_status`, `prior_authorization`, `random_seed`). More
 * exclusions: `design/context/css/color_tokens`, `translation/required/
 * shortcut/object/index_keys`. New names: concatenated forms (`accesstoken`,
 * `secretkey`, `privatekey`, `passcode`, `pincode`), `recovery_phrase`,
 * `cvv`, `cvc`, Spanish `pregunta/respuesta_secreta`, `frase_semilla`,
 * `codigos_respaldo`, `codigo_acceso`.
 * Audit round 6: exclusions `musical/music/song/piano_key`, `boarding/day/…_pass`,
 * `secret_santa`, `llave_publica`, `map/location/drop_pin`; new names
 * `security_answer`, `respuesta_seguridad`, `access_code`, `clave_de_acceso`.
 */
/**
 * Audit round 7 (B-3, ruling 3d): Spanish `clave` after a plural noun
 * (`fechas_clave`, `puntos_clave`, `clientes_clave` — the previous token ends
 * in vowel + s) or after a singular noun it qualifies (`nombre_clave`,
 * `dato_clave`) is the adjective "key/important", not a credential.
 * `<servicio>_clave`, `clave` alone and `clave_{api,acceso,wifi,…}` stay
 * credentials (`teams`, `aws` end in consonant + s and still count; a
 * determiner — `nuestras_claves`, `todas_claves` — is not a noun).
 */
const CLAVE_ADJ_BEFORE =
  "(?:palabras?| (?!(?:nuestr|vuestr|est|es|tod|otr|algun|much|mism|aquell|ciert|vari|demas|las|los|unas|unos)[ao]?s )[a-z]{2,}[aeiou]s| (?:fecha|punto|idea|cliente|tema|mensaje|metrica|indicador|nombre|dato|factor|momento|objetivo|pregunta|paso|rol|actor|socio|elemento|aspecto|concepto|evento|hito|proceso|requisito|tarea)) ";
const FOLLOWER = "(?= $| (?:codes?|secrets?|phrases?|keys?|tokens?|seeds?|backup|header) )";
const CREDENTIAL_NAME_RE = new RegExp(
  " (?:" +
    [
      "api ?keys?",
      "private ?keys?",
      "access ?keys?",
      "ssh keys?",
      "(?:access|auth|api|refresh|session|id|bearer|csrf|xsrf|oauth)tokens?",
      "(?:secret|signing|master|encryption)keys?",
      "passcodes?",
      "pincodes?",
      "(?<!(?:public|publishable|primary|foreign|sort|partition|cache|hot|short|translation|required|shortcut|object|index|musical|music|song|piano) )keys?(?= $)",
      "(?<!(?:max|min|input|output|total|prompt|completion|num|cache|cached|reasoning|design|context|css|color|colour) )tokens(?= $)",
      `(?<!prior )authorization${FOLLOWER}`,
      `(?:otp|mfa|2fa)${FOLLOWER}`,
      `(?<!random )seed${FOLLOWER}`,
      "privkey",
      "appkey",
      "nip",
      "totp",
      "mnemonic",
      "recovery (?:codes?|phrases?|keys?)",
      "backup codes?",
      "dsn",
      "cvv2?",
      "cvc2?",
      "token(?! (?:budget|count|limit|limits|usage|cost|price|window) )",
      "secrets?(?! (?:santa|recipe|ingredient|sauce|menu|garden) )",
      "passwords?",
      "(?<!(?:boarding|bus|day|season|ski|backstage|press|guest|hall|mountain|free|gym|metro|museum|park|parking|event|annual|vip|transit|train|rail|weekly|monthly) )pass",
      "pw",
      "passwd",
      "pwd",
      "passphrases?",
      "cookies?",
      "o?auth",
      "credentials?",
      "bearer",
      "jwt",
      `(?<!${CLAVE_ADJ_BEFORE})claves?(?= $| (?:api|acceso|secreta|privada|wifi) )`,
      "claves? de (?:acceso|seguridad|respaldo|recuperacion)",
      "llaves?(?! publicas? )",
      "contrasenas?",
      "credencial(?:es)?",
      "(?<!(?:receta|recetas|ingrediente|ingredientes|formula|formulas|amigo|amiga|santa|mision|identidad|sociedad|historia|puerta|entrada) )secretos?",
      "(?<!(?:receta|recetas|ingrediente|ingredientes|formula|formulas|amigo|amiga|santa|mision|identidad|sociedad|historia|puerta|entrada) )secretas?",
      "frases? (?:de )?(?:semillas?|recuperacion)",
      "codigos? (?:de )?(?:respaldo|acceso|seguridad|recuperacion)",
      "(?<!(?:map|location|drop|gpio|lapel|bowling) )pin(?! (?:messages?|posts?|boards?|tweets?|comments?|chats?|mensajes?|notes?) )",
      "security answers?",
      "respuestas? (?:de )?seguridad",
      "access codes?",
      "sessionid",
      "session id",
      "(?:csrf|xsrf) id",
      "sid(?= $)",
      "phpsessid",
      "li at",
      "ct0",
      "swid",
      "espn s2",
      "(?<=^ )(?:s2|session)(?= $)",
      // Audit round 7: an incoming-webhook URL carries its secret in the
      // path; judged as a URL (WHOLE_NAME_META), so `webhook =
      // https://example.com/hooks/abc` stays visible.
      "webhooks?(?= $)",
    ].join("|") +
    ") ",
);

/**
 * A name whose LAST token is metadata ABOUT a credential (`api_key_path`,
 * `auth_method`, `credential_rotation_date`, `otp_enabled`, `dsn_host`,
 * `token_url`, `password_file`) is not one by name — but only when its VALUE
 * has that metadata's type (audit round 5, S4: `token_url` holding a bare
 * token, or `password_file` holding the password, is a secret). Its value is
 * still judged by the value rules.
 * Audit round 6 (should-fix 1): also header / name / id / hint / policy /
 * domain / scope / uri / arn / symbol / address / format / rate / location /
 * question / consent / last_changed (`api_key_header = Authorization`,
 * `token_symbol`, `password_hint`, `secret_arn`, `cookie_domain`,
 * `pass_rate`), each with its own value type.
 */
const CREDENTIAL_META_LAST_RE =
  / (path|method|provider|date|issuer|type|expiry|expires|rotation|enabled|region|host|url|uri|file|header|name|id|hint|policy|domain|scope|arn|symbol|address|format|rate|location|question|consent|last changed|user|username|usuario|login|account|cuenta|email|correo|mail|port|puerto|server|servidor|dominio|endpoint|redirect|tenant|nombre|telefono|phone|client) $/;

/**
 * Audit round 7 (B-2.1): `id` belongs to the credential word itself in
 * `session_id`, `csrf_id`, `xsrf_id`, `sid_id` — the value IS the session /
 * CSRF credential, so the `id` meta exemption does not apply.
 */
const CREDENTIAL_ID_RE = / (?:session|csrf|xsrf|sid) id $/;

/**
 * Whole names that are metadata about a credential without a meta last token:
 * `pregunta_secreta` (the question, not the answer — `respuesta_secreta`
 * stays hidden) and `pwd` holding a working-directory path.
 */
const WHOLE_NAME_META: ReadonlyArray<[RegExp, string]> = [
  [/^ pregunta (?:de )?secretas? $/, "question"],
  [/^ pwd $/, "path"],
  [/ webhooks? $/, "url"],
];

/**
 * Audit round 6 (B1) made a name whose only credential words were containers
 * (auth / oauth / credential(s) / creds / credencial(es)) and whose last token
 * was an identity token (`auth_email`, `db_credentials_user`) visible WITHOUT
 * looking at the value. Audit round 7 (B-2.2) folded those identity tokens
 * into the meta-suffix list above, so they are visible only when the value
 * has the identity token's type (`auth_user = Hunter2Pass99`, `oauth_id` = a
 * 32-char secret and `auth_url` with a secret query stay hidden), for every
 * credential name (`clave_de_acceso_usuario = jdoe` is visible).
 */

/**
 * A whitespace-free run of 20+ token characters mixing letters and digits —
 * the shape of a generated secret. `/`, `.`, `:` and `@` break a run, so path
 * segments, hostnames, dates and e-mails are judged piece by piece.
 */
function hasSecretRun(value: string): boolean {
  for (const m of value.matchAll(/[A-Za-z0-9+=_~-]{20,}/g)) {
    if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0])) return true;
  }
  return false;
}

/** Digits, lower AND upper case together: the shape of a password. */
function hasPasswordMix(v: string): boolean {
  return /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

// Audit round 6 (should-fix 3): a host is an IP, localhost, a bracketed IPv6
// or dotted labels ending in a TLD-ish label (starts with a letter) — and not
// a password mix (`Tr0ub4dor.3`, `Pa55.Word`).
const HOSTNAME_RE =
  /^(?:\[[0-9a-f:.]+\]|localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::\d{1,5})?$/i;
const DOMAIN_RE =
  /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const BOOLEAN_WORD_RE =
  /^(?:true|false|yes|no|on|off|1|0|s[ií]|y|n|enabled|disabled|activo|inactivo|habilitado|deshabilitado)$/i;
const REGION_SLUG_RE = /^[a-z]+(?:[-_][a-z]+)*(?:[-_]?\d{1,2}[a-z]?)?$/i;
/** Absolute, home-relative, ./ or ../ relative, or a drive path. */
const PATH_LIKE_RE = /^(?:~|\.{1,2})?[/\\]|^[A-Za-z]:[/\\]/;
const WORD_RE = /^[A-Za-z][A-Za-z0-9 _.-]{0,40}$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9 _.$/:@-]{0,80}$/;
const SYMBOL_RE = /^\$?[A-Za-z0-9.]{1,12}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARN_RE =
  /^arn:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[A-Za-z0-9_+=,.@/:-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[\d\s().-]{6,24}$/;
const COORDS_RE = /^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/;
const RATE_RE =
  /^\d+(?:[.,]\d+)?\s*(?:%|\/\s*[A-Za-z]+|[A-Za-z]{1,10}(?:\/[A-Za-z]+)?)?$/;
const DATE_RE = /^(?=.*\d)[\d\s:/.,TZ+-]{4,40}$/;
const DURATION_RE = /^\d+\s*[A-Za-z]+(?:\s+[A-Za-z]+)*$/;

/** An enum / word value: letters first, ≤41 chars, no password mix, no secret run. */
function isWord(v: string): boolean {
  return WORD_RE.test(v) && !hasPasswordMix(v) && !hasSecretRun(v);
}

/**
 * Free text (a hint, a policy, a question, a place): has a letter, no secret
 * run; a single token must be letters only (`Fluffy`, not `hunter2`).
 */
function isProse(v: string): boolean {
  if (v.length > 300 || !/\p{L}/u.test(v) || hasSecretRun(v)) return false;
  return /\s/.test(v) || /^\p{L}[\p{L}'.-]*$/u.test(v);
}

function isUrl(v: string): boolean {
  if (/\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (
      /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) &&
      u.username === "" &&
      u.password === "" &&
      // Should-fix 2: the path too (a webhook secret lives in the path).
      !hasSecretRun(u.pathname + " " + u.search + " " + u.hash)
    );
  } catch {
    return false;
  }
}

function isHost(v: string): boolean {
  return v.length <= 253 && HOSTNAME_RE.test(v) && !hasPasswordMix(v);
}

/** Whether a value has the type its metadata suffix announces (S4). */
function metaValueMatches(meta: string, raw: string): boolean {
  const v = raw.trim();
  if (v === "" || /[\r\n]/.test(v)) return v === "";
  switch (meta) {
    case "url":
    case "uri":
    case "redirect":
      return isUrl(v);
    case "host":
    case "server":
    case "servidor":
      return isHost(v);
    case "endpoint":
      return isHost(v) || isUrl(v);
    case "domain":
    case "dominio":
      return v.length <= 253 && DOMAIN_RE.test(v) && !hasPasswordMix(v);
    case "email":
    case "correo":
    case "mail":
      return EMAIL_RE.test(v);
    case "port":
    case "puerto":
      return /^\d{1,5}$/.test(v);
    case "telefono":
    case "phone":
      return PHONE_RE.test(v) && (v.match(/\d/g)?.length ?? 0) >= 6;
    case "user":
    case "username":
    case "usuario":
    case "login":
    case "account":
    case "cuenta":
      // A login name or e-mail: one token, no password mix, no secret run.
      return (
        v.length <= 254 &&
        !/\s/.test(v) &&
        !hasPasswordMix(v) &&
        !hasSecretRun(v)
      );
    case "client":
    case "tenant":
      return (
        UUID_RE.test(v) ||
        (ID_RE.test(v) && !hasPasswordMix(v) && !hasSecretRun(v)) ||
        isWord(v)
      );
    case "nombre":
      return NAME_RE.test(v) && !hasPasswordMix(v) && !hasSecretRun(v);
    case "file":
    case "path":
      return (
        PATH_LIKE_RE.test(v) && /[A-Za-z0-9]/.test(v) && !hasSecretRun(v)
      );
    case "enabled":
      return BOOLEAN_WORD_RE.test(v);
    case "region":
      return v.length <= 30 && REGION_SLUG_RE.test(v);
    case "header":
      return HEADER_RE.test(v) && !hasPasswordMix(v) && !hasSecretRun(v);
    case "name":
      return NAME_RE.test(v) && !hasPasswordMix(v) && !hasSecretRun(v);
    case "symbol":
      return SYMBOL_RE.test(v) && !hasPasswordMix(v);
    case "id":
      return (
        /^\d{1,24}$/.test(v) ||
        UUID_RE.test(v) ||
        (ID_RE.test(v) && !hasPasswordMix(v) && !hasSecretRun(v))
      );
    case "arn":
      return ARN_RE.test(v);
    case "address":
      return (
        EMAIL_RE.test(v) ||
        /^0x[0-9a-fA-F]{40}$/.test(v) ||
        /^(?:bc1|tb1)[a-z0-9]{20,80}$/.test(v) ||
        isHost(v) ||
        (/\s/.test(v) && isProse(v))
      );
    case "scope":
      return (
        v.length <= 500 &&
        v
          .split(/[\s,]+/)
          .every((s) => isUrl(s) || (/^[A-Za-z][\w.:/-]{0,80}$/.test(s) && !hasPasswordMix(s) && !hasSecretRun(s)))
      );
    case "rate":
      return RATE_RE.test(v);
    case "location":
      // Should-fix (round 7): a file path is a location too.
      return (
        COORDS_RE.test(v) ||
        isProse(v) ||
        (PATH_LIKE_RE.test(v) && /[A-Za-z0-9]/.test(v) && !hasSecretRun(v))
      );
    case "hint":
    case "policy":
    case "question":
      return isProse(v);
    case "format":
      return isWord(v) || isProse(v);
    case "date":
    case "expiry":
    case "expires":
    case "rotation":
    case "last changed":
      return (
        DATE_RE.test(v) || isWord(v) || (v.length <= 40 && DURATION_RE.test(v))
      );
    case "issuer":
    case "provider":
      return isWord(v) || isUrl(v);
    default:
      // method / type / consent: a word / enum value only.
      return isWord(v);
  }
}

/**
 * Credential value shapes the shared redactCredentials table does not cover,
 * kept local so redact.ts consumers do not change. Every pattern is linear
 * (no nested quantifiers), has no /g flag (test() stays stateless) and is
 * anchored on a fixed prefix plus a minimum length/charset.
 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  // Stripe secret / restricted keys; `pk_live_` / `pk_test_` are publishable
  // (public) keys and stay visible (audit round 7).
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bfw_[A-Za-z0-9]{16,}/, // Fireworks
  /:\/\/[^\s/:@]*:[^\s/@]+@/, // URL userinfo user:pass@ (empty user too: redis://:pw@)
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /(?:\bapi[ _-]?key|\btoken|\bpassword|\bcontrase(?:ñ|ñ?)a|\bclave)\s*[:=]\s*\S{6,}/i,
  /"(?:token|auth_token|password)"\s*:\s*"[^"]+"/i,
  // PEM private key of any type (RSA, EC, OPENSSH, ENCRYPTED, PKCS#8);
  // `-----BEGIN PUBLIC KEY-----` does not match.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  // Audit round 5 (S3):
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bPuTTY-User-Key-File-\d+:\s*\S/, // PuTTY .ppk
  /\bya29\.[A-Za-z0-9_-]{20,}/, // Google OAuth access token
  /(?:^|[^A-Za-z0-9/:])1\/\/0[A-Za-z0-9_-]{30,}/, // Google OAuth refresh token
  /\bhf_[A-Za-z0-9]{30,}/, // Hugging Face
  /\bnpm_[A-Za-z0-9]{36,}/, // npm
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}/, // SendGrid
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32,}/, // Shopify
  // Audit round 6 (should-fix 2): incoming-webhook URLs carry their secret
  // in the path.
  /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{8,}/, // Slack
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{16,}/, // Discord
  /[a-z0-9-]+\.webhook\.office\.com\/[^\s"']{16,}/i, // Teams
];

function nameTokens(name: string): string {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return ` ${tokens.join(" ")} `;
}

/**
 * Whether a key / category name names a credential. A name ending in a
 * metadata token is exempt when no scalar value is given (a container key)
 * or when the value has that metadata's type (S4); otherwise it is one.
 */
export function isCredentialName(name: string, value?: string): boolean {
  const tokens = nameTokens(name);
  if (!CREDENTIAL_NAME_RE.test(tokens)) return false;
  // Audit R7 B-2.1: `session_id` is the credential, not metadata about one.
  if (CREDENTIAL_ID_RE.test(tokens)) return true;
  const meta =
    CREDENTIAL_META_LAST_RE.exec(tokens)?.[1] ??
    WHOLE_NAME_META.find(([re]) => re.test(tokens))?.[1];
  if (!meta) return true;
  if (value === undefined) return false;
  return !metaValueMatches(meta, value);
}

/**
 * Audit round 5 (B1): the LAST token names a secret VALUE (password, token,
 * secret, key, pin, cookie, seed, codes…), so every leaf below a key with
 * this name is a secret (`password: {prod}`, `api_keys: [v]`,
 * `github_token: {value, scope}`). A name whose credential word is a scheme
 * or container — auth / oauth / credential(s) / creds / credencial(es) /
 * authorization / otp / mfa / 2fa / dsn — is NOT: `db_credentials`,
 * `basic_auth`, `google_oauth`, `oauth_config`, `credenciales_ftp` hold
 * usernames, hosts and ids that stay visible (each child judged by its own
 * key and value).
 */
const SECRET_VALUE_LAST_RE = new RegExp(
  " (?:" +
    [
      "passwords?",
      "passwd",
      "pwd",
      "pass",
      "pw",
      "passphrases?",
      "phrases?",
      "tokens?",
      "[a-z]+tokens?",
      "secrets?",
      "secretos?",
      "secretas?",
      "keys?",
      "[a-z]+keys?",
      "pin",
      "nip",
      "cookies?",
      "bearer",
      "jwt",
      "claves?",
      "llaves?",
      "contrasenas?",
      "totp",
      "seeds?",
      "semillas?",
      "mnemonic",
      "codes?",
      "codigos?",
      // Audit R6 B1: acceso / respaldo / recuperacion / seguridad name a
      // secret only after codigo(s) / clave(s) / frase(s) — `credenciales_de_acceso`
      // is a container (its usuario / host stay visible).
      "(?:codigos?|claves?|frases?)(?: de)? (?:acceso|respaldo|recuperacion|seguridad)",
      "answers?",
      "respuestas? (?:de )?seguridad",
      "cvv2?",
      "cvc2?",
      "passcodes?",
      "pincodes?",
      "sid",
      "sessionid",
      "phpsessid",
      "li at",
      "ct0",
      "swid",
      "s2",
    ].join("|") +
    ") $",
);

export function isSecretValueName(name: string): boolean {
  return isCredentialName(name) && SECRET_VALUE_LAST_RE.test(nameTokens(name));
}

/**
 * Ruling 3 (2026-10-01, "mask and block"): the ONE credential classifier for
 * user facts. True when the key or category names a credential, or when the
 * value carries a credential shape (redactCredentials — without the loose
 * hex rule, so git SHAs are not credentials — plus the local patterns
 * above). A value that only CONTAINS a credential inside longer prose counts
 * too: the whole value is masked.
 */
export function isCredentialFact(
  category: string,
  key: string,
  value: string,
): boolean {
  return (
    isCredentialName(key, value) ||
    isCredentialName(category, value) ||
    redactCredentials(value) !== value ||
    CREDENTIAL_VALUE_PATTERNS.some((re) => re.test(value))
  );
}

/** Fallback mask when a credential has no reference name (not stored). */
export const CREDENTIAL_FACT_PLACEHOLDER =
  "[valor oculto: credencial guardada; no se muestra]";

/**
 * A fact's value as the model may see it: a credential shows its by-name
 * placeholder (ruling 3c, lib/secret-refs.ts), anything else the value.
 */
export function factDisplayValue(
  f: Pick<UserFact, "category" | "key" | "value">,
): string {
  return factSecretDisplay(f.category, f.key, f.value);
}

/**
 * Set (upsert) a user fact. If (category, key) exists, updates the value.
 * Ruling 3c: a credential-style fact is stored like any other; every reader
 * shows it by its reference name only (factDisplayValue / lib/secret-refs.ts).
 */
export function setUserFact(
  category: string,
  key: string,
  value: string,
  source = "conversation",
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO user_facts (category, key, value, source, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(category, key)
     DO UPDATE SET value = excluded.value,
                   source = excluded.source,
                   updated_at = datetime('now')`,
  ).run(category, key, value, source);
  invalidateSecretRefs();
}

/**
 * Get all facts, optionally filtered by category.
 */
export function getUserFacts(category?: string): UserFact[] {
  const db = getDatabase();
  if (category) {
    return db
      .prepare(
        "SELECT category, key, value, source, updated_at FROM user_facts WHERE category = ? ORDER BY category, key",
      )
      .all(category) as UserFact[];
  }
  return db
    .prepare(
      "SELECT category, key, value, source, updated_at FROM user_facts ORDER BY category, key",
    )
    .all() as UserFact[];
}

/**
 * Delete a specific fact by category + key.
 */
export function deleteUserFact(category: string, key: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare("DELETE FROM user_facts WHERE category = ? AND key = ?")
    .run(category, key);
  invalidateSecretRefs();
  return result.changes > 0;
}

/**
 * Categories that are ALWAYS injected (core identity, small).
 * Everything else is relevance-scored.
 */
const ALWAYS_INJECT_CATEGORIES = new Set([
  "personal",
  "contact",
  "preferences",
]);

/**
 * Max total chars for the SCORED part of the facts block (prompt-bloat cap).
 * Always-inject categories are NOT counted against it: on 2026-05-24 the
 * `personal` facts alone crossed 3,000 chars and every scored fact — all 197
 * `projects` rows, credentials included — was silently skipped on every chat
 * turn for three months (found 2026-09-06: «no tenemos guardado el espn_s2»
 * with three copies of it in user_facts).
 */
const MAX_FACTS_CHARS = 3_000;

/**
 * Score a fact's relevance to the current message.
 * Higher score = more relevant. 0 = no relevance signal.
 */
function scoreFact(fact: UserFact, messageWords: Set<string>): number {
  const text = `${fact.category} ${fact.key} ${fact.value}`.toLowerCase();
  let score = 0;
  for (const word of messageWords) {
    if (text.includes(word)) score += 1;
  }
  return score;
}

/**
 * Format user facts as a prompt block, relevance-scored per message.
 *
 * Always injects: personal, contact, preferences (core identity).
 * Other categories: scored by keyword overlap with the current message,
 * top-N included up to MAX_FACTS_CHARS budget. Long signal digests and
 * ephemeral intelligence reports don't bloat every prompt.
 *
 * Relevance floor (2026-09-06 qa-audit C1): when a message is given, a fact
 * with score 0 is never injected — otherwise the sort collapses to recency
 * and the budget fills with the newest rows on EVERY unrelated turn (live:
 * three session tokens, a password and an auth token). Only a call WITHOUT
 * a message (none in production — the router always passes msg.text) keeps
 * recency order; a message with no scorable word («?») injects nothing.
 */
export function formatUserFactsBlock(currentMessage?: string): string {
  const facts = getUserFacts();
  if (facts.length === 0) return "";

  // Split into always-inject vs scored
  const alwaysFacts: UserFact[] = [];
  const scoredFacts: Array<{ fact: UserFact; score: number }> = [];

  const messageWords = new Set(
    (currentMessage ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

  for (const f of facts) {
    if (ALWAYS_INJECT_CATEGORIES.has(f.category)) {
      alwaysFacts.push(f);
    } else {
      const score = scoreFact(f, messageWords);
      scoredFacts.push({ fact: f, score });
    }
  }

  // Sort scored facts: relevant first, then by recency
  scoredFacts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.fact.updated_at ?? "").localeCompare(a.fact.updated_at ?? "");
  });

  // Build output: always-inject unconditionally, then scored facts within
  // their own budget (see MAX_FACTS_CHARS).
  const byCategory = new Map<string, string[]>();
  let totalChars = 0;

  // Always-inject first — not counted against the scored budget
  for (const f of alwaysFacts) {
    const line = `- **${f.key}**: ${factDisplayValue(f)}`;
    const list = byCategory.get(f.category) ?? [];
    list.push(line);
    byCategory.set(f.category, list);
  }

  // Then scored facts up to budget — relevant ones only when a message is known
  const requireRelevance = currentMessage !== undefined;
  for (const { fact: f, score } of scoredFacts) {
    if (requireRelevance && score === 0) continue;
    const line = `- **${f.key}**: ${factDisplayValue(f)}`;
    if (totalChars + line.length > MAX_FACTS_CHARS) continue;
    const list = byCategory.get(f.category) ?? [];
    list.push(line);
    byCategory.set(f.category, list);
    totalChars += line.length;
  }

  const sections: string[] = [];
  for (const [category, lines] of byCategory) {
    sections.push(`### ${category}\n${lines.join("\n")}`);
  }

  return (
    "\n\n## Perfil del usuario (hechos confirmados)\n" +
    "Estos datos los proporcionó Fede directamente. NUNCA los olvides ni los contradigas.\n\n" +
    sections.join("\n\n")
  );
}
