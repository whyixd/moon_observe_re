# Frontend

此區包含無硬體 3D LED motion simulator，保留原有的效果、時間模型、控制項與單組／1×9 排列。

## Run locally

```powershell
npm install
npm run dev
```

開發伺服器包含兩個入口：

- `/`：主模擬器；原效果與單組／1×9 排列顯示在兩條互相垂直的 3D 半圓上，每條 156 顆 LED
- `/3d.html`：獨立的 3D 幾何與燈點測試頁；預設全亮，可切換熄燈與反向流動的彩虹動畫，轉速可調至 360 RPM

主模擬器有「模擬／後端控制」模式。同機開發時，先執行 `uv run --locked --project backend python backend/run.py --api-only`，再啟動 Vite；Vite 會將 `/api` 代理到 `127.0.0.1:8765`。選「後端控制」會讀取目前 preset，編輯效果後按「套用到後端」。只有 EffectPreset JSON 會送出並保存，FPS/RPM 與目的 IP 仍由 backend TOML 控制，曝光、骨架和場景只影響預覽。

現場跨設備時先建置前端，再啟動 Raspberry Pi 後端，以 `http://<Pi-IP>:8765/` 開啟頁面。後端同時提供靜態頁面與 `/api`；UI 不需填寫 API 位址或 token。若前後端目錄分開部署，後端可用 `--frontend-dir` 指向前端的 `dist` 目錄。詳見 [backend 說明](../backend/README.md)。

Production build 與 unit tests：

```powershell
npm run build
npm test
```

主模擬器可顯示單組或 1×9 橫向排列；九組以 Unit 5 為最高點，往兩側每組下降一個 unit 半徑；Unit 5 保持原朝向，左右兩側各組繞世界 Y 軸逐級朝 Unit 5 轉 45°。每組使用兩條互相垂直的 3D 半圓，每條 156 顆 LED；模型繞自身 X 軸旋轉 90°，燈點殘影與地面位置同步調整；背向鏡頭的 LED 與其殘影不發光。控制面板的「顯示十字骨架」可隱藏骨架、燈座、中心軸、地面與座標輔助線，只保留燈珠和殘影。原有的 360 RPM 連續旋轉、40 FPS sample-and-hold、相機曝光／視覺殘影取樣、效果模組、unit phase step、effect frame step、選取與診斷數值均保留。效果的 LED index 對應單條半圓，中心向外效果從半圓頂點向兩端延伸。顯示骨架時，畫面左下角可見 XYZ 世界座標軸（X 紅、Y 綠、Z 藍），供確認模型朝向。

Effect logic 位於 `src/effects/`，與 React / Three.js rendering 分離。現有十四個效果：

- `spectrum-cycle`：原始 20-frame 光譜循環
- `center-out-sine`：可調速度的中心向外 sine wave
- `moving-rings`：可調速度與環數的純白徑向往返光環；相鄰環反向運動於互不重疊的 lanes，最內圈可達半圓頂點、最外圈可達兩端
- `sequential-center-fill`（逐月）：由 Unit 1 開始從中心向外累積點亮，已完成的 unit 保持全亮；第九組完成後全部持續點亮
- `periodic-leds`（落雨）：每條半圓點亮指定的 N 顆單點，相鄰亮點間隔 M 顆暗點；整組亮點依可調的移動週期沿半圓循環移動，亮點數與間隔上限會依 156 顆 LED 自動調整
- `random-leds`（隨機亮點）：每條半圓每隔指定控制器影格數重新抽選 N 顆燈點；可選等長點亮，或依離半圓中心的距離縮短外側點亮時間。最短點亮為 1 個 Art-Net 影格，實際毫秒數隨 controller FPS 改變
- `world-upper-half`（空間上方 1/3 圓）：維持圓周到圓心的完整半條燈帶，靠近圓心的 20% 半徑平滑漸暗；只在朝向正上方 120° 時點亮，依名義 RPM 與未知起始相位在 Art-Net 影格邊界決定亮點
- `reverse-tide`（逆向聚潮）：兩端光潮向半圓頂點匯聚，接近中心時淡出
- `wide-rings`（寬幅同心環）：多道寬色帶沿半徑移動
- `comet-tail`（漸層彗尾）：亮點帶著漸暗尾巴沿燈帶循環
- `stardust-cloud`（星塵雲）：依影格與 unit 產生可重現的光雲，逐漸擴散與消退
- `color-breathing`（色彩吐納）：亮度緩慢呼吸，漸層色彩持續流轉
- `sector-smear`（扇區疊影）：8 影格反覆改變徑向亮燈長度
- `twenty-beat`（二十拍萬花筒）：20 影格輪替五種徑向圖案

Effect preset 使用 versioned、JSON-compatible contract；時間只由 controller frame 推導，供未來 Raspberry Pi backend 實作相同 renderer 與 golden-vector 驗證。

## 串接播放與儲存

在「模擬」模式選「串接播放」，可新增、複製、移除、排序段落。每段保存獨立的效果 preset；選取段落後，下方原有的效果、顏色與參數控制會編輯該段。頁面啟動會從後端 `GET /api/sequence` 載入唯一串接檔；按「儲存串接」會以 `PUT /api/sequence` 原子覆寫同一份檔案，後端下一影格起從第一段重新播放。重新整理後會讀回已儲存版本。未按儲存時的修改只存在頁面記憶體；後端未啟動時可以預覽，但無法保存到共用檔案；若尚未接線，可用 `backend/run.py --api-only` 啟動只供儲存的 API。按「重新讀取」可再次從後端載入；尚未儲存的本地編輯不會被覆蓋。

串接存於後端的 `render.sequence` 路徑（Pi 建議 `/var/lib/moon-observe/sequence.json`），前端與後端透過 API 共用該檔。切換「後端控制」並套用單一效果時，後端暫時改播單一 preset；再次儲存串接或重新啟動後端即恢復串接。

有明確完成邊界的效果使用「播放次數」；其他效果使用「播放時間」。目前光譜循環（20 影格）、中心向外 sine（一個波形週期）、往返光環（一次往返）、落雨（一次沿半圓循環）及逐月（所有 unit 完成點亮）已標示完成邊界。星塵雲、色彩吐納、隨機亮點與空間上方 1/3 圓按時間播放；逆向聚潮、寬幅同心環、漸層彗尾、扇區疊影與二十拍萬花筒可按播放次數。週期換算為整數 controller frame；非常短的週期會受 FPS 取樣限制。

每段可設定接到下一段時直接切換、淡出至黑再淡入、逐台淡出至黑再淡入（`unit-fade-black`：前半段第 1→9 台依序錯開淡出，每台淡出長度為前半段的 1/3，第 9 台在中點全黑；後半段九台一起淡入），或交叉淡化。轉場從下一段的第 0 影格開始，前一段先完成設定的次數或時間，再以其最後一影格參與轉場；重複同一段時不插入轉場。串接結束後可選維持最後一影格、循環播放，或依指定秒數淡出至黑並保持全黑；循環時最後一段的銜接方式套用到下一輪第一段。轉子仍持續旋轉。曝光與殘影取樣會依各取樣時刻的段落計算。

要替新效果標示「完成邊界」，在 src/effects/<effect>.ts 的 EffectModule 加入 completion，提供易懂的 label 和 frames(parameters, fps, unitCount)。frames 回傳播放一次所需的 controller 影格數；下一影格會從本效果的第 0 影格重播。完成狀態若需保留一影格（例如逐月全部點亮），應把該影格計入。沒有 completion 的效果自動依時間播放。定義後以 tests/sequence.test.ts 驗證邊界前、邊界當下與重複後的畫面。


選定技術：

- React + TypeScript + Vite
- Three.js through React Three Fiber
- Three.js render targets / post-processing for temporal accumulation、bloom 與 tone mapping
- Raspberry Pi 後端同源提供正式頁面與 API

Simulator 使用 React/Vite 建置靜態頁面，由 Raspberry Pi 後端同源提供頁面與 API。

Simulator requirements：

- 360 RPM continuous rotation
- 40 FPS / 25 ms GL-C-616WL sample-and-hold
- Camera exposure integration 與可調式 persistence model
- Art-Net jitter/drop、RPM error、unit phase offset controls
- Single-unit 與 9-unit preview、deterministic preset、image/video export

完整設計與驗收條件位於 `docs/led_motion_simulator_plan.md`。

後續操作介面包括：

- RPM、phase、frame period 與 active LED count 顯示
- LED pattern preview 與參數編輯
- Art-Net node、universe、advertised refresh rate 與 missed-frame 狀態
- motor controller、LED controller 的連線與錯誤狀態分開呈現

Production frontend 只呼叫 Raspberry Pi backend，不直接傳送 Art-Net，也不直接操作 SAMD21。Simulator 可完全離線執行，並與 backend 共用純資料格式的 pattern/preset schema。

## Weather-driven preview

When the backend config contains a `[weather]` section, the simulator reads `/api/weather` every 5 seconds and uses the backend's category, temperature gradient and per-unit delays. Clear weather uses frame step 0; cloud/fog uses the configured 4–8 step; precipitation gives every unit a distinct start phase; its delay is that fraction of the current effect cycle (capped at 4 s), dark until it starts, then held as a phase shift (re-applied once per sequence step, not per repeat). The manual Effect frame step slider is disabled while valid weather data is active. The renderer overrides the visible palette only; saved presets and sequence colors stay intact. See [backend weather setup](../../backend/README.md#天氣驅動九組效果). Edit the temperature palette on the standalone `palette.html` page (linked from the weather panel); saving applies on the next frame.
