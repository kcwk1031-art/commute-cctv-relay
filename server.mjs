import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 8788);
const streamRoot = resolve(process.env.HLS_DIR || join(process.cwd(), "data"));
const playerFile = resolve(process.cwd(), "player.html");
const directPlayerFile = resolve(process.cwd(), "direct-player.html");
const mjpegPlayerFile = resolve(process.cwd(), "mjpeg-player.html");
const staleAfterMs = Number(process.env.STREAM_STALE_MS || 12000);
const startupGraceMs = Number(process.env.STREAM_STARTUP_GRACE_MS || 20000);
const restartDelayMs = Number(process.env.RESTART_DELAY_MS || 250);
const cameraCatalogUrl = String(process.env.CAMERA_CATALOG_URL || "").trim();
const catalogCacheMs = 15 * 60 * 1000;
const TDX_CCTV_URL = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$format=JSON";
const TDX_TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const tdxClientId = String(process.env.TDX_CLIENT_ID || "").trim();
const tdxClientSecret = String(process.env.TDX_CLIENT_SECRET || "").trim();
const enableLegacyHls = String(process.env.ENABLE_LEGACY_HLS || "").toLowerCase() === "true";
const cameras = {
  "30001": process.env.CAMERA_30001_URL || "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=30001",
};
const processes = new Map();
let catalogCache = { expiresAt: 0, cameras: new Map() };
let tdxTokenCache = { expiresAt: 0, token: "" };

function streamDirectory(id) {
  return join(streamRoot, id);
}

function prepareStreamDirectory(id) {
  const directory = streamDirectory(id);
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    if (/\.(?:m3u8|ts)$/i.test(name)) unlinkSync(join(directory, name));
  }
}

function latestSegmentAgeMs(id) {
  const directory = streamDirectory(id);
  if (!existsSync(directory)) return Infinity;
  const segments = readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => statSync(join(directory, name)).mtimeMs);
  return segments.length ? Math.max(0, Date.now() - Math.max(...segments)) : Infinity;
}

function startCamera(id, source, clearOutput = false) {
  const previousError = processes.get(id)?.lastError || "";
  if (clearOutput) prepareStreamDirectory(id);
  else mkdirSync(streamDirectory(id), { recursive: true });
  const directory = streamDirectory(id);
  const args = [
    "-hide_banner", "-loglevel", "warning",
    // The official endpoint frequently closes MJPEG connections. Reconnect inside FFmpeg instead of rebuilding the player.
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "1",
    // The MJPEG endpoint timestamps frames as 25fps even though they arrive at about 5fps.
    // Rebuild timestamps from wall clock time, otherwise HLS plays several seconds too fast then freezes.
    "-use_wallclock_as_timestamps", "1", "-fflags", "+genpts",
    "-i", source,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    // Source PTS advances at 25fps while frames physically arrive at about 5fps.
    // Stretch the source timeline fivefold before encoding so cars move in real time.
    "-vf", "setpts=PTS*5", "-r", "5", "-g", "5", "-sc_threshold", "0",
    "-f", "hls", "-hls_time", "1", "-hls_list_size", "8",
    // The upstream source reconnects frequently. Never signal end-of-stream to the player between reconnects.
    "-hls_flags", "delete_segments+append_list+independent_segments+omit_endlist",
    "-hls_start_number_source", "epoch",
    "-hls_segment_filename", join(directory, "segment-%05d.ts"),
    join(directory, "index.m3u8"),
  ];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const entry = { child, source, startedAt: Date.now(), restarting: false, lastError: previousError };
  processes.set(id, entry);
  child.stderr.on("data", (chunk) => { entry.lastError = chunk.toString().trim().slice(-400); });
  child.on("exit", () => scheduleRestart(id));
  child.on("error", (error) => { entry.lastError = error.message; scheduleRestart(id); });
}

function scheduleRestart(id) {
  const entry = processes.get(id);
  if (!entry || entry.restarting) return;
  entry.restarting = true;
  setTimeout(() => startCamera(id, entry.source), restartDelayMs).unref();
}

function ensureHealthyStreams() {
  for (const [id, entry] of processes) {
    if (Date.now() - entry.startedAt < startupGraceMs) continue;
    if (entry.restarting || latestSegmentAgeMs(id) <= staleAfterMs) continue;
    // Let the exit handler schedule the restart; marking it early would suppress that handler.
    entry.child.kill("SIGKILL");
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(body));
}

function sendFile(response, file) {
  if (!existsSync(file)) return sendJson(response, 404, { ok: false, error: "stream segment not found" });
  const type = extname(file) === ".m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t";
  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  createReadStream(file).pipe(response);
}

async function getCameraCatalog() {
  if (Date.now() < catalogCache.expiresAt) return catalogCache.cameras;

  let entries;
  if (cameraCatalogUrl) {
    const response = await fetch(cameraCatalogUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`camera catalog failed (${response.status})`);
    const payload = await response.json();
    entries = Array.isArray(payload?.cameras) ? payload.cameras : [];
  } else {
    entries = await getTdxCameras();
  }

  catalogCache = {
    expiresAt: Date.now() + catalogCacheMs,
    cameras: new Map(entries
      .filter((camera) => camera?.id && /^https:\/\//i.test(String(camera.mediaUrl || "")))
      .map((camera) => [String(camera.id), camera])),
  };
  return catalogCache.cameras;
}

async function resolveCameraSource(id) {
  if (cameras[id]) return cameras[id];
  const catalog = await getCameraCatalog();
  return catalog.get(String(id))?.mediaUrl || null;
}

async function readJpegSnapshot(source) {
  const upstream = await fetch(source, { headers: { Accept: "multipart/x-mixed-replace,image/jpeg,*/*" } });
  if (!upstream.ok || !upstream.body) throw new Error(`upstream camera failed (${upstream.status})`);

  const reader = upstream.body.getReader();
  let buffer = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      const end = start >= 0 ? buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1;
      if (end >= 0) return buffer.subarray(start, end + 2);
      // Keep enough bytes to span a JPEG frame without allowing a broken source to grow memory indefinitely.
      if (buffer.length > 4 * 1024 * 1024) buffer = buffer.subarray(-1024 * 1024);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error("upstream camera ended before a JPEG frame arrived");
}

async function serveSnapshot(response, id) {
  const source = await resolveCameraSource(id);
  if (!source) return sendJson(response, 404, { ok: false, error: "camera_not_found" });
  const jpeg = await readJpegSnapshot(source);
  response.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(jpeg);
}

function inferDirectionFromCameraId(id) {
  // TDX frequently leaves Direction blank, while freeway CCTV IDs carry the cardinal direction.
  const match = String(id || "").toUpperCase().match(/-(N|S|E|W)-/);
  return match ? ({ N: "北向", S: "南向", E: "東向", W: "西向" })[match[1]] : "";
}

async function getTdxCameras() {
  const token = await getTdxAccessToken();
  const response = await fetch(TDX_CCTV_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`TDX CCTV request failed (${response.status})`);
  const payload = await response.json();
  return (payload.CCTVs || [])
    .filter((camera) => camera.CCTVID && camera.VideoStreamURL && Number(camera.PositionLat) && Number(camera.PositionLon))
    .map((camera) => ({
      id: camera.CCTVID,
      road: camera.RoadName || camera.RoadID || "國道路段",
      direction: camera.Direction || inferDirectionFromCameraId(camera.CCTVID),
      mile: camera.LocationMile || camera.Mile || "",
      section: camera.LocationName || "",
      lat: Number(camera.PositionLat),
      lng: Number(camera.PositionLon),
      mediaUrl: camera.VideoStreamURL,
    }));
}

async function getTdxAccessToken() {
  if (!tdxClientId || !tdxClientSecret) throw new Error("tdx_credentials_missing");
  if (Date.now() < tdxTokenCache.expiresAt) return tdxTokenCache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: tdxClientId,
    client_secret: tdxClientSecret,
  });
  const response = await fetch(TDX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`TDX token request failed (${response.status})`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error("TDX token response missing access_token");
  const ttlMs = Math.max(60, Math.min(Number(payload.expires_in || 1500) - 60, 1500)) * 1000;
  tdxTokenCache = { token: payload.access_token, expiresAt: Date.now() + ttlMs };
  return tdxTokenCache.token;
}

async function streamBrowserMjpeg(response, id) {
  const source = await resolveCameraSource(id);
  if (!source) return sendJson(response, 404, { ok: false, error: "unknown camera" });

  // Chrome may render the official multipart BMP feed as black. Re-encode only the frame format
  // to JPEG and preserve frame arrival order, avoiding HLS buffering and timestamp distortion.
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "1",
    "-i", source,
    "-an", "-c:v", "mjpeg", "-q:v", "4",
    "-f", "mpjpeg", "-boundary_tag", "cctv", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  response.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=cctv",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Connection": "keep-alive",
  });
  child.stdout.pipe(response);
  const close = () => child.kill("SIGKILL");
  response.on("close", close);
  child.on("error", close);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    const streams = Object.fromEntries(Object.keys(cameras).map((id) => {
      const entry = processes.get(id);
      const ageMs = latestSegmentAgeMs(id);
      return [id, { state: ageMs <= staleAfterMs ? "ready" : "stale", ageMs: Number.isFinite(ageMs) ? Math.round(ageMs) : null, restarting: Boolean(entry?.restarting), error: entry?.lastError || null }];
    }));
    return sendJson(response, 200, { ok: Object.values(streams).every((item) => item.state === "ready"), streams });
  }

  if (url.pathname === "/v1/cameras") {
    return void getCameraCatalog()
      .then((catalog) => sendJson(response, 200, { updatedAt: new Date().toISOString(), cameras: [...catalog.values()] }))
      .catch((error) => sendJson(response, 502, { ok: false, error: "camera_catalog_unavailable", detail: error.message }));
  }

  if (url.pathname === "/player") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(readFileSync(mjpegPlayerFile));
  }

  if (url.pathname === "/hls-player") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(readFileSync(playerFile));
  }

  if (url.pathname === "/direct") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(readFileSync(directPlayerFile));
  }

  if (url.pathname === "/mjpeg-player") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(readFileSync(mjpegPlayerFile));
  }

  const snapshotMatch = url.pathname.match(/^\/snapshot\/([A-Za-z0-9_.-]+)$/);
  if (snapshotMatch) return void serveSnapshot(response, snapshotMatch[1]).catch((error) => {
    if (!response.headersSent) sendJson(response, 502, { ok: false, error: "camera_snapshot_unavailable", detail: error.message });
  });

  // TDX CCTV IDs include decimal mile markers, for example CCTV-N3-N-27.083-M.
  const mjpegMatch = url.pathname.match(/^\/mjpeg\/([A-Za-z0-9_.-]+)$/);
  if (mjpegMatch) return void streamBrowserMjpeg(response, mjpegMatch[1]).catch((error) => {
    if (!response.headersSent) sendJson(response, 502, { ok: false, error: "camera_catalog_unavailable", detail: error.message });
  });

  const match = url.pathname.match(/^\/streams\/([A-Za-z0-9_-]+)\/(index\.m3u8|segment-\d+\.ts)$/);
  if (!match) return sendJson(response, 404, { ok: false, error: "not found" });
  const [, id, file] = match;
  if (!cameras[id] || basename(file) !== file) return sendJson(response, 404, { ok: false, error: "unknown camera" });
  return sendFile(response, join(streamDirectory(id), file));
});

// MJPEG is the production path. The legacy FFmpeg/HLS process costs CPU even without viewers.
if (enableLegacyHls) {
  for (const [id, source] of Object.entries(cameras)) startCamera(id, source, true);
  setInterval(ensureHealthyStreams, 3000).unref();
}
server.listen(port, "0.0.0.0", () => console.log(`CCTV media relay listening on :${port}`));

function shutdown() {
  for (const { child } of processes.values()) child.kill("SIGKILL");
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
