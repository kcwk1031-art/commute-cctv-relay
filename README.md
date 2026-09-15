# CCTV Media Relay

## TDX camera catalog

For GPS-based camera selection, set these Render environment variables:

```text
TDX_CLIENT_ID=<TDX Client ID>
TDX_CLIENT_SECRET=<TDX Client Secret>
```

The service then exposes `GET /v1/cameras`. Keep both values in Render only; never commit them to GitHub or put them in the App.

This service fans one official MJPEG source out to multiple viewers without re-encoding it. The relay reconnects automatically when an upstream MJPEG response ends, reports observed frame arrival rate, and reads the official TDX VD feed for per-lane traffic data.

## Local test

`ffmpeg` must be installed and available on `PATH`.

最簡單方式：雙擊 `啟動影像服務.cmd`，再在同一台電腦的瀏覽器開啟
`http://localhost:8788/player`。

或在 PowerShell 執行：

```powershell
cd media-relay
npm start
```

Check `http://localhost:8788/health`. For the current source frame rate and viewer count, use:

`http://localhost:8788/v1/stream-metrics/30001`

建議直接觀看：`http://localhost:8788/player`

這是將官方 MJPEG 以低延遲方式轉送給瀏覽器，不使用 HLS 緩衝。HLS 診斷頁保留於 `http://localhost:8788/hls-player`，不作為目前建議方案。

HLS 播放清單仍可供技術測試：

`http://localhost:8788/streams/30001/index.m3u8`

`localhost` 只代表這台電腦，手機不能用此網址。手機要觀看，必須將本服務部署到可公開存取的 Docker 主機，取得 HTTPS 網址後才可連線。

## App integration

The driving app can use this one public HTTPS Relay URL for both `鏡頭目錄 Proxy 網址` and `即時影像 Relay 網址`.

The Relay exposes:

- `GET /mjpeg/<camera-id>`: shared low-latency MJPEG stream
- `GET /embed/<camera-id>`: browser-safe embedded player
- `GET /latest/<camera-id>`: latest JPEG from an active shared stream, for low-frequency analysis without opening a second upstream feed
- `GET /v1/stream-metrics/<camera-id>`: observed source FPS and active viewer count
- `GET /v1/lanes/<camera-id>`: nearest same-direction official VD main-lane count, lane speed, occupancy and volume

The driving app prefers the official MJPEG source for lowest latency and automatically falls back to `/mjpeg/<camera-id>` if the phone cannot play it. TDX credentials remain only in Render.

## Production requirement

Deploy this Docker service on an always-on container host. GitHub Pages cannot proxy live MJPEG or read protected TDX VD data. The deployed service URL is then used by the web app as the fallback stream and official lane-data service.

## Source-rate limit

Frame rate is camera-specific. On 2026-09-14, sample freeway cameras were measured at roughly 9-13 actual frames per second despite reporting 25 FPS in their headers. The relay never duplicates frames to claim a higher rate. It can reduce relay latency, but genuine 15/30 FPS requires an upstream source that supplies that many new frames.
