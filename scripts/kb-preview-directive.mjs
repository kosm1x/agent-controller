import { initDatabase } from "/root/claude/mission-control/dist/db/index.js";
import { upsertFile, mirrorToDisk, getFile } from "/root/claude/mission-control/dist/db/jarvis-fs.js";

initDatabase(process.env.MC_DB_PATH ?? "/root/claude/mission-control/data/mc.db");

const path = "directives/preview-publishing.md";
const title = "Publicar previews/demos estáticos — receta autoservicio";
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

## Despublicar

Borra el directorio \`/root/claude/previews/<nombre>\` — el watcher retira el vhost solo.

## Si no queda vivo en 2 min

1. \`systemctl is-active preview-caddy-sync.path\` — si no está \`active\`, reporta al operador: debe correr \`sudo bash /root/claude/mission-control/scripts/install-preview-sync.sh\`.
2. \`grep <nombre> /etc/caddy/previews-generated.caddy\` — si no aparece, el nombre no pasó el filtro (formato o reservado).
3. \`journalctl -u caddy --since "5 min ago" | grep -i acme\` — errores de emisión de cert.

Reporta el hallazgo concreto; no teorices sobre rate-limits sin una línea de log ACME que lo muestre.
`;

upsertFile(
  path, title, content,
  ["previews", "caddy", "publicar", "demo", "nip.io"],
  "conditional", 70,
  "El usuario pide publicar/servir un preview o demo estático (HTML, Three.js, dashboard) o menciona nip.io, o una publicación de preview está fallando",
);
mirrorToDisk(path, content);
const back = getFile(path);
console.log("READBACK:", back ? `${back.title} (${back.content.length} chars, qualifier=${back.qualifier})` : "MISSING");
