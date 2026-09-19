import { initDatabase } from "/root/claude/mission-control/dist/db/index.js";
import { upsertFile, mirrorToDisk, getFile } from "/root/claude/mission-control/dist/db/jarvis-fs.js";

initDatabase(process.env.MC_DB_PATH ?? "/root/claude/mission-control/data/mc.db");

const path = "directives/preview-publishing.md";
const title = "Publicar y cerrar previews/demos estáticos — receta autoservicio";
const content = `# Publicar un preview o demo estático (autoservicio)

**Receta única — NO requiere tocar Caddy ni pedirle al operador que edite /etc.**

Para publicar un demo estático (Three.js, HTML, dashboards, etc.):

1. Elige un nombre: minúsculas, dígitos y guiones, máx. 40 chars (ej. \`ant-colony\`).
2. \`mkdir -p /root/claude/previews/<nombre>\` y escribe ahí \`index.html\` + assets.
3. Un watcher del sistema (\`preview-caddy-sync.path\`) genera el vhost, valida y recarga Caddy solo. En ~30–90 s queda vivo en:
   \`https://<nombre>.187.77.25.101.nip.io\`
4. **Verificación obligatoria** (la única prueba válida es un 200 sobre HTTPS):
   \`curl -s -o /dev/null -w '%{http_code}' https://<nombre>.187.77.25.101.nip.io\`
   Reintenta hasta ~90 s (el cert de Let's Encrypt tarda unos segundos la primera vez).

## Qué NO hacer

- **NUNCA** pidas al operador que pegue bloques en \`/etc/caddy/Caddyfile\` para un preview. Ese flujo ya no existe.
- **Un 308 en http:// NO prueba nada**: Caddy redirige a HTTPS cualquier hostname, exista o no el vhost (verificado 2026-08-23 con un hostname inexistente). La prueba de que el vhost existe es \`grep <nombre> /etc/caddy/previews-generated.caddy\` (lectura permitida) o el 200 sobre HTTPS.
- No uses nombres reservados (tienen vhost propio): intel-demo, longevidad-demo, lite-demo, vlmp-demo, aura-dash, bariatrica.

## Despublicar / cerrar un preview ("cierra el Caddy", "baja el demo", "cierra el tema X")

El vhost existe SOLO porque existe el directorio. Cerrar = sacar el directorio de \`/root/claude/previews/\`; el watcher retira el vhost y recarga Caddy solo (~30–90 s).

1. \`ls /root/claude/previews/\` — confirma el nombre exacto.
2. Saca el directorio con \`shell_exec\` (un turno, reversible):
   \`mv /root/claude/previews/<nombre> /tmp/preview-removed-<nombre>\`
   (si ese destino ya existe, usa \`/tmp/preview-removed-<nombre>-2\` — \`mv\` sobre un directorio existente lo anida en vez de fallar).
   Si el usuario pidió borrar los archivos de forma definitiva, usa \`file_delete\` con \`path=/root/claude/previews/<nombre>\` (pide confirmación al usuario; al confirmar se ejecuta sola).
3. **Verificación obligatoria**: \`grep -c "<nombre>\\." /etc/caddy/previews-generated.caddy || true\` debe imprimir 0 (reintenta hasta ~90 s; \`grep -c\` sale con código 1 cuando cuenta 0 — eso es el éxito, no un error). Solo entonces reporta "cerrado".

Qué NO hacer al cerrar:

- **NUNCA uses \`rm\`** — el shell-guard bloquea \`rm\` con ruta absoluta por diseño. No es un obstáculo: \`mv\` o \`file_delete\` son la ruta.
- **NUNCA** pidas al operador editar \`/etc/caddy/previews-generated.caddy\` ni el Caddyfile: es un archivo GENERADO; cualquier edición se sobrescribe mientras el directorio exista.
- No le devuelvas comandos al operador para algo que tú puedes hacer. Si no tienes \`shell_exec\` ni \`file_delete\` en el turno, dilo en una línea y pide que repita con "usa shell".

## Si no queda vivo en 2 min

1. \`systemctl is-active preview-caddy-sync.path\` — si no está \`active\`, reporta al operador: debe correr \`sudo bash /root/claude/mission-control/scripts/install-preview-sync.sh\`.
2. \`grep <nombre> /etc/caddy/previews-generated.caddy\` — si no aparece, el nombre no pasó el filtro (formato o reservado).
3. \`journalctl -u caddy --since "5 min ago" | grep -i acme\` — errores de emisión de cert.

Reporta el hallazgo concreto; no teorices sobre rate-limits sin una línea de log ACME que lo muestre.
`;

upsertFile(
  path, title, content,
  ["previews", "caddy", "publicar", "despublicar", "cerrar", "demo", "nip.io"],
  "conditional", 70,
  // The condition is matched by KEYWORD, not meaning: kb-injection.ts
  // conditionMatches() needs a scope-group word ("coding") in this text AND a
  // tool of that group in scope. The 08-23 wording had no keyword, so the
  // directive was never injected (2026-09-19, tasks 0a376e6d/66fc5038/b1583f19).
  "coding — el usuario pide publicar/servir un preview o demo estático (HTML, Three.js, dashboard), o pide cerrar/bajar/quitar/despublicar/eliminar un preview o demo (\"cierra el Caddy\", \"baja el demo\", \"cierra el tema X\" cuando X tiene preview), o menciona Caddy o nip.io, o una publicación de preview está fallando",
);
mirrorToDisk(path, content);
const back = getFile(path);
console.log("READBACK:", back ? `${back.title} (${back.content.length} chars, qualifier=${back.qualifier})` : "MISSING");
