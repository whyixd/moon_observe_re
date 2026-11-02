# LED display historical planning documents

本資料夾保留早期規劃供追溯。P0–P4、WLED live/HTTP、服務與部署設計已不再是目前 backend 的實作；現行架構與啟動方式請以 [backend README](../README.md) 為準。

- `led_spin_display_codex_spec.md`：原始需求輸入，保留追溯用途；檔案含 mojibake，且其中將 LED 邏輯描述為 firmware 的部分已被最新系統條件取代。
- `backend_implementation_plan.md`：Raspberry Pi backend 的模組、設定、Art-Net、失效處理、固定 tag GitHub Release 部署／升級／回退、分階段驗收與待確認決策。
- `led_spin_display_feasibility.md`：目前有效的 40 FPS / 360 RPM blur-effect architecture、Art-Net capacity model、simulation boundary 與 phased implementation plan。

若文件內容衝突，以 [backend README](../README.md) 的現行程式行為為準；本目錄文件僅供追溯早期設計。
