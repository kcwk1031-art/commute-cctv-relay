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
const mjpegIdleMs = Math.max(5000, Number(process.env.MJPEG_IDLE_MS || 15000));
const mjpegMaxClientBufferBytes = Math.max(256 * 1024, Number(process.env.MJPEG_MAX_CLIENT_BUFFER_BYTES || 1024 * 1024));
const cameraCatalogUrl = String(process.env.CAMERA_CATALOG_URL || "").trim();
const catalogCacheMs = 15 * 60 * 1000;
const vdCacheMs = Math.max(30 * 1000, Number(process.env.VD_CACHE_MS || 55 * 1000));
const mjpegFpsWindowMs = Math.max(5 * 1000, Number(process.env.MJPEG_FPS_WINDOW_MS || 10 * 1000));
const TDX_CCTV_URL = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$format=JSON";
const TDX_VD_URL = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON";
const TDX_TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const tdxClientId = String(process.env.TDX_CLIENT_ID || "").trim();
const tdxClientSecret = String(process.env.TDX_CLIENT_SECRET || "").trim();
const enableLegacyHls = String(process.env.ENABLE_LEGACY_HLS || "").toLowerCase() === "true";
const cameras = {
  "30001": process.env.CAMERA_30001_URL || "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=30001",
};
const processes = new Map();
const mjpegSessions = new Map();
const mjpegSessionPromises = new Map();
let catalogCache = { expiresAt: 0, cameras: new Map() };
let tdxTokenCache = { expiresAt: 0, token: "" };
const vdCacheByRoute = new Map();

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
  sendJpeg(response, jpeg);
}

function sendJpeg(response, jpeg) {
  response.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(jpeg);
}

async function serveLatestSnapshot(response, id) {
  const session = mjpegSessions.get(id);
  const newestFrameIsUsable = session?.latestJpeg
    && Date.now() - session.latestJpegAt <= staleAfterMs;
  if (newestFrameIsUsable) return sendJpeg(response, session.latestJpeg);
  return serveSnapshot(response, id);
}

function serveEmbeddedPlayer(response, id) {
  const safeId = String(id).replace(/[^A-Za-z0-9_.-]/g, "");
  const source = `/mjpeg/${encodeURIComponent(safeId)}`;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:#071c18;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img id="camera" alt="國道即時影像" src="${source}"><script>const image=document.querySelector('#camera');image.addEventListener('error',()=>setTimeout(()=>{image.src='${source}?t='+Date.now()},3000));</script></body></html>`);
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

function asArray(value, nestedKey = "") {
  if (Array.isArray(value)) return value;
  if (nestedKey && Array.isArray(value?.[nestedKey])) return value[nestedKey];
  return [];
}

function parseKilometers(value) {
  const text = String(value || "").trim().toUpperCase();
  const kilometerMatch = text.match(/(\d+(?:\.\d+)?)\s*K\s*\+\s*(\d+(?:\.\d+)?)/);
  if (kilometerMatch) return Number(kilometerMatch[1]) + Number(kilometerMatch[2]) / 1000;
  const decimalMatch = text.match(/(\d+(?:\.\d+)?)/);
  return decimalMatch ? Number(decimalMatch[1]) : NaN;
}

function routeFromCameraId(id) {
  return String(id || "").toUpperCase().match(/^CCTV-(N\d+[A-Z]?)-/)?.[1] || "";
}

function routeFromVdId(id) {
  const match = String(id || "").toUpperCase().match(/(?:^|-)N(\d+[A-Z]?)(?:-|$)/);
  return match ? `N${match[1]}` : "";
}

function directionFromId(id) {
  return String(id || "").toUpperCase().match(/-(N|S|E|W)-/)?.[1] || "";
}

function mileFromVdId(id) {
  const text = String(id || "");
  const directionIndex = text.toUpperCase().search(/-(N|S|E|W)-/);
  const afterDirection = directionIndex >= 0 ? text.slice(directionIndex + 3) : text;
  const match = afterDirection.match(/(?:^|-)(\d{1,3}(?:\.\d+)?)(?:-|$)/);
  return match ? Number(match[1]) : NaN;
}

function metricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeLane(rawLane) {
  const vehicles = asArray(rawLane?.Vehicles, "Vehicle");
  const volume = vehicles.reduce((total, vehicle) => total + (metricNumber(vehicle?.Volume) ?? 0), 0);
  return {
    laneId: String(rawLane?.LaneID ?? ""),
    laneType: Number(rawLane?.LaneType) || null,
    speedKph: metricNumber(rawLane?.Speed),
    occupancy: metricNumber(rawLane?.Occupancy),
    volume,
  };
}

function normalizeLinkFlows(vd) {
  return asArray(vd?.LinkFlows, "LinkFlow")
    .map((linkFlow) => ({
      linkId: String(linkFlow?.LinkID || ""),
      lanes: asArray(linkFlow?.Lanes, "Lane")
        .map(normalizeLane)
        .filter((lane) => lane.laneId),
    }))
    .filter((linkFlow) => linkFlow.lanes.length);
}

function isMainlineLane(lane) {
  // TDX lane codes 1, 2 and 3 are general, fast and slow lanes. Exclude shoulders and auxiliary lanes.
  return [1, 2, 3].includes(lane.laneType) && lane.speedKph !== null;
}

function buildFlowReference(lanes) {
  const candidates = lanes.filter(isMainlineLane);
  if (candidates.length < 2) {
    return { state: "insufficient", label: "主線車道資料不足", detail: "未取得至少兩條有效主線車道資料，不比較車道。" };
  }

  const scored = candidates.map((lane) => ({
    ...lane,
    score: lane.speedKph - (lane.occupancy ?? 0) * 0.35,
  })).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  const speedGap = best.speedKph - next.speedKph;
  const occupancyGap = (next.occupancy ?? 0) - (best.occupancy ?? 0);
  if (speedGap < 8 && occupancyGap < 5) {
    return {
      state: "similar",
      label: "各主線車道差異不明顯",
      detail: "官方 VD 資料未顯示足夠差異，維持原車道較合適。",
    };
  }

  return {
    state: "reference",
    bestLaneId: best.laneId,
    label: `第 ${best.laneId} 車道車流較順`,
    detail: `官方 VD 顯示 ${best.speedKph} km/h，較下一車道快 ${Math.round(speedGap)} km/h。僅供路況參考，不構成變換車道指令。`,
  };
}

async function getTdxVdLives(route) {
  const cached = vdCacheByRoute.get(route);
  if (cached && Date.now() < cached.expiresAt) return cached.records;

  const token = await getTdxAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const requestUrl = new URL(TDX_VD_URL);
  if (route) requestUrl.searchParams.set("$filter", `contains(VDID,'${route}')`);
  let response = await fetch(requestUrl, { headers });
  // Some TDX deployments reject OData contains filters. Retrying the base endpoint keeps the feature available.
  if (!response.ok && route) response = await fetch(TDX_VD_URL, { headers });
  if (!response.ok) throw new Error(`TDX VD request failed (${response.status})`);
  const payload = await response.json();
  let records = asArray(payload?.VDLives || payload, "VDLive")
    .filter((vd) => !route || routeFromVdId(vd?.VDID) === route);
  // A few gateways accept an unsupported filter but return an empty 200 response.
  if (route && !records.length && requestUrl.href !== TDX_VD_URL) {
    const fallback = await fetch(TDX_VD_URL, { headers });
    if (!fallback.ok) throw new Error(`TDX VD fallback request failed (${fallback.status})`);
    const fallbackPayload = await fallback.json();
    records = asArray(fallbackPayload?.VDLives || fallbackPayload, "VDLive")
      .filter((vd) => routeFromVdId(vd?.VDID) === route);
  }
  vdCacheByRoute.set(route, { expiresAt: Date.now() + vdCacheMs, records });
  return records;
}

async function getLaneObservation(cameraId) {
  const catalog = await getCameraCatalog();
  const camera = catalog.get(String(cameraId));
  if (!camera) return { ok: false, error: "camera_not_found" };

  const route = routeFromCameraId(camera.id);
  const direction = directionFromId(camera.id);
  const cameraMile = parseKilometers(camera.mile);
  if (!route || !direction || !Number.isFinite(cameraMile)) {
    return { ok: false, error: "camera_route_not_resolved" };
  }

  const candidates = (await getTdxVdLives(route))
    .map((vd) => {
      const mile = mileFromVdId(vd?.VDID);
      const linkFlows = normalizeLinkFlows(vd);
      return {
        id: String(vd?.VDID || ""),
        direction: directionFromId(vd?.VDID),
        mile,
        status: Number(vd?.Status),
        dataCollectTime: vd?.DataCollectTime || vd?.UpdateTime || "",
        linkFlows,
        distanceKm: Number.isFinite(mile) ? Math.abs(mile - cameraMile) : Infinity,
      };
    })
    .filter((vd) => vd.direction === direction && vd.status === 0 && vd.linkFlows.length && Number.isFinite(vd.distanceKm))
    .sort((left, right) => left.distanceKm - right.distanceKm);

  const nearest = candidates[0];
  if (!nearest || nearest.distanceKm > 3) {
    return {
      ok: false,
      error: "nearby_vd_not_available",
      camera: { id: camera.id, road: camera.road, direction: camera.direction, mile: camera.mile },
    };
  }

  const mainFlow = [...nearest.linkFlows]
    .sort((left, right) => right.lanes.filter(isMainlineLane).length - left.lanes.filter(isMainlineLane).length)[0];
  const lanes = mainFlow.lanes.sort((left, right) => Number(left.laneId) - Number(right.laneId));
  const mainLaneCount = lanes.filter(isMainlineLane).length;
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    camera: { id: camera.id, road: camera.road, direction: camera.direction, mile: camera.mile },
    vd: {
      id: nearest.id,
      distanceKm: Number(nearest.distanceKm.toFixed(2)),
      dataCollectTime: nearest.dataCollectTime,
      linkId: mainFlow.linkId,
    },
    mainLaneCount,
    lanes,
    flowReference: buildFlowReference(lanes),
  };
}

function stopMjpegSession(id, session) {
  if (mjpegSessions.get(id) !== session) return;
  session.stopped = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.restartTimer) clearTimeout(session.restartTimer);
  if (session.child && !session.child.killed) session.child.kill("SIGKILL");
  mjpegSessions.delete(id);
}

function scheduleMjpegSessionStop(id, session) {
  if (session.clients.size || session.idleTimer) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (!session.clients.size) stopMjpegSession(id, session);
  }, mjpegIdleMs);
  session.idleTimer.unref();
}

function scheduleMjpegSessionRestart(session) {
  if (session.stopped || !session.clients.size || session.restartTimer) return;
  session.restartTimer = setTimeout(() => {
    session.restartTimer = null;
    startMjpegSession(session);
  }, restartDelayMs);
  session.restartTimer.unref();
}

function noteMjpegFrames(session, chunk) {
  const now = Date.now();
  for (const byte of chunk) {
    if (session.lastMjpegByte === 0xff && byte === 0xd8) {
      session.frameTimes.push(now);
      session.frameCount += 1;
    }
    session.lastMjpegByte = byte;
  }
  const cutoff = now - mjpegFpsWindowMs;
  while (session.frameTimes.length && session.frameTimes[0] < cutoff) session.frameTimes.shift();
}

function captureLatestJpeg(session, chunk) {
  session.jpegBuffer = Buffer.concat([session.jpegBuffer, chunk]);
  let cursor = 0;
  while (true) {
    const start = session.jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    const end = start >= 0
      ? session.jpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      : -1;
    if (start < 0 || end < 0) break;
    session.latestJpeg = Buffer.from(session.jpegBuffer.subarray(start, end + 2));
    session.latestJpegAt = Date.now();
    cursor = end + 2;
  }
  if (cursor) {
    session.jpegBuffer = session.jpegBuffer.subarray(cursor);
  } else if (session.jpegBuffer.length > 4 * 1024 * 1024) {
    const lastStart = session.jpegBuffer.lastIndexOf(Buffer.from([0xff, 0xd8]));
    session.jpegBuffer = lastStart >= 0
      ? session.jpegBuffer.subarray(lastStart)
      : session.jpegBuffer.subarray(-1024 * 1024);
  }
}

function observedMjpegFps(session, now = Date.now()) {
  if (!session.frameTimes.length) return 0;
  const firstFrameAt = session.frameTimes[0];
  const sampleMs = Math.max(1000, now - Math.max(firstFrameAt, session.startedAt || firstFrameAt));
  return Number((session.frameTimes.length * 1000 / sampleMs).toFixed(1));
}

function broadcastMjpegChunk(session, chunk) {
  captureLatestJpeg(session, chunk);
  noteMjpegFrames(session, chunk);
  session.lastFrameAt = Date.now();
  for (const response of session.clients) {
    if (response.destroyed || response.writableEnded) {
      session.clients.delete(response);
      continue;
    }
    // A slow phone must not buffer unlimited video in the free relay process.
    if (response.writableLength > mjpegMaxClientBufferBytes) {
      response.destroy();
      session.clients.delete(response);
      continue;
    }
    response.write(chunk);
  }
  if (!session.clients.size) scheduleMjpegSessionStop(session.id, session);
}

function startMjpegSession(session) {
  if (session.stopped || !session.clients.size || session.child) return;
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "1",
    // Source timestamps are frequently declared as 25 FPS despite frames arriving slower.
    // Use arrival time and packet copy so the relay does not queue or invent frames.
    "-fflags", "+nobuffer+genpts", "-use_wallclock_as_timestamps", "1",
    "-analyzeduration", "0", "-probesize", "32",
    "-i", session.source,
    "-map", "0:v:0", "-an", "-c:v", "copy",
    "-f", "mpjpeg", "-boundary_tag", "cctv", "-flush_packets", "1", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  session.child = child;
  session.startedAt = Date.now();
  session.frameTimes = [];
  session.lastMjpegByte = -1;
  child.stderr.on("data", (chunk) => { session.lastError = chunk.toString().trim().slice(-400); });
  child.stdout.on("data", (chunk) => broadcastMjpegChunk(session, chunk));
  const restart = () => {
    if (session.child !== child) return;
    session.child = null;
    scheduleMjpegSessionRestart(session);
  };
  child.on("exit", restart);
  child.on("error", (error) => {
    session.lastError = error.message;
    restart();
  });
}

function getOrCreateMjpegSession(id) {
  const existing = mjpegSessions.get(id);
  if (existing) return Promise.resolve(existing);
  const pending = mjpegSessionPromises.get(id);
  if (pending) return pending;
  const creation = resolveCameraSource(id)
    .then((source) => {
      if (!source) return null;
      const readySession = mjpegSessions.get(id);
      if (readySession) return readySession;
      const session = {
        id,
        source,
        child: null,
        clients: new Set(),
        idleTimer: null,
      restartTimer: null,
      lastFrameAt: 0,
      lastError: "",
      startedAt: 0,
      frameTimes: [],
      frameCount: 0,
      lastMjpegByte: -1,
      latestJpeg: null,
      latestJpegAt: 0,
      jpegBuffer: Buffer.alloc(0),
      stopped: false,
      };
      mjpegSessions.set(id, session);
      return session;
    })
    .finally(() => mjpegSessionPromises.delete(id));
  mjpegSessionPromises.set(id, creation);
  return creation;
}

function ensureHealthyMjpegSessions() {
  for (const session of mjpegSessions.values()) {
    if (!session.child || !session.clients.size || session.stopped) continue;
    const latestActivity = session.lastFrameAt || session.startedAt;
    if (latestActivity && Date.now() - latestActivity > startupGraceMs) session.child.kill("SIGKILL");
  }
}

async function attachMjpegClient(response, id) {
  const session = await getOrCreateMjpegSession(id);
  if (!session) return sendJson(response, 404, { ok: false, error: "unknown_camera" });
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = null;
  response.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=cctv",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  session.clients.add(response);
  const detach = () => {
    if (!session.clients.delete(response)) return;
    scheduleMjpegSessionStop(id, session);
  };
  response.once("close", detach);
  response.once("error", detach);
  startMjpegSession(session);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    const streams = Object.fromEntries(Object.keys(cameras).map((id) => {
      const entry = processes.get(id);
      const ageMs = latestSegmentAgeMs(id);
      return [id, { state: ageMs <= staleAfterMs ? "ready" : "stale", ageMs: Number.isFinite(ageMs) ? Math.round(ageMs) : null, restarting: Boolean(entry?.restarting), error: entry?.lastError || null }];
    }));
    const mjpeg = Object.fromEntries([...mjpegSessions.entries()].map(([id, session]) => [id, {
      viewers: session.clients.size,
      state: session.lastFrameAt && Date.now() - session.lastFrameAt <= staleAfterMs ? "ready" : "starting",
      observedFps: observedMjpegFps(session),
      lastError: session.lastError || null,
    }]));
    const legacyHealthy = !enableLegacyHls || Object.values(streams).every((item) => item.state === "ready");
    const mjpegHealthy = Object.values(mjpeg).every((item) => item.state === "ready");
    return sendJson(response, 200, { ok: legacyHealthy && mjpegHealthy, streams, mjpeg });
  }

  if (url.pathname === "/v1/cameras") {
    return void getCameraCatalog()
      .then((catalog) => sendJson(response, 200, { updatedAt: new Date().toISOString(), cameras: [...catalog.values()] }))
      .catch((error) => sendJson(response, 502, { ok: false, error: "camera_catalog_unavailable", detail: error.message }));
  }

  const laneMatch = url.pathname.match(/^\/v1\/lanes\/([A-Za-z0-9_.-]+)$/);
  if (laneMatch) return void getLaneObservation(laneMatch[1])
    .then((observation) => sendJson(response, observation.ok ? 200 : 404, observation))
    .catch((error) => sendJson(response, 502, { ok: false, error: "lane_data_unavailable", detail: error.message }));

  const metricsMatch = url.pathname.match(/^\/v1\/stream-metrics\/([A-Za-z0-9_.-]+)$/);
  if (metricsMatch) {
    const session = mjpegSessions.get(metricsMatch[1]);
    if (!session) return sendJson(response, 200, {
      ok: true,
      cameraId: metricsMatch[1],
      state: "not_streaming",
      observedFps: 0,
      viewers: 0,
    });
    return sendJson(response, 200, {
      ok: true,
      cameraId: metricsMatch[1],
      state: session.lastFrameAt && Date.now() - session.lastFrameAt <= staleAfterMs ? "ready" : "starting",
      observedFps: observedMjpegFps(session),
      viewers: session.clients.size,
      framesDelivered: session.frameCount,
      startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
    });
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

  const embedMatch = url.pathname.match(/^\/embed\/([A-Za-z0-9_.-]+)$/);
  if (embedMatch) return void serveEmbeddedPlayer(response, embedMatch[1]);

  const snapshotMatch = url.pathname.match(/^\/snapshot\/([A-Za-z0-9_.-]+)$/);
  if (snapshotMatch) return void serveSnapshot(response, snapshotMatch[1]).catch((error) => {
    if (!response.headersSent) sendJson(response, 502, { ok: false, error: "camera_snapshot_unavailable", detail: error.message });
  });

  const latestMatch = url.pathname.match(/^\/latest\/([A-Za-z0-9_.-]+)$/);
  if (latestMatch) return void serveLatestSnapshot(response, latestMatch[1]).catch((error) => {
    if (!response.headersSent) sendJson(response, 502, { ok: false, error: "camera_snapshot_unavailable", detail: error.message });
  });

  // TDX CCTV IDs include decimal mile markers, for example CCTV-N3-N-27.083-M.
  const mjpegMatch = url.pathname.match(/^\/mjpeg\/([A-Za-z0-9_.-]+)$/);
  if (mjpegMatch) return void attachMjpegClient(response, mjpegMatch[1]).catch((error) => {
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
setInterval(ensureHealthyMjpegSessions, 3000).unref();
server.listen(port, "0.0.0.0", () => console.log(`CCTV media relay listening on :${port}`));

function shutdown() {
  for (const { child } of processes.values()) child.kill("SIGKILL");
  for (const [id, session] of mjpegSessions) stopMjpegSession(id, session);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
