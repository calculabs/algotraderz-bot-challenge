import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Tiny static server for local preview. GitHub Pages serves these same files
// (index.html + data/leaderboard.json) directly, so this is only for `npm run serve`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8787);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(root)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, "Not found");

  const ext = path.extname(target);
  send(res, 200, fs.readFileSync(target), contentTypes[ext] || "application/octet-stream");
});

server.listen(port, () => {
  console.log(`Dashboard: http://localhost:${port}`);
});
