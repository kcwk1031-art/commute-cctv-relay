const TDX_CCTV_URL = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$format=JSON";
const CAMERA_CACHE_MS = 6 * 60 * 60 * 1000;
const ROAD_REFRESH_MS = 15 * 1000;
const MAX_CAMERA_DISTANCE_METERS = 5000;
const CAMERA_SWITCH_METERS = 500;
const MAX_LOCATION_ACCURACY_METERS = 150;
const LOCATION_OPTIONS = { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 };
const proxyStorageKey = "commute-cctv-proxy-base-v1";
const relayStorageKey = "commute-cctv-relay-base-v1";

const el = {
  locationState: document.querySelector("#locationState"),
  sourceChip: document.querySelector("#sourceChip"),
  roadLabel: document.querySelector("#roadLabel"),
  roadDetail: document.querySelector("#roadDetail"),
  cameraStage: document.querySelector("#cameraStage"),
  cctvImage: document.querySelector("#cctvImage"),
  cameraPlaceholder: document.querySelector("#cameraPlaceholder"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  cameraStatus: document.querySelector("#cameraStatus"),
  cameraAge: document.querySelector("#cameraAge"),
  gpsSpeed: document.querySelector("#gpsSpeed"),
  cameraDistance: document.querySelector("#cameraDistance"),
  vdSpeed: document.querySelector("#vdSpeed"),
  speedLimit: document.querySelector("#speedLimit"),
  observation: document.querySelector("#observation"),
  observationTitle: document.querySelector("#observationTitle"),
  observationDetail: document.querySelector("#observationDetail"),
  startDrive: document.querySelector("#startDrive"),
  stopDrive: document.querySelector("#stopDrive"),
  openSettings: document.querySelector("#openSettings"),
  settingsDialog: document.querySelector("#settingsDialog"),
  proxyEndpoint: document.querySelector("#proxyEndpoint"),
  relayEndpoint: document.querySelector("#relayEndpoint"),
  saveSettings: document.querySelector("#saveSettings"),
};

const state = {
  active: false,
  watchId: null,
  cctvs: [],
  cctvsLoadedAt: 0,
  currentCamera: null,
  previousPoint: null,
  lastPoint: null,
  imageLoadedAt: 0,
  refreshTimer: null,
  imageToken: 0,
  proxyBase: normalizeProxyBase(localStorage.getItem(proxyStorageKey) || window.DRIVE_CONFIG?.cctvProxyBase || ""),
  relayBase: normalizeRelayBase(localStorage.getItem(relayStorageKey) || window.DRIVE_CONFIG?.cctvRelayBase || ""),
};

function normalizeProxyBase(value) {
  const base = String(value || "").trim().replace(/\/$/, "");
  return /^https:\/\//i.test(base) ? base : "";
}

function normalizeRelayBase(value) {
  const base = String(value || "").trim().replace(/\/$/, "");
  try {
    const url = new URL(base);
    if (url.protocol === "https:") return base;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return base;
  } catch (_) {
    // Invalid values are treated as not configured.
  }
  return "";
}

function setSource(label, level = "waiting") {
  el.sourceChip.textContent = label;
  el.sourceChip.dataset.level = level;
}

function setObservation(title, detail, level = "waiting") {
  el.observationTitle.textContent = title;
  el.observationDetail.textContent = detail;
  el.observation.dataset.level = level;
}

function setCameraPlaceholder(title, detail, stage = "waiting") {
  el.cameraStage.dataset.state = stage;
  el.cctvImage.hidden = true;
  el.cameraPlaceholder.hidden = false;
  el.cameraPlaceholder.querySelector("strong").textContent = title;
  el.cameraPlaceholder.querySelector("small").textContent = detail;
  el.cameraOverlay.hidden = true;
}

function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function formatDirection(direction) {
  const normalized = String(direction || "").toUpperCase();
  if (normalized.includes("N")) return "北向";
  if (normalized.includes("S")) return "南向";
  if (normalized.includes("E")) return "東向";
  if (normalized.includes("W")) return "西向";
  return "方向待確認";
}

function timeoutFetch(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timer));
}

async function getCctvList() {
  if (state.cctvs.length && Date.now() - state.cctvsLoadedAt < CAMERA_CACHE_MS) return state.cctvs;
  const listUrl = state.proxyBase ? `${state.proxyBase}/v1/cameras` : TDX_CCTV_URL;
  const response = await timeoutFetch(listUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`CCTV 清單讀取失敗 (${response.status})`);
  const payload = await response.json();
  const rawCameras = state.proxyBase ? (payload.cameras || []) : (payload.CCTVs || []);
  state.cctvs = rawCameras
    .filter((camera) => {
      const id = state.proxyBase ? camera.id : camera.CCTVID;
      const mediaUrl = state.proxyBase ? camera.mediaUrl : camera.VideoStreamURL;
      return id && mediaUrl && Number(camera.lat ?? camera.PositionLat) && Number(camera.lng ?? camera.PositionLon);
    })
    .map((camera) => ({
      id: state.proxyBase ? camera.id : camera.CCTVID,
      road: camera.road || camera.RoadName || camera.RoadID || "國道路段",
      direction: camera.direction || camera.Direction || "",
      mile: camera.mile || camera.LocationMile || camera.Mile || "",
      section: camera.section || camera.LocationName || "",
      lat: Number(camera.lat ?? camera.PositionLat),
      lng: Number(camera.lng ?? camera.PositionLon),
      mediaUrl: camera.mediaUrl || camera.VideoStreamURL,
    }));
  state.cctvsLoadedAt = Date.now();
  return state.cctvs;
}

function radians(value) { return value * Math.PI / 180; }

function distanceBetween(a, b) {
  const earth = 6371000;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLng = radians(b.lng - a.lng);
  const latA = radians(a.lat);
  const latB = radians(b.lat);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingBetween(a, b) {
  const latA = radians(a.lat);
  const latB = radians(b.lat);
  const deltaLng = radians(b.lng - a.lng);
  const y = Math.sin(deltaLng) * Math.cos(latB);
  const x = Math.cos(latA) * Math.sin(latB) - Math.sin(latA) * Math.cos(latB) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDelta(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function deriveHeading(point) {
  if (Number.isFinite(point.heading) && point.heading >= 0) return point.heading;
  if (state.previousPoint && distanceBetween(state.previousPoint, point) >= 20) return bearingBetween(state.previousPoint, point);
  return NaN;
}

function selectForwardCamera(point, heading) {
  const candidates = state.cctvs
    .map((camera) => {
      const distance = distanceBetween(point, camera);
      const bearing = bearingBetween(point, camera);
      const bearingDelta = Number.isFinite(heading) ? Math.abs(angleDelta(heading, bearing)) : 0;
      return { ...camera, distance, bearingDelta, score: distance + bearingDelta * 12 };
    })
    .filter((camera) => camera.distance <= MAX_CAMERA_DISTANCE_METERS)
    .filter((camera) => !Number.isFinite(heading) || camera.bearingDelta <= 75)
    .sort((a, b) => a.score - b.score);

  const current = candidates.find((camera) => camera.id === state.currentCamera?.id);
  if (current && (!Number.isFinite(heading) || current.bearingDelta <= 75) && current.distance >= CAMERA_SWITCH_METERS) return current;
  return candidates.find((camera) => camera.distance >= CAMERA_SWITCH_METERS) || candidates[0] || null;
}

function streamUrl(camera) {
  if (state.relayBase) return `${state.relayBase}/mjpeg/${encodeURIComponent(camera.id)}`;
  if (state.proxyBase) return `${state.proxyBase}/v1/stream?id=${encodeURIComponent(camera.id)}`;
  return camera.mediaUrl;
}

function updateImageAge() {
  if (state.imageLoadedAt && (state.proxyBase || state.relayBase) && el.cameraStage.dataset.state === "ready") {
    // MJPEG <img> does not expose a per-frame heartbeat, so do not claim the feed is live.
    el.cameraAge.textContent = "串流已連線";
    return;
  }
  if (!state.imageLoadedAt) {
    el.cameraAge.textContent = "--";
    return;
  }
  const age = Math.max(0, Math.floor((Date.now() - state.imageLoadedAt) / 1000));
  el.cameraAge.textContent = age < 60 ? `${age} 秒前` : `${Math.floor(age / 60)} 分前`;
}

function loadCameraStream(camera) {
  const token = ++state.imageToken;
  state.imageLoadedAt = 0;
  el.cameraStage.dataset.state = "loading";
  el.cameraStatus.textContent = "連線即時影像中";
  el.cctvImage.hidden = true;
  el.cameraOverlay.hidden = true;
  el.cameraPlaceholder.hidden = false;
  el.cameraPlaceholder.querySelector("strong").textContent = "正在切換前方影像";
  el.cameraPlaceholder.querySelector("small").textContent = "確認鏡頭連線後才會顯示畫面。";
  el.cctvImage.onload = () => {
    if (token !== state.imageToken) return;
    el.cctvImage.hidden = false;
    el.cameraPlaceholder.hidden = true;
    el.cameraOverlay.textContent = `${camera.road} ${formatDirection(camera.direction)}｜${camera.mile || "里程待確認"}`;
    el.cameraOverlay.hidden = false;
    el.cameraStage.dataset.state = "ready";
    state.imageLoadedAt = Date.now();
    el.cameraStatus.textContent = state.relayBase ? "即時串流" : "來源串流";
    updateImageAge();
  };
  el.cctvImage.onerror = () => {
    if (token !== state.imageToken) return;
    state.imageLoadedAt = 0;
    el.cameraStage.dataset.state = "error";
    setCameraPlaceholder("影像暫不可用", state.relayBase ? "Relay 無法取得此鏡頭，系統將在下一次更新時重試。" : "此鏡頭為 MJPEG，請先設定影像 Relay。", "error");
    el.cameraStatus.textContent = "影像讀取失敗";
    setSource("影像暫不可用", "error");
    setObservation("影像串流暫時中斷", "已保留前方鏡頭；系統會在下一次更新時自動重新連線。", "warning");
  };
  const source = streamUrl(camera);
  el.cctvImage.src = `${source}${source.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

async function refreshRoadInformation(point) {
  const heading = deriveHeading(point);
  try {
    await getCctvList();
    const selected = selectForwardCamera(point, heading);
    if (!selected) {
      setSource("前方無可確認鏡頭", "warning");
      el.roadLabel.textContent = "目前位置前方沒有可確認國道影像";
      el.roadDetail.textContent = "未確認道路與方向時，不改抓平行道路的最近鏡頭。";
      el.cameraDistance.textContent = "--";
      setCameraPlaceholder("前方無可確認影像", "保持定位後會自動再找。", "waiting");
      setObservation("資料不足", "位置或方向尚未足以確認同向前方鏡頭。", "warning");
      return;
    }
    const changed = selected.id !== state.currentCamera?.id;
    state.currentCamera = selected;
    el.roadLabel.textContent = `${selected.road} ${formatDirection(selected.direction)}｜${selected.mile || "里程待確認"}`;
    el.roadDetail.textContent = selected.section || "附近前方國道 CCTV";
    el.cameraDistance.textContent = formatDistance(selected.distance);
    setSource(Number.isFinite(heading) ? "影像可參考" : "方向待確認", Number.isFinite(heading) ? "reference" : "warning");
    setObservation("前方道路影像", Number.isFinite(heading)
      ? `已選擇 ${formatDistance(selected.distance)} 前方鏡頭；接近 500 公尺後會重新選擇。`
      : "定位已取得，等待移動方向確認後提高鏡頭比對可信度。", "reference");
    if (changed || !state.imageLoadedAt) loadCameraStream(selected);
  } catch (error) {
    setSource("CCTV 清單失敗", "error");
    setObservation("道路資料暫不可用", error.name === "AbortError" ? "讀取逾時，將在下一次定位更新時重試。" : "無法讀取 CCTV 清單，請確認網路後重試。", "error");
  }
}

function handlePosition(position) {
  const point = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    heading: position.coords.heading,
    speed: position.coords.speed,
  };
  el.locationState.textContent = `定位正常｜誤差 ${Math.round(point.accuracy)} m`;
  el.gpsSpeed.textContent = Number.isFinite(point.speed) && point.speed >= 0 ? String(Math.round(point.speed * 3.6)) : "--";
  if (point.accuracy > MAX_LOCATION_ACCURACY_METERS) {
    setSource("位置確認中", "warning");
    setObservation("定位誤差較大", "目前不顯示路段、速限或鏡頭，避免顯示錯誤道路。", "warning");
    state.previousPoint = state.lastPoint;
    state.lastPoint = point;
    return;
  }
  void refreshRoadInformation(point);
  state.previousPoint = state.lastPoint;
  state.lastPoint = point;
}

function handleLocationError(error) {
  const messages = {
    1: "定位權限未允許。請在 Safari 網站設定中允許定位。",
    2: "目前無法取得位置。請確認手機定位服務已開啟。",
    3: "定位逾時，保持畫面開啟後會自動重試。",
  };
  el.locationState.textContent = "定位暫不可用";
  setSource("定位失敗", "error");
  setObservation("未啟動道路判讀", messages[error.code] || "定位服務暫時失敗。", "error");
}

function startDrive() {
  if (!navigator.geolocation) {
    setObservation("此瀏覽器不支援定位", "請改用 Safari 或已安裝的原生 App。", "error");
    return;
  }
  if (!state.proxyBase) {
    setSource("影像服務未設定", "warning");
    setObservation("請先設定影像服務", "此測試版需要 CCTV Proxy 網址，才能在 iPhone 顯示國道即時畫面。", "warning");
    el.openSettings.focus();
    return;
  }
  if (state.active) return;
  state.active = true;
  el.startDrive.hidden = true;
  el.stopDrive.hidden = false;
  el.locationState.textContent = "正在確認定位";
  setSource("定位啟動中", "waiting");
  setObservation("正在尋找前方影像", "定位確認後會自動選擇前方候選鏡頭。", "waiting");
  state.watchId = navigator.geolocation.watchPosition(handlePosition, handleLocationError, LOCATION_OPTIONS);
  state.refreshTimer = window.setInterval(() => {
    if (state.lastPoint) void refreshRoadInformation(state.lastPoint);
    updateImageAge();
  }, ROAD_REFRESH_MS);
}

function stopDrive() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  if (state.refreshTimer !== null) window.clearInterval(state.refreshTimer);
  state.watchId = null;
  state.refreshTimer = null;
  state.active = false;
  state.imageToken += 1;
  state.imageLoadedAt = 0;
  el.cctvImage.onload = null;
  el.cctvImage.onerror = null;
  el.cctvImage.removeAttribute("src");
  setCameraPlaceholder("即時道路資訊已停止", "再次啟動後，會重新確認定位與前方鏡頭。", "waiting");
  el.cameraStatus.textContent = "影像待命";
  el.cameraAge.textContent = "--";
  el.startDrive.hidden = false;
  el.stopDrive.hidden = true;
  el.locationState.textContent = "定位已停止";
  setSource("資料待命", "waiting");
  setObservation("即時道路資訊已停止", "影像不再自動更新。", "waiting");
}

function saveProxySetting() {
  state.proxyBase = normalizeProxyBase(el.proxyEndpoint.value);
  state.relayBase = normalizeRelayBase(el.relayEndpoint.value);
  if (state.proxyBase) localStorage.setItem(proxyStorageKey, state.proxyBase);
  else localStorage.removeItem(proxyStorageKey);
  if (state.relayBase) localStorage.setItem(relayStorageKey, state.relayBase);
  else localStorage.removeItem(relayStorageKey);
  state.cctvs = [];
  state.cctvsLoadedAt = 0;
  state.currentCamera = null;
  state.imageLoadedAt = 0;
  el.settingsDialog.close();
  if (state.lastPoint) void refreshRoadInformation(state.lastPoint);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) updateImageAge();
  if (!document.hidden && state.active && state.lastPoint) void refreshRoadInformation(state.lastPoint);
});

el.openSettings.addEventListener("click", () => {
  el.proxyEndpoint.value = state.proxyBase;
  el.relayEndpoint.value = state.relayBase;
  el.settingsDialog.showModal();
});
el.saveSettings.addEventListener("click", saveProxySetting);
el.startDrive.addEventListener("click", startDrive);
el.stopDrive.addEventListener("click", stopDrive);
window.setInterval(updateImageAge, 1000);

if (!state.proxyBase) {
  setSource("影像服務未設定", "warning");
  setObservation("請先設定影像服務", "設定完成後，才會讀取定位並載入前方道路影像。", "warning");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
