# Frontend — 3D 模擬器與控制台

React 18 + TypeScript + Vite，3D 用 three.js（React Three Fiber）。可完全離線預覽效果，也是現場的控制頁：由後端同源提供（`http://<電腦 IP>:8765/`），透過同源 `/api` 控制後端。完整架構見 [`system-reference.md`](../system-reference.md) 第 3、4 節。

## 執行

```bash
npm install
npm run dev      # 開發伺服器；/api 代理到 127.0.0.1:8765
npm test         # vitest
npm run build    # tsc 型別檢查 + 建置到 dist/（後端會自動提供）
```

同機開發時先啟動後端（`uv run --locked --project backend python backend/run.py --api-only`，或連 Art-Net 一起跑），再開 Vite。

入口：

- `/`：主模擬器與控制台。
- `/palette.html`：天氣溫度色盤編輯。
- `/3d.html`：單組實體幾何與燈點測試頁。

## 模擬器

- 每台是兩條互相垂直的半圓（吃同一份資料），每條 152 顆 LED（連上後端時用後端的 `render.pixels`）；index 0 與最後一顆是兩腳，中間是頂點。背向鏡頭的 LED 不發光。
- 視角〔單組｜全部〕。「全部」照 LongN 模擬器的排列（`model.ts:longnUnitPlacement`，5 台由左下往右上升高、頂點各朝不同方向，看起來是一組月相），台數跟著後端的 `render.unit_count`。排列需要現場確認。
- 每台照自己的馬達狀態轉：停止、中速、全速（rpm 由後端 `[motor].rpm` 決定，預設 130／500），順轉或逆轉。改變轉速時轉角連續。
- 全速且月亮校正打開時，模擬器也套用 LongN 的月亮校正（`src/hardware.ts`，數值與後端相同）；亮度 40% 不模擬。
- 40 FPS sample-and-hold、相機曝光與視覺殘影取樣、效果的影格錯開與相位差、骨架開關、XYZ 座標軸都保留。

## 控制模式

- **模擬**：播放瀏覽器內編輯中的效果或串接。馬達在「物理」分頁逐台調整（預設全速順轉），只影響畫面。
- **後端控制**：讀取後端狀態，3D 畫面鏡像後端實際輸出（時間跟隨 `/api/playback`，每台照後端回報的馬達狀態轉）。「後端」分頁可以：
  - 套用效果、從頭重播串接或單一效果。
  - 馬達：「全部」一列和每台一列〔停｜中速｜全速〕〔順｜逆〕，旁邊顯示實際送出的 DMX 值；月亮校正開關。後端重新啟動後馬達一律停止。
  - 單色測試。

FPS、燈數、台數與兩段 rpm 由後端 TOML 決定，連上後端時物理分頁的對應滑桿會鎖定；曝光、殘影、取樣數和場景只影響預覽。

## 效果與串接

效果邏輯在 `src/effects/`，與 React／Three.js 分離，時間只由 controller frame 推導；後端 `effects.py` 是同一份規格的 Python 移植，以 `scripts/generateBackendVectors.ts` 產生的 golden vectors 比對（156 × 9 與 LongN 152 × 5 兩組）。效果清單與行為見 [`src/effects/README.md`](src/effects/README.md)。

「串接」分頁在模擬模式編輯段落（效果、播放次數或時間、轉場、結尾），按「儲存串接」寫到後端唯一的 `sequence.json`，後端從下一影格起從頭播放；啟動時會讀回後端已儲存的版本。要替新效果標示完成邊界，在 `src/effects/<effect>.ts` 的 `EffectModule` 加上 `completion`，並在 `tests/sequence.test.ts` 驗證。

## 天氣預覽

後端設定 `[weather]` 時，頁面每 5 秒讀 `/api/weather`，在本地套用相同的分類、色盤與各台錯開（多雲錯開、雨天線條），手動的 Effect frame step 會停用；只覆蓋畫面顏色，不改寫保存的 preset 與串接。色盤在 `/palette.html` 編輯。

`docs/led_motion_simulator_plan.md` 是參考系統（9 台、360 RPM）的早期規劃，只供追溯。
