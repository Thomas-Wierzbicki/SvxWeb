// server.js — SVXLink Web Backend (Node.js + Express, ES Module)
// Consolidated version with METAR/Airport lookup.

// ===== Imports =====
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import https from "https";
import readline from "readline";
import { spawn, exec as execCb } from "child_process";
import { fileURLToPath } from "url";
import os from "os";

// Hinzufügen der XML-Parser-Bibliothek und Axios
import { parseStringPromise } from "xml2js";
import axios from "axios";

// Zusätzliche Imports aus server_metar.js
import { parse } from "csv-parse/sync";

import dotenv from "dotenv";
dotenv.config();

// === TEMPORÄRER DEBUG-CODE ===
console.log("Debug: QRZ_USERNAME is", process.env.QRZ_USERNAME);
console.log("Debug: QRZ_PASSWORD is", process.env.QRZ_PASSWORD);
console.log("Debug: QRZ_API_KEY is", process.env.QRZ_API_KEY);
// =============================


const SVXWEB_VERSION = process.env.SVXWEB_VERSION || "0.6.9_api";

// ===== __dirname / __filename =====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SVXLINK_LOG = "/var/log/svxlink";

// ===== exec + sudo wrapper =====
const exec = (cmd) =>
  new Promise((res, rej) =>
    execCb(cmd, (e, so, se) => (e ? rej(new Error((se || so || "").trim() || String(e))) : res({ stdout: so, stderr: se })))
  );
const USE_SUDO = process.env.SVX_USE_SUDO === "1";
const run = (cmd) => exec(USE_SUDO ? `sudo ${cmd}` : cmd);

// ===== Konfiguration (ENV mit Defaults) =====
const PORT          = parseInt(process.env.PORT || "3030", 10);
const SERVICE       = process.env.SVX_SERVICE_NAME || "svxlink";
const CONFIG_DIR    = process.env.SVX_CONFIG_DIR   || "/etc/svxlink";
const ALLOWED_FILES = (process.env.SVX_ALLOWED_FILES ||
  "svxlink.conf,remotetrx.conf,modules.d/ModuleEchoLink.conf,modules.d/ModuleDtmfRepeater.conf,logic.tcl")
  .split(",").map(s => s.trim()).filter(Boolean);
const DTMF_PTY      = process.env.SVX_DTMF_PTY     || "/dev/shm/dtmf_ctrl";
const API_KEY       = process.env.SVX_API_KEY      || "";      // optionaler x-api-key
const FRONTEND_DIR  = process.env.FRONTEND_DIR     || "";      // optional: statische Auslieferung

// Neu: QRZ-Anmeldedaten aus Umgebungsvariablen lesen
const QRZ_USERNAME  = process.env.QRZ_USERNAME     || "";
const QRZ_PASSWORD  = process.env.QRZ_PASSWORD     || "";
const QRZ_API_KEY   = process.env.QRZ_API_KEY      || "";

// Metar/Airport-Konfiguration
const IATA_ICAO_CSV_URL = process.env.IATA_ICAO_CSV_URL || "https://raw.githubusercontent.com/ip2location/ip2location-iata-icao/master/iata-icao.csv";
const METAR_STATIONS_URL = process.env.METAR_STATIONS_URL || "https://tgftp.nws.noaa.gov/data/observations/metar/stations/";
const LOCAL_METAR_STATIONS_PATH = "/tmp/stations.txt";
let airportCache = null;
let metarStationsCache = null;
const AIRPORT_CACHE_MS = parseInt(process.env.AIRPORT_CACHE_MS || 21600000, 10); // 6 hours
const METAR_STATIONS_CACHE_MS = parseInt(process.env.METAR_STATIONS_CACHE_MS || 3600000, 10); // 1 hour


// ===== Express =====
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// (optional) statisches Frontend
if (FRONTEND_DIR && fss.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

// Start-Log
console.log("[svxweb] running file:", __filename);

// ===== Route-Tracker (Express 4/5) â€” muss vor allen Routen stehen =====
const __routes = [];
(function patchRouteRegistration(appInst) {
  const METHODS = ["get","post","put","patch","delete","options","head","all"];
  for (const m of METHODS) {
    const orig = appInst[m].bind(appInst);
    appInst[m] = (p, ...handlers) => {
      try {
        const idx = __routes.findIndex(r => r.path === p);
        const up = m.toUpperCase();
        if (idx >= 0) {
          if (!__routes[idx].methods.includes(up)) __routes[idx].methods.push(up);
        } else {
          __routes.push({ path: p, methods: [up] });
        }
      } catch {}
      return orig(p, ...handlers);
    };
  }
})(app);

// (optional) API-Key Middleware fÃ¼r alle /api Routen
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (!req.path.startsWith("/api/")) return next();
  const key = req.header("x-api-key") || "";
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

// ===== Debug-/Health =====
app.get("/api/ping", (req, res) => res.json({ ok: true, pid: process.pid, file: __filename }));
app.get("/api/_debug/routes", (req, res) => {
  res.json(__routes.sort((a,b)=>a.path.localeCompare(b.path)));
});

// ===== Datei-/Config-Helfer =====
const safeJoin = (base, t) => {
  const p = path.normalize(path.join(base, t));
  const nb = path.normalize(base + path.sep);
  if (!p.startsWith(nb)) throw new Error("path traversal");
  return p;
};

async function readIniValue(file, key) {
  try {
    const txt = await fs.readFile(file, "utf8");
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "mi");
    const m = txt.match(re);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

async function getVersion() {
  const cmds = [
    "/usr/bin/svxlink --version 2>&1",
    "/usr/local/bin/svxlink --version 2>&1",
    "svxlink --version 2>&1",
    "dpkg-query -W -f='${Version}\\n' svxlink 2>/dev/null",
    "dpkg-query -W -f='${Version}\\n' svxlink-server 2>/dev/null",
  ];
  for (const cmd of cmds) {
    try {
      const { stdout } = await exec(cmd);
      const line = (stdout || "").trim().split(/\r?\n/)[0];
      if (line) return line;
    } catch {}
  }
  return process.env.SVX_VERSION || "";
}

async function getStatus() {
  let svc = "unknown";
  try {
    const { stdout } = await run(`systemctl is-active ${SERVICE}`);
    svc = stdout.trim() || "unknown";
  } catch {}
  const version  = await getVersion();
  const confMain = path.join(CONFIG_DIR, "svxlink.conf");
  const nodeCall =
    (await readIniValue(confMain, "CALLSIGN")) ||
    (await readIniValue(confMain, "NODECALL")) ||
    process.env.SVX_NODECALL || "";
  const modulesRaw = await readIniValue(confMain, "MODULES");
  const modules = (modulesRaw || "")
    .split(/\s*,\s*|\s+/).filter(Boolean).map(n => ({ name: n, enabled: true }));
  return { service: svc, version, nodeCall, modules };
}

// ===== EchoLink: Fetch-Helper =====
function fetchWithUA(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "svxweb/1.0 (+https://example.local)" } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

// ===== EchoLink: Konferenzen (Live + Fallback + Cache) =====
const FALLBACK_CONF = ["*ECHOTEST*","*AMSAT*","*DODROPIN*","*THEGUILD*","*HAM-CONFERENCE*","*ROC-HAM*"];
let confCache = { ts: 0, list: FALLBACK_CONF };
const CACHE_MS = 5 * 60 * 1000;

// ===== EchoLink: komplette logins.jsp als Zeilen-Array =====
let loginsCache = { ts: 0, raw: "", lines: [], asOf: "" };
const LOGINS_CACHE_MS = 5 * 60 * 1000;

function extractAsOf(text) {
  const m = text.match(/As of\s+(.+?UTC)/i);
  return m ? m[1].trim() : "";
}
function toLines(text, rawMode = false) {
  const norm = text.replace(/\r\n?/g, "\n");
  const arr = norm.split("\n");
  if (rawMode) return arr;
  return arr.map(l => l.replace(/\s+$/,"")).filter(l => l.length > 0);
}

// ===== EchoLink: strukturierte Logins (Tabelle parsen) =====
let loginsStructCache = { ts: 0, items: [] };
const LOGINS_STRUCT_CACHE_MS = 5 * 60 * 1000;

function decodeHtml(s = "") {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');
}
function stripTags(s = "") {
  return decodeHtml(s.replace(/<[^>]+>/g, "")).trim();
}
function parseRow(htmlRow) {
  const cols = [...htmlRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
  if (cols.length < 5) return null;
  const callsign = cols[0].replace(/-(R|L)$/i, "").trim();
  const location = cols[1].replace(/\[[0-9]+\/[0-9]+\]/, "").trim();
  const status   = cols[2].trim();
  const time     = cols[3].trim();
  const node     = cols[4].trim();
  if (!callsign || !node) return null;
  return { callsign, location, status, time, node };
}


// ===== METAR/Airport-Funktionen =====
async function getAirports() {
  if (airportCache && Date.now() - airportCache.ts < AIRPORT_CACHE_MS) {
    console.log("[airports] Using cached data.");
    return airportCache.data;
  }
  try {
    console.log("[airports] Fetching data from GitHub...");
    const response = await axios.get(IATA_ICAO_CSV_URL);
    const csvContent = response.data;
    let records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });
    records = records.filter(record => record.region_name && record.airport);
    records.sort((a, b) => a.icao.localeCompare(b.icao));
    airportCache = { ts: Date.now(), data: records };
    console.log(`[airports] Successfully loaded ${records.length} records.`);
    return records;
  } catch (e) {
    console.error("[airports] Failed to fetch or parse data from GitHub:", e.message);
    airportCache = { ts: Date.now(), data: [] };
    return [];
  }
}

async function getMetarStations() {
  if (metarStationsCache && Date.now() - metarStationsCache.ts < METAR_STATIONS_CACHE_MS) {
    console.log("[metar-stations] Using cached data.");
    return metarStationsCache.data;
  }
  try {
    console.log("[metar-stations] Fetching list from NOAA website...");
    const response = await axios.get(METAR_STATIONS_URL);
    const content = response.data;
    const icaoCodes = new Set();
    const regex = /<a href="(\w{4})\.TXT">/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      icaoCodes.add(match[1].toUpperCase());
    }
    await fs.writeFile(LOCAL_METAR_STATIONS_PATH, Array.from(icaoCodes).join('\n'), "utf8");
    console.log(`[metar-stations] Successfully wrote ${icaoCodes.size} station codes to ${LOCAL_METAR_STATIONS_PATH}.`);
    const fileContent = await fs.readFile(LOCAL_METAR_STATIONS_PATH, "utf8");
    const lines = fileContent.split('\n');
    const processedIcaoCodes = new Set();
    lines.forEach(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 4) {
        processedIcaoCodes.add(trimmedLine.toUpperCase());
      }
    });
    metarStationsCache = { ts: Date.now(), data: processedIcaoCodes };
    console.log(`[metar-stations] Successfully loaded ${processedIcaoCodes.size} stations from local file.`);
    return processedIcaoCodes;
  } catch (e) {
    console.error("[metar-stations] Failed to process station list:", e.message);
    return new Set();
  }
}

// ===== API-Endpunkte =====

// Neuer Endpunkt zur Abfrage der QRZ-Datenbank
app.get("/api/qrz/lookup", async (req, res) => {
  if (!QRZ_USERNAME || !QRZ_PASSWORD || !QRZ_API_KEY) {
    return res.status(500).json({ error: "QRZ credentials are not fully configured." });
  }

  const callsign = String(req.query.callsign).trim().toUpperCase();
  if (!callsign) {
    return res.status(400).json({ error: "Callsign is missing." });
  }

  try {
    // 1. Hole eine Session-ID von QRZ
    const sessionUrl = `https://xmldata.qrz.com/xml/current/?username=${QRZ_USERNAME}&password=${QRZ_PASSWORD}&api_key=${QRZ_API_KEY}`;
    const sessionRes = await axios.get(sessionUrl);
    const sessionXml = await parseStringPromise(sessionRes.data);
    const sessionId = sessionXml.QRZDatabase.Session[0].Key[0];

    // 2. Suche das Rufzeichen mit der Session-ID
    const lookupUrl = `https://xmldata.qrz.com/xml/current/?s=${sessionId}&callsign=${callsign}`;
    const lookupRes = await axios.get(lookupUrl);
    const lookupXml = await parseStringPromise(lookupRes.data);

    const lookupData = lookupXml.QRZDatabase.Callsign[0];

    if (!lookupData) {
      return res.status(404).json({ error: "Callsign not found." });
    }

    const location = {
      callsign: lookupData.call,
      city: lookupData.city ? lookupData.city[0] : null,
      state: lookupData.state ? lookupData.state[0] : null,
      country: lookupData.country ? lookupData.country[0] : null,
      latitude: lookupData.lat ? lookupData.lat[0] : null,
      longitude: lookupData.lon ? lookupData.lon[0] : null,
    };

    res.json({ ok: true, location });
  } catch (e) {
    console.error("QRZ lookup failed:", e);
    res.status(500).json({ ok: false, error: "QRZ lookup failed." });
  }
});

// Neu: Endpunkt zum Abrufen der Flughafendaten
app.get("/api/airports", async (req, res) => {
  const icaoQuery = req.query.icao;
  const metarFilter = req.query.metarAvailable === 'true';
  
  console.log(`[server] API request received for /api/airports with query: ${icaoQuery || "none"}, metarAvailable: ${metarFilter}`);
  
  try {
    const allAirports = await getAirports();
    const metarStations = await getMetarStations();
    
    const airportsWithMetar = allAirports.map(airport => ({
      ...airport,
      metarAvailable: metarStations.has(airport.icao)
    }));
    
    let airports = airportsWithMetar;
    
    if (metarFilter) {
      airports = airports.filter(a => a.metarAvailable);
      console.log(`[server] Filtered by METAR availability, found ${airports.length} matches.`);
    }
    
    if (icaoQuery) {
      const queryLower = icaoQuery.toLowerCase();
      airports = airports.filter(a => a.icao.toLowerCase().startsWith(queryLower));
      
      console.log(`[server] Filtered by ICAO query, found ${airports.length} matches.`);
    }
    
    res.json({ count: airports.length, airports });
  } catch (e) {
    res.status(500).json({ error: "Failed to load airport data." });
  }
});

// Neu: Endpunkt zum Abrufen von METAR-Daten
app.get("/api/metar", async (req, res) => {
  const icao = req.query.icao;
  if (!icao) {
    return res.status(400).json({ error: "ICAO code is required." });
  }

  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
    console.log(`[metar] Fetching METAR data for ${icao}`);
    const response = await axios.get(url);
    res.json(response.data);
  } catch (e) {
    console.error("[metar] Failed to fetch METAR data:", e.message);
    res.status(500).json({ error: "Failed to fetch METAR data." });
  }
});


// IP-Adressen

app.get("/api/network/addresses", (_req, res) => {
  try {
    const nets = os.networkInterfaces();
    const items = [];
    for (const [iface, addrs] of Object.entries(nets)) {
      for (const a of addrs || []) {
        items.push({
          iface,
          family: a.family,      // 'IPv4' | 'IPv6'
          address: a.address,
          netmask: a.netmask,
          cidr: a.cidr || null,
          mac: a.mac || null,
          internal: !!a.internal,
          scopeid: a.scopeid ?? null,
        });
      }
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


// Status
app.get("/api/status", async (_req, res) => {
  try { res.json({ ...(await getStatus()), svxwebVersion: SVXWEB_VERSION }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Service steuern
app.post("/api/service/:action", async (req, res) => {
  const a = String(req.params.action || "");
  if (!/^start|stop|restart$/.test(a)) return res.status(400).json({ error: "invalid action" });
  try {
    const { stdout, stderr } = await run(`systemctl ${a} ${SERVICE}`);
    res.json({ ok: true, stdout: (stdout || "").trim(), stderr: (stdout || "").trim() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// DTMF (PTY)
app.post("/api/dtmf", async (req, res) => {
  try {
    const { digits } = req.body || {};
    if (!digits || !/^[0-9ABCD*#]+$/i.test(digits)) return res.status(400).json({ error: "invalid digits" });
    await fs.writeFile(DTMF_PTY, String(digits).toUpperCase() + "\n", "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Reflector (per DTMF)
app.post("/api/reflector/connect", async (req, res) => {
  try {
    let { server } = req.body || {};
    if (!server || !/^[\w*#\-_. ]{2,}$/i.test(server)) return res.status(400).json({ error: "invalid server" });
    server = server.trim();
    if (!server.endsWith("#")) server += "#";
    await fs.writeFile(DTMF_PTY, server + "\n", "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/reflector/disconnect", async (_req, res) => {
  try {
    await fs.writeFile(DTMF_PTY, "#\n", "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Konfiguration (Whitelist)
app.get("/api/config", async (req, res) => {
  try {
    const file = String(req.query.file || "");
    if (!file) return res.status(400).json({ error: "file missing" });
    if (!ALLOWED_FILES.includes(file)) return res.status(403).json({ error: "file not allowed" });
    const p = safeJoin(CONFIG_DIR, file);
    const content = await fs.readFile(p, "utf8");
    res.json({ file, content });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/config", async (req, res) => {
  try {
    const { file, content } = req.body || {};
    if (!file || typeof content !== "string") return res.status(400).json({ error: "invalid payload" });
    if (!ALLOWED_FILES.includes(file)) return res.status(403).json({ error: "file not allowed" });
    const p = safeJoin(CONFIG_DIR, file);
    await fs.writeFile(p, content, "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Logs
app.get("/api/logs/tail", (req, res) => {
  const lines = parseInt(req.query.lines || "100", 10);
  try {
    const tail = spawn("tail", ["-n", String(lines), SVXLINK_LOG]);
    let data = "";
    tail.stdout.on("data", (chunk) => {
      data += chunk.toString();
    });
    tail.on("close", () => {
      const arr = data.split("\n").filter(Boolean);
      res.json({ lines: arr });
    });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Lesen des svxlink-Logs", details: err.message });
  }
});


app.get("/api/logs/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const child = spawn("journalctl", ["-u", `${SERVICE}.service`, "-f", "-o", "cat"], { stdio: ["ignore","pipe","pipe"] });
  const rl = readline.createInterface({ input: child.stdout });
  const send = (line) => res.write(`data: ${String(line).replace(/\n/g, " ")}\n\n`);
  rl.on("line", send);
  child.stderr?.on("data", (d) => send(String(d)));
  req.on("close", () => { try { rl.close(); } catch {}; try { child.kill("SIGTERM"); } catch {}; });
});

// EchoLink: Konferenzliste

// ===== API: EchoLink Konferenzen (inkl. #conf Abschnitt) =====
app.get("/api/echolink/conferences", async (_req, res) => {
  try {
    // Cache noch gültig?
    if (Date.now() - confCache.ts < CACHE_MS && confCache.list?.length) {
      return res.json({ count: confCache.list.length, cached: true, conferences: confCache.list });
    }

    // Seite abrufen (Anker #conf ist serverseitig egal, wir bekommen die ganze Seite)
    const { status, body } = await fetchWithUA("https://www.echolink.org/logins.jsp");
    if (status !== 200 || !body) {
      confCache = { ts: Date.now(), list: FALLBACK_CONF };
      return res.json({ count: FALLBACK_CONF.length, fallback: true, conferences: FALLBACK_CONF });
    }

    const html = body;

    // 1) Generischer Catch-All: Alle *NAME* Vorkommen im Dokument
    const set = new Set();
    const starRe = /\*([A-Z0-9][A-Z0-9\-_. ]*[A-Z0-9])\*/gi;
    let m;
    while ((m = starRe.exec(html)) !== null) {
      set.add(`*${m[1].trim().toUpperCase()}*`);
    }

    // 2) Spezifischer: Bereich „Conferences“ gezielt parsen (#conf Tabelle)
    //    Schneide einen Block um "Conferences" aus, um Fehlmatches zu minimieren
    const headingIdx = html.search(/>\s*Conferences\s*</i);
    if (headingIdx >= 0) {
      // nimm ~30k Zeichen um die Section herum (großzügig)
      const slice = html.slice(headingIdx, headingIdx + 30000);

      // a) alle *NAME* in diesem Bereich
      starRe.lastIndex = 0;
      while ((m = starRe.exec(slice)) !== null) {
        set.add(`*${m[1].trim().toUpperCase()}*`);
      }

      // b) falls die Tabelle TDs enthält, in deren erster Spalte der Konferenzname steht,
      //    extrahiere <td>…</td> und säubere von HTML/Whitespace.
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/i;
      let row;
      while ((row = rowRe.exec(slice)) !== null) {
        const raw = row[1] || "";
        const cm = raw.match(cellRe);
        if (!cm) continue;
        const firstCell = cm[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .trim();
        // wenn die erste Zelle wie *NAME* aussieht, übernehmen
        if (/^\*[A-Z0-9][A-Z0-9\-_. ]*[A-Z0-9]\*$/.test(firstCell)) {
          set.add(firstCell.toUpperCase());
        }
      }
    }

    // 3) Ergebnis bauen
    const out = Array.from(set);
    out.sort((a, b) => a.localeCompare(b));
    const list = out.length ? out : FALLBACK_CONF;

    confCache = { ts: Date.now(), list };
    res.json({ count: list.length, conferences: list, fallback: !out.length });
  } catch (_e) {
    confCache = { ts: Date.now(), list: FALLBACK_CONF };
    res.json({ count: FALLBACK_CONF.length, fallback: true, conferences: FALLBACK_CONF });
  }
});


// EchoLink: komplette logins.jsp als Zeilen-Array
app.get("/api/echolink/logins_lines", async (req, res) => {
  const rawMode = String(req.query.raw || "") === "1";
  try {
    if (Date.now() - loginsCache.ts < LOGINS_CACHE_MS && loginsCache.lines.length) {
      return res.json({
        cached: true,
        as_of: loginsCache.asOf,
        count: (rawMode ? toLines(loginsCache.raw, true) : loginsCache.lines).length,
        lines: rawMode ? toLines(loginsCache.raw, true) : loginsCache.lines
      });
    }
    const { status, body } = await fetchWithUA("https://www.echolink.org/logins.jsp");
    if (status !== 200 || !body) {
      return res.status(502).json({ error: "upstream error", status });
    }
    const asOf = extractAsOf(body);
    const linesNorm = toLines(body, false);
    loginsCache = { ts: Date.now(), raw: body, lines: linesNorm, asOf };
    res.json({
      cached: false,
      as_of: asOf,
      count: (rawMode ? toLines(body, true) : linesNorm).length,
      lines: rawMode ? toLines(body, true) : linesNorm
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// EchoLink: strukturierte Logins (Dropdown-tauglich)
app.get("/api/echolink/logins_structured", async (_req, res) => {
  try {
    if (Date.now() - loginsStructCache.ts < LOGINS_STRUCT_CACHE_MS && loginsStructCache.items.length) {
      return res.json({ cached: true, count: loginsStructCache.items.length, items: loginsStructCache.items });
    }

    const { status, body } = await fetchWithUA("https://www.echolink.org/logins.jsp");
    if (status !== 200 || !body) {
      console.warn("[logins_structured] upstream error", status);
      return res.json({ cached: false, count: 0, items: [] });
    }

    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[0]);
    const items = [];
    for (const row of rows) {
      const it = parseRow(row);
      if (it) items.push(it);
    }

    loginsStructCache = { ts: Date.now(), items };
    res.json({ cached: false, count: items.length, items });
  } catch (e) {
    console.error("[logins_structured] error:", e.message || e);
    res.json({ cached: false, count: 0, items: [] });
  }
});

// (optional) SPA-Fallback am Ende:
// if (FRONTEND_DIR && fss.existsSync(FRONTEND_DIR)) {
//   app.get("*", (req, res, next) => {
//     if (req.path.startsWith("/api/")) return next();
//     res.sendFile(path.join(FRONTEND_DIR, "index.html"));
//   });
// }

// Routenübersicht beim Start ins Log
setTimeout(() => {
  try {
    const lines = __routes.map(r => `${(r.methods||[]).join(",").padEnd(12)} ${r.path}`);
    console.log("[svxweb] registered routes:\n" + lines.join("\n"));
  } catch (e) {
    console.warn("[svxweb] cannot list routes:", e.message || e);
  }
}, 0);


// Start
app.listen(PORT, () => {
  console.log(`[svxweb] listening on :${PORT}`);
  console.log(`[svxweb] service=${SERVICE} config_dir=${CONFIG_DIR} pty=${DTMF_PTY} sudo=${USE_SUDO ? "on" : "off"}`);
});
