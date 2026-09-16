// Servidor de la vista previa del caballero (independiente del juego).
// Uso: node preview/server.js  ->  http://localhost:8791/caballero.html
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = 8791;
const mime = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript",
  ".png": "image/png",
  ".css": "text/css",
  ".json": "application/json",
};

http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/caballero.html";
  const file = path.join(root, decodeURIComponent(url));
  if (!file.startsWith(root)) { res.statusCode = 403; res.end("403"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; res.end("404 " + url); return; }
    res.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  });
}).listen(port, () => {
  console.log("Vista previa del caballero: http://localhost:" + port + "/caballero.html");
});
