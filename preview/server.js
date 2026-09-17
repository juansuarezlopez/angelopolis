// Servidor de la vista previa del caballero (independiente del juego).
// Uso: node preview/server.js  ->  http://localhost:8791/caballero.html
// Los sprites v3 viven en disco C (OneDrive D esta lleno).
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const spritesDir = "C:\\Users\\juan\\AppData\\Local\\Temp\\alejk-preview\\sprites";
const port = 8791;
const mime = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript",
  ".png": "image/png",
  ".css": "text/css",
  ".json": "application/json",
};

// El editor del esqueleto guarda aqui los ajustes hechos a mano, para poder
// leerlos despues y llevarlos al juego.
const rigFile = path.join(root, "rig-ajustado.json");

http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/caballero.html";

  if (req.method === "POST" && url === "/guardar-rig") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        JSON.parse(body);                       // valida antes de escribir
        fs.writeFileSync(rigFile, body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, file: rigFile }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: String(e.message) }));
      }
    });
    return;
  }
  // /sprites/... se sirve desde el disco C (sin repetir el segmento).
  let base = root, rel = url;
  if (url.startsWith("/sprites/")) {
    base = spritesDir;
    rel = url.slice("/sprites/".length - 1); // conserva el "\" inicial
  }
  const file = path.join(base, decodeURIComponent(rel));
  const safeRoot = path.join(base, path.sep);
  if (!file.startsWith(safeRoot)) { res.statusCode = 403; res.end("403"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; res.end("404 " + url); return; }
    res.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  });
}).listen(port, () => {
  console.log("Vista previa del caballero: http://localhost:" + port + "/caballero.html");
  console.log("Sprites desde: " + spritesDir);
});
