# Moon Observe 系統參考（給 agents）

> 從程式碼整理（2026-11-02，v0.1.12 之後的 master）。各段標出**權威來源檔案**，文件與程式不一致時以程式為準；改動行為後請同步更新此文件。

專案概觀：一台 Raspberry Pi 5 執行 Python 後端，把 LED 效果算成影格、以 Art-Net 送到九組旋轉半圓燈（unit），每組由 Gledopto GL-C-616WL（WLED）接收；同一個後端程序也提供 React 前端頁面與 JSON API。前端是 3D 模擬器兼控制台。

```text
瀏覽器 ──HTTP JSON（同源 /api，輪詢）──▶ Python 後端（Pi :8765）──Art-Net UDP──▶ 9 × GL-C-616WL ──IO13──▶ SAMD21 馬達
                                              │
                                              └─ 背景執行緒 ──HTTPS──▶ Open-Meteo
```

---

## 1. Effect engine

### 1.1 雙實作、同一規格

| 角色 | 位置 |
|---|---|
| **規格與參考實作（TypeScript）** | `frontend/src/effects/`（`contract.ts` 型別、`index.ts` 註冊與 `sampleEffect`、每個效果一個檔、`rain.ts`、`color.ts`、`unitVariation.ts`） |
| **後端移植（純 Python）** | `backend/moon_observe_backend/effects.py`（全部效果在 `_brightness`／`_rain_brightness` 兩個大函式中以 `if effect == ...` 分派） |
| 一致性測試 | `frontend/scripts/generateBackendVectors.ts` 用前端程式產生 `backend/fixtures/effects_v2.json`；`backend/tests/test_effects.py`、`test_sequence.py` 比對 |

兩邊必須逐值一致：

- 四捨五入一律用 `floor(x + 0.5)`（對齊 JS `Math.round`，**不是** Python 的銀行家捨入）。
- 亂數使用相同的 xorshift32 / 固定種子（`_random_ranks`、`_random32`、`hash01`、`unit_turn` 種子 1009）。
- 參數範圍、預設值、step 兩邊各有一份：前端在各效果 `manifest.parameters`；後端在 `PARAMETERS`（min, max, default, integer）與 `PARAMETER_STEPS`。

### 1.2 核心模型：純函式、以影格為時間

效果是**純函式**，不碰 React／Three.js／瀏覽器時間：

```
sampleEffect(preset, context, elapsedFrame, raining) -> RGB（各通道 0–1）
```

- 時間 = `controllerFrame / controllerFps`（Art-Net 影格，預設 40 FPS），**不是**渲染時間；LED 為 sample-and-hold。
- 輸出 = `顏色 × 亮度`。效果只決定亮度（`brightness()` 或 `sample()` 的最大通道），顏色由 preset 的 `color` 決定（`rain()` 存在且下雨時改用雨天亮度）。
- 幾何：每組一條半圓 156 顆 LED（兩條手臂共用同一份資料）。

`EffectSampleContext`（Python 為 `EffectContext` dataclass）：

| 欄位 | 意義 |
|---|---|
| `controllerFrame` | 該 unit 的影格（已加上多雲錯開 `frameOffset`、已依次數播放取餘數） |
| `globalControllerFrame` | 未加 offset 的共同影格，供跨 unit 編排（如逐月） |
| `controllerFps` | 通常 40 |
| `ledIndex` / `ledCount` | 0..155 / 156 |
| `normalizedStripPosition` | `ledIndex/(ledCount-1)`，一端 0、另一端 1 |
| `normalizedRadius` | `abs(strip*2-1)`，頂點 0、兩腳 1 |
| `unitIndex` / `unitCount` | 0-based / 通常 9 |
| `unitRelativeY`、`unitPhaseProjection` | 依名目 RPM 估計的旋轉相位（無回授），只有 `world-upper-half` 使用 |

`EffectModule`（`contract.ts`）可選欄位：`completion`（一個自然週期的影格數）、`brightness`、`gradientPosition`、`unitGradientPosition`、`loopGradient`、`rain`、`ignoresWeatherTiming`。

### 1.3 EffectPreset v2（JSON 格式）

```json
{
  "schemaVersion": 2,
  "effectId": "center-out-sine",
  "parameters": { "speedHz": 0.35 },
  "color": {
    "mode": "gradient",
    "axis": "radius",
    "colors": [{ "r": 0.2, "g": 0.92, "b": 1 }, { "r": 0.66, "g": 0.28, "b": 1 }],
    "axisChange": { "to": "strip", "atSeconds": 4, "blendSeconds": 1, "repeat": false },
    "weatherPalette": false
  },
  "unitVariation": { "parameter": "speedHz", "from": 0.2, "to": 1, "distribution": "linear" }
}
```

- `color.mode`：`solid`（`color: {r,g,b}`）或 `gradient`（`axis` + 2–8 個均分色點）。
- `axis`：`strip`（一腳到另一腳）、`radius`（頂點到腳）、`unit`（每台取一個純色）。`spectrum-cycle`、`color-breathing`、`twenty-beat` 的漸層會循環（loop）並隨時間位移；`random-fill` 不論 axis 都是每台一個純色（`unit_palette_position`，以與 unit 數互質、接近一半的步長跳色）。
- `axisChange`（選填，只限漸層）：自效果／段落開始第 `atSeconds` 秒起以 `blendSeconds` 漸變到 `to`；`repeat` 來回交替。秒數 0–3600。
- `weatherPalette: false`（選填）：天氣啟用時仍用自己的顏色。省略 = 套用天氣色盤。
- `unitVariation`（選填）：九台的某個參數各取固定值，`linear`／`skip`／`random`（固定種子），值對齊參數 step。`FIXED_PARAMETERS` 列出不可變化的參數。以次數播放時週期取最慢一台。
- 驗證：`effects.validate_preset`（多餘欄位、超出範圍都會拒絕）；正規化輸出：`preset_to_json`。

### 1.4 效果清單

| effectId | 中文名 | 有週期（可用次數播放） | 雨天線條 |
|---|---|---|---|
| `spectrum-cycle` | 光譜循環 | 20 影格 | – |
| `center-out-sine` | 中心擴散 | ✓ | 只留波峰細環 |
| `moving-rings` | 往返光環 | ✓ | – |
| `sequential-center-fill` | 逐月（Unit 1→9 由中心填滿） | ✓ | 同心條紋 |
| `periodic-leds` | 落雨 | ✓ | – |
| `random-leds` | 隨機亮點 | – | – |
| `world-upper-half` | 空間上方 1/3 圓 | – | – |
| `reverse-tide` | 逆向聚潮 | ✓ | 同心條紋 |
| `wide-rings` | 寬幅同心環 | ✓ | 每帶內外兩條邊線 |
| `comet-tail` | 漸層彗尾 | ✓ | 細環彗頭＋稀疏雨絲尾 |
| `stardust-cloud` | 星塵雲 | – | 雨絲 |
| `color-breathing` | 色彩吐納 | – | 同心條紋 |
| `sector-smear` | 扇區疊影 | 8 影格 | – |
| `twenty-beat` | 二十拍萬花筒 | 20 影格 | – |
| `sine-swell` | 流光波 | ✓ | 只留波峰細環 |
| `random-fill` | 隨機填滿 | ✓ | 已亮的燈閃雨絲 |
| `full-on` | 全亮 | – | 滿版雨絲 |
| `unit-chase` | 逐台巡行 | ✓ | 不適用 |
| `unit-random` | 隨機單台 | ✓ | 不適用 |
| `roulette-ring` | 輪盤收束 | ✓ | 不適用 |

- 週期：前端 `getEffectCompletion`，後端 `completion_frames`（`None` = 無週期，串接只能以時間播放）。
- `unit-chase`、`unit-random`、`roulette-ring` 是**整台為單位**的效果：`ignoresWeatherTiming` / `WEATHER_TIMING_FREE`，九台共用時間表，不套用多雲錯開、沒有雨天版本、參數不可逐台變化。
- 各效果的詳細行為見 `frontend/src/effects/README.md`。雨天常數 `RAIN_LINES = {stripeSpacing: 6, streakFrames: 2, sparseDensity: 0.18, denseDensity: 0.45}`（`rain.ts` 與 `effects.py` 同值）。

### 1.5 後端每影格渲染流程

權威來源：`output.py:stream` → `renderer.py:render_frame` / `sequence.py:render_sequence_frame` → `effects.py:sample_effect`。

1. 主迴圈依實際時鐘計算 `due = floor(elapsed * fps)`，追上進度後渲染（不補送漏掉的影格）。
2. 讀 `SequenceStore.snapshot()` →（mode, compiled, generation）。generation 改變（儲存串接、套用單一效果、restart API）或天氣 generation 改變 → `playback_start_frame = frame`，從第 0 影格重播。
3. 呼叫 `WeatherStore.advance(...)`（造訪計時、在段落邊界套用延後的天氣分類），再取天氣 snapshot。
4. 對每個 Art-Net target（= 一個 unit）：
   - `frameOffset = (unitId-1) * cloud_step`（僅 `cloudy`）。
   - 單色測試中 → 整條填測試色；否則串接模式用 `render_sequence_frame`，單一效果用 `render_frame`。
   - `render_frame`：套 `unitVariation`（`preset_for_unit`）→ 依次數播放時 `frame % cycle` → 加 offset（整台效果除外）→ 若天氣有色盤且 `weatherPalette` 未關，**只換顏色**（漸層效果保留自己的 axis 與 axisChange；純色效果改用色盤的 axis）→ 逐顆 `sample_effect(..., raining)`。
   - `rgb_bytes`：`floor(clamp01(c) * 255 + 0.5)`，156 × RGB = 468 bytes。
   - Payload 470 bytes：ch 1–468 RGB、**ch 469 馬達命令（0 緩停／255 緩啟動）**、ch 470 補 0（ArtDmx 需偶數長度）。
5. 正常結束時若馬達為 255，對每個 target 再送一包 ch469=0。

### 1.6 串接（Sequence）

權威來源：`backend/moon_observe_backend/sequence.py`、`frontend/src/simulation/sequence.ts`（兩者同邏輯）。

- 段落 `playback`：`{"kind":"count","count":1..100}`（需有週期）或 `{"kind":"time","seconds":(0,3600]}`。
- 段落 `transition`：`cut`／`fade-black`／`crossfade`／`unit-fade-black`，`seconds` 0–10。**第 i 段的 transition 用在「第 i 段 → 第 i+1 段」**，佔用下一段開頭的影格。
  - `crossfade`：兩層權重線性交叉。
  - `fade-black`：前半淡出、後半淡入。
  - `unit-fade-black`：前半逐台淡出（`unit_fade_weight`），後半一起淡入。
- `ending`：`hold`（停在最後畫面）、`loop`（最後一段的 transition 接回第一段）、`fade-black`（`seconds` 淡出至黑）。
- 編譯後每段有 `start`、`duration`、`cycle`、`transition_frames`；渲染時最多兩層（outgoing + current）加權相加。最多 64 段。

### 1.7 新增效果的檢查清單

1. 前端：`frontend/src/effects/<name>.ts`（`EffectModule`），在 `contract.ts` 的 `EffectId` union 與 `index.ts` 的 `EFFECTS` 註冊；需要時加 `defaultEffectColor`（`color.ts`）、`FIXED_PARAMETERS`。
2. 後端 `effects.py`：`EFFECT_IDS`、`PARAMETERS`、`PARAMETER_STEPS`（非整數參數）、`FIXED_PARAMETERS`、`_brightness`、`completion_frames`、需要時 `_rain_brightness`、`_axis_color`、`default_preset`、`WEATHER_TIMING_FREE`。
3. `frontend/scripts/generateBackendVectors.ts` 的 `ids` 加入新 ID，重新產生 `backend/fixtures/effects_v2.json`。
4. 前後端測試：`cd frontend && npm test`；`cd backend && uv run --locked python -m unittest discover -s tests -v`。
5. 更新 `frontend/src/effects/README.md` 與本文件的效果表。

---

## 2. 前端架構及 UI 排版

### 2.1 技術與入口

- React 18 + TypeScript + Vite 6；3D 用 three 0.180 + `@react-three/fiber` 8；測試 vitest（node 環境）；`scripts/screenshot.mjs` 用 Playwright 截圖。
- 沒有狀態管理函式庫、沒有 router、沒有 CSS 框架。
- Vite 多頁面（`vite.config.ts` 的 `rollupOptions.input`）：

| HTML | 進入點 | 用途 |
|---|---|---|
| `index.html` | `src/main.tsx` → `App.tsx` | 主模擬器＋控制台 |
| `palette.html` | `src/palette/main.tsx` → `PaletteApp.tsx` | 天氣溫度色盤編輯（`/palette.html`） |
| `3d.html` | `src/preview3d/main.tsx` → `Preview3DApp.tsx` | 單組實體幾何預覽 |

### 2.2 目錄

```text
frontend/src/
├── App.tsx                 # 主頁所有狀態（useState/useRef）、API 呼叫、輪詢；把 props 傳給 ControlPanel
├── backendApi.ts           # 所有 /api 呼叫與回應型別（唯一的 fetch 集中處）
├── playbackProgress.ts     # 由 /api/playback 推算目前後端影格（liveBackendFrame）
├── styles.css              # 全站唯一樣式表（純 CSS class）
├── components/
│   ├── ControlPanel.tsx    # 右側分頁面板（含 Slider、ColorInput、UnitVariationEditor、AxisChangeEditor）
│   ├── SequenceEditor.tsx  # 串接編輯（模擬模式）
│   ├── SavedSequenceView.tsx # 後端已儲存串接唯讀檢視（後端控制模式）
│   ├── PlaybackProgress.tsx  # 後端播放進度
│   ├── UnitColorTestPanel.tsx # 單色測試
│   ├── WeatherPanel.tsx    # 天氣狀態、手動測試、造訪
│   └── GradientEditor.tsx  # 漸層色點編輯
├── effects/                # Effect engine（見第 1 節）
├── simulation/
│   ├── model.ts            # SimulationSettings、unit 排列（1×9 圓弧）、轉角／影格換算、時間取樣
│   ├── sequence.ts         # 串接編譯與解析（與後端同邏輯）
│   └── scene/              # SimulationCanvas（R3F Canvas）、LightTrail（每影格取樣與殘影）、SimulatedSemicircleUnit、AxisGuide
├── palette/                # 色盤頁
└── preview3d/              # 幾何預覽頁與共用幾何（LEDS_PER_ARC = 156）
```

### 2.3 狀態與模式

- **控制模式**（header 的分段按鈕）：
  - `模擬`：3D 畫面播放瀏覽器內編輯中的效果／串接，可自由調整。
  - `後端控制`：讀 `/api/state`，可套用效果、馬達命令、重播；3D 畫面改為**鏡像後端實際輸出**（已儲存的串接或已套用的效果），時間跟隨 `/api/playback`。
- 串接編輯器在模擬模式可用，啟動時自動載入後端 `sequence.json`；`sequenceDirty` 比對 JSON 字串判斷是否未儲存。
- 天氣狀態從後端取得後，在前端**本地**套用到模擬（色盤、多雲 frameStep、雨天線條），算法與後端相同。
- 物理分頁設定（RPM、FPS、曝光、殘影、取樣數、相位差）只存在記憶體；連上後端時 FPS/RPM 由後端 `output` 覆蓋並鎖定。

### 2.4 主頁排版

```text
.app-shell.simulator-shell（整頁固定 100dvh，flex column）
├── header.app-header：h1「Moon Observe Simulator」 ｜ 分段按鈕〔模擬｜後端控制〕
└── section.workspace（CSS grid：minmax(0,1fr) ｜ minmax(300px,360px)）
    ├── .viewport-panel（左）
    │   ├── .viewport-toolbar：〔暫停/繼續〕〔重設時間〕｜〔單組｜1×9〕｜ unit 1–9 選擇 ｜ ☐骨架
    │   └── .canvas-wrap
    │       ├── <SimulationCanvas>（R3F）
    │       ├── .viewport-caption：效果名 · FPS · RPM ·（後端輸出／本地模擬）·（單色測試中）
    │       └── .diagnostics（6 欄 grid）：Rotor° · Frame · Phase · °/frame · Exposure · Time
    └── section.controls（右，ControlPanel）
        ├── .control-tabs（role=tablist）：效果｜色彩｜串接｜後端｜天氣*｜物理
        └── .control-tabpanel（面板內捲動）
```

`*` 天氣分頁只在後端已設定 `[weather]` 時出現。直向螢幕或寬度 ≤ 900px：`.workspace` 改為單欄、上下兩列（`1.15fr / 1fr`）。

各分頁內容：

| 分頁 | 內容 |
|---|---|
| 效果 | Effect 下拉選單、參數 Slider（由 manifest 自動產生）、`random-leds` 點亮時間模式、各燈台不同數值（unitVariation）、效果說明 |
| 色彩 | 天氣啟用時：顏色來源〔天氣色盤｜自訂顏色〕、漸層方向、中途切換方向、目前天氣色票、`<details>` 備援顏色；否則：〔純色｜漸層〕、色彩／漸層編輯 |
| 串接 | 模擬模式：`SequenceEditor`（段落清單、增刪複製移動、播放規則、轉場、結尾、儲存／重新載入）；後端控制模式：`SavedSequenceView`（唯讀＋從頭播放） |
| 後端 | 播放進度；後端控制模式下：連線狀態、重新讀取／套用、重新播放〔串接｜單一效果〕、馬達〔關閉 0｜開啟 255〕、單色測試 |
| 天氣 | `WeatherPanel`：目前天氣與來源、手動測試天氣（類別＋氣溫，10 分鐘）、立即造訪／結束造訪、色盤頁連結 |
| 物理 | Motor speed、Controller rate、Camera exposure、Visual persistence、Temporal samples；1×9 時另有 Unit phase step、Effect frame step（有天氣時停用） |

### 2.5 視覺樣式慣例

- 深色主題：背景 `#080b11`、文字 `#eef4fb`、主色按鈕 `#65d9f8`（深色字）、焦點外框 `#ffba49`、錯誤 `#ff9d91`。
- 共用 class：`button.secondary`（次要）、`button.active`（選中）、`.segmented-control`（等寬按鈕 grid，預設 2 欄）、`.button-row`、`.control-field`（label + 值）、`.control-label`、`.control-note`（小字說明）、`.color-controls`（帶上邊框的區塊）。
- 新 UI 沿用以上 class，不引入 CSS-in-JS 或 UI 套件；介面文字為繁體中文，物理參數保留英文標籤。
- 無障礙：分頁用 `role=tablist/tab/tabpanel`，切換按鈕用 `aria-pressed`，狀態訊息用 `role=status`/`alert`。

### 2.6 3D 模擬重點

- `LightTrail.useFrame`：模擬時間累加 `delta`；在曝光 + 殘影時間窗內取 `temporalSamples` 個時間點，每點計算轉角（連續）與 controller frame（離散，floor），再取樣效果 → 呈現 sample-and-hold 與動態模糊。
- 1×9 排列沿圓弧（`NINE_UNIT_SPACING`、`NINE_UNIT_ARCH_HEIGHT`），每台有模擬的未知起始相位。
- 跟隨後端：與 `liveBackendFrame` 差超過 2 影格才對齊，避免抖動。

---

## 3. 前後端連線方式

### 3.1 傳輸

- **同源 HTTP + JSON REST，以 `fetch` 呼叫，沒有 WebSocket/SSE**；即時性靠輪詢。
- 正式環境：後端 `ThreadingHTTPServer`（標準函式庫，`control.py:make_server`）在 `0.0.0.0:8765` 同時提供 `frontend/dist` 靜態檔與 `/api/*`。頁面寫死相對路徑 `/api/...`，**無 CORS、無驗證、無 token**，僅限受信任區網。
- 開發環境：`npm run dev`，Vite 把 `/api` 代理到 `http://127.0.0.1:8765`；後端可用 `--api-only` 不送 Art-Net。
- 前端 API 用法全部集中在 `frontend/src/backendApi.ts`；錯誤時讀回應的 `{"error": "..."}`。

### 3.2 API 一覽

| Method | Path | Body / 回應 | 說明 |
|---|---|---|---|
| GET | `/api/state` | `{revision, preset, motor:{channel,enabled,value}, output:{ip,universe,fps,rpm,unitId,unitCount,targets}}` | 目前單一效果與輸出設定 |
| PUT | `/api/preset` | EffectPreset v2 | 寫入 `preset.json` 並切到單一效果模式 |
| PUT | `/api/motor` | `{"enabled": bool}` | ch469 = 255/0；不保存，重啟為 0 |
| GET | `/api/sequence` | `{revision, sequence, playbackMode, output:{fps,rpm,unitCount}}` | 讀串接 |
| PUT | `/api/sequence` | Sequence v1 | 原子覆寫 `sequence.json`，切回串接模式並從頭播放 |
| PUT | `/api/playback/restart` | `{"source":"sequence"\|"single"}` | 從第 0 影格重播，不改檔 |
| GET | `/api/playback` | `{active:false}` 或 `{active, mode, restart, fps, ageMs, frame, ...}` | 輸出迴圈目前位置；串接含 step/transition/ending，單一含 cycle；單色測試時附 `unitColors` |
| GET | `/api/weather` | 天氣 snapshot（見 5.4）或 `{"enabled":false}` | |
| PUT/DELETE | `/api/weather/override` | `{"category":"clear"\|"cloudy"\|"rain","temperatureC":-100..70}` | 手動測試天氣 10 分鐘（直接影響實機） |
| PUT/DELETE | `/api/weather/visit` | `{"index": n}` | 立即造訪／結束造訪 |
| GET/PUT | `/api/weather/palette` | Palette v1 | 讀／原子覆寫色盤 |
| GET/PUT/DELETE | `/api/test/units` | `{"colors":[{r,g,b}\|null × unitCount],"seconds":1..86400\|null}` | 單色測試，只在記憶體 |

PUT 規則：`Content-Type` 必須 `application/json`（否則 415）；Body 大小上限依路徑（preset 16 KiB、sequence 256 KiB、palette 16 KiB、units 4 KiB、其餘 64–256 B，超過 413）；驗證失敗 422 `{"error"}`；寫檔失敗 500；功能未啟用（如沒設 `[weather]`）回 404。成功回 200 與新狀態。

### 3.3 輪詢與同步

| 什麼 | 頻率 | 位置 |
|---|---|---|
| `/api/playback` | 每 1 秒（頁面隱藏時暫停；套用／儲存後立即重新輪詢） | `App.tsx` |
| `/api/weather` | 每 5 秒 | `App.tsx`、`PaletteApp.tsx` |
| `/api/test/units` | 測試期間依剩餘時間 | `UnitColorTestPanel.tsx` |
| `/api/state` + `/api/sequence` | 切到後端控制、按重新讀取，或 `/api/playback` 的 `restart` 計數改變時 | `App.tsx` |

- 前端在兩次輪詢之間用 `fps` 與 `ageMs` 自行推進後端影格（`playbackProgress.ts:liveBackendFrame`）；超過 `PLAYBACK_STALE_MS = 5000` 視為過期。
- 天氣 `generation` 改變 → 前端模擬也從頭播放（對齊後端重播）。
- 版本相容：前端把某些 API 的 404 視為「舊版後端沒有此功能」（`getBackendPlayback`、`getUnitColorTest` 回 `null`），新增 API 時沿用此模式。

### 3.4 後端對硬體

- Art-Net 只用 `stupidartnet==1.6.0`（`StupidArtnet(ip, universe & 0x0F, 470, fps)`，`set_net(universe >> 8)`、`set_subnet((universe >> 4) & 0x0F)`）；每影格對每個 target 送一包，沒有接收確認。
- 不呼叫 WLED API；ch469 → IO13 → SAMD21 D8 由 WLED usermod 轉接（`firmware/wled/`）。

---

## 4. 設定檔儲存方式和格式

### 4.1 檔案總覽

| 檔案 | 格式 | 誰寫入 | 權威驗證 | 進版控 |
|---|---|---|---|---|
| `config.toml` | TOML | 人工編輯 | `config.py:load_config` | 否（範本 `backend/config.example.toml`） |
| `preset.json` | EffectPreset v2 JSON | `PUT /api/preset` | `effects.validate_preset` | 否（範本 `backend/preset.example.json`） |
| `sequence.json` | Sequence v1 JSON | `PUT /api/sequence`；不存在時以目前 preset 建立 8 秒單段 | `sequence.validate_sequence` | 否（範本 `backend/sequence.example.json`） |
| `palette.json` | Palette v1 JSON | `PUT /api/weather/palette`；不存在時用內建三段 | `palette.validate_palette` | 否 |

- `preset`、`sequence`、`palette` 路徑寫在 TOML，**相對於 TOML 檔所在目錄**。
- JSON 寫入一律**原子化**：同目錄 `tempfile` → `fsync` → `os.replace`；以 UTF-8、`indent=2`、`ensure_ascii=False` 輸出正規化內容。並發編輯以最後儲存者為準。
- 驗證嚴格：多餘欄位、型別錯誤、超出範圍都拒絕；`run.py --check` 只驗證 TOML/JSON 不送出。
- **只在記憶體、重啟即消失**：馬達命令（重啟為 0）、單一效果模式（重啟回串接模式）、天氣手動測試、造訪狀態、單色測試。

### 4.2 `config.toml`

```toml
[artnet]
ip = "192.0.2.50"        # 單一 target；與 targets 二選一
universe = 0             # 0..32767，從 0 起算
# source_ip = "192.0.2.10"   # 選填：綁定網卡

# 九組時改用（刪掉 ip/universe）：unit_id 與 (ip, universe) 都必須唯一
# [[artnet.targets]]
# unit_id = 1
# ip = "192.0.2.51"
# universe = 0

[render]
preset = "preset.json"     # 必填
sequence = "sequence.json" # 預設 sequence.json
fps = 40                   # 1..120，預設 40
rpm = 360                  # 0..10000，預設 360（只影響相位估計）
pixels = 156               # 固定 156
unit_id = 1                # 單一 target 時使用
unit_count = 9             # 1..9

[weather]                  # 整段選填；省略即停用天氣
latitude = 25.0330
longitude = 121.5654
interval_minutes = 15      # 1..1440
cloud_step = 6             # 4..8，多雲時每 unit 的影格錯開
palette = "palette.json"   # 預設 TOML 同目錄的 palette.json

[[weather.visits]]         # 最多 24 個
name = "東京"              # 1..40 字
latitude = 35.6762
longitude = 139.6503
```

只接受 `[artnet]`、`[render]`、選填 `[weather]` 三段；未知欄位會報錯。

### 4.3 Sequence v1

```json
{
  "schemaVersion": 1,
  "ending": { "kind": "hold" },
  "steps": [
    {
      "id": 1,
      "preset": { "schemaVersion": 2, "effectId": "center-out-sine", "parameters": { "speedHz": 0.35 }, "color": { "mode": "solid", "color": { "r": 1, "g": 1, "b": 1 } } },
      "playback": { "kind": "count", "count": 1 },
      "transition": { "kind": "crossfade", "seconds": 0.5 }
    }
  ]
}
```

- `ending`：`{"kind":"hold"}`、`{"kind":"loop"}`、`{"kind":"fade-black","seconds": 1影格..10}`；舊檔沒有 `ending` 時視為 `hold`。
- `steps`：1–64 段；`id` 為不重複正整數；四個欄位缺一不可。規則見 1.6。

### 4.4 Palette v1

```json
{
  "schemaVersion": 1,
  "axis": "radius",
  "bands": [
    { "belowC": 18,   "colors": [{ "r": 0.14, "g": 0.27, "b": 0.67 }, { "r": 0.45, "g": 0.85, "b": 1 }] },
    { "belowC": 28,   "colors": [ ... ] },
    { "belowC": null, "colors": [ ... ] }
  ]
}
```

- 1–12 段，`belowC` 嚴格遞增（-100..70），**最後一段必須是 `null`**（涵蓋以上所有氣溫）；每段 2–8 色。
- `axis` 只允許 `strip`／`radius`，且只用於純色效果（漸層效果保留自己的方向）。
- 內建預設（`palette.DEFAULT_PALETTE`）：<18°C 冷色、18–27°C 中性、≥28°C 暖色。

### 4.5 部署位置（Raspberry Pi）

權威來源：`backend/deploy/README.md`。

- 程式：`/opt/moon-observe/releases/<版本>/`，`/opt/moon-observe/current` 指向使用中版本；前端 `dist` 一起打包。
- 設定：`/etc/moon-observe/config.toml`（root:moon-observe 0750）。
- 可寫資料：`/etc/moon-observe/preset/`（service 唯一可寫目錄，systemd `ProtectSystem=strict`）。TOML 的 `render.preset`、`render.sequence`、`weather.palette` 都要指到這裡，否則 API 存檔會失敗。
- 升級（`install-release.sh`）不覆寫 config 與 `preset/`；新設定欄位需手動加入。

---

## 5. 天氣資料取得方式

### 5.1 來源

權威來源：`backend/moon_observe_backend/weather.py`。

- [Open-Meteo Forecast API](https://open-meteo.com/en/docs)，免金鑰，標準函式庫 `urllib.request.urlopen`，逾時 8 秒：

```
GET https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code&timezone=auto
```

- 只取回應的 `current` 物件：`weather_code`（int）、`temperature_2m`（需在 -100..70）、`time`（因 `timezone=auto`，是座標當地時間，無時區後綴）。
- **只有後端抓資料**；前端從不直接呼叫 Open-Meteo，而是每 5 秒讀 `/api/weather`。

### 5.2 排程

- `WeatherStore.start()` 開一條 daemon 執行緒，不阻塞 Art-Net 迴圈：
  - 當地天氣：啟動時立即一次，之後每 `interval_minutes`（預設 15）分鐘。
  - 造訪地點：每次迴圈預抓「下一個造訪地點」與「從未成功取得的地點」，並在每小時 **:58** 額外預抓，讓整點切換時有新資料。
- 失敗（網路、JSON、未知代碼、欄位型別）時**保留上一筆有效資料**，錯誤字串放在 snapshot 的 `error`；從未取得資料的造訪地點會被跳過。

### 5.3 分類規則

| weather_code | 類別 | 對效果的影響 |
|---|---|---|
| 0, 1 | `clear` | 九台同相 |
| 2, 3, 45, 48 | `cloudy` | 每台 `frameOffset = (unitId-1) × cloud_step` 影格錯開 |
| 51–57, 61–67, 71–77, 80–86, 95–99（`RAIN_CODES`） | `rain` | 效果改用雨天線條版本（`sample_effect(..., raining=True)`） |

其他代碼視為錯誤。溫度 → 色盤：`gradient_for(temperature, palette)` 取第一個 `temperature < belowC` 的段（最後一段 `null` 兜底），運行時覆蓋畫面顏色，不改寫 preset／sequence。

### 5.4 有效天氣與播放

- 有效來源優先序：**手動測試（override）> 造訪（visit）> 當地（real）**；`source` 欄位為 `override`／`visit`／`local`。
- 有效類別改變（當地更新或手動測試）→ `generation += 1` → 輸出迴圈從頭播放。只有溫度改變時不重播，色盤下一影格即生效。
- 整點造訪：依 Pi 本地時間（需已校時、時區 Asia/Taipei），每個整點輪到清單下一個有資料的地點；色盤立即換上不重播，類別效果（多雲錯開／雨天線條）**延後到下一個段落邊界**（單一效果為下一個週期）才套用（`categoryPending`）；持續一輪播放時間後換回當地。手動測試期間跳過該整點。
- `GET /api/weather` snapshot 主要欄位：`enabled, category, temperatureC, weatherCode, observedAt, updatedAt(UTC), frameStep, color(EffectColor 漸層), generation, error, override{category,temperatureC,remainingSeconds}, real{category,temperatureC}, source, visit{name,category,temperatureC,observedAt}, visits{count,next,names}, categoryPending, thresholds`；`startPhases` 為舊前端相容欄位，一律為 0。

### 5.5 前端如何使用

- `App.tsx` 每 5 秒 `getWeatherState()`（`enabled:false` 時為 `null`，天氣分頁隱藏）。
- `LightTrail` 在本地用同一份資料模擬：`frameStep` 決定各台錯開、`category === 'rain'` 開雨天線條、`color` 經 `withWeatherPalette` 套色（遵守 `weatherPalette: false`）；有天氣時物理分頁的 Effect frame step 停用。
- 測試：`backend/tests/test_weather.py` 使用注入的 `fetch` 假資料，不連網。
