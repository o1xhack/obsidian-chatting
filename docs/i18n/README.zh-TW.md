# Chatting with AI

[![最新版本](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![下載總數](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![授權](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](../../LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.11.4%2B-7c3aed)](https://obsidian.md)
<br>
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-o1xhack-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/o1xhack)

**行動裝置優先的 AI 助理，透過對話閱讀、修改和整理你的 Obsidian 筆記庫。**

> 🌐 [English](../../README.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [日本語](README.ja.md)

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone 上的 Provider 設定頁" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="連網搜尋後的中文回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="帶清單的英文回答" width="260">
</p>

---

## ✨ 用對話完成筆記裡的工作

Chatting with AI 把一句話變成 Obsidian 裡的實際操作：尋找相關筆記、修改草稿、整理專案，或調整 Canvas。核心能力分為六組：

- 📱 **行動裝置優先，輕量使用** — 手機、平板和桌面都能用，不需建立筆記庫索引或部署獨立後端。
- 🧰 **能動手的筆記助理** — 透過 22 個內建工具搜尋和修改筆記、整理檔案與屬性、查看連結、操作 Canvas、讀取網頁。
- 📎 **由你選擇任務上下文** — 使用目前筆記、把修改限制在選取範圍、透過 `@` 或 `[[` 引用檔案，並帶上圖片、PDF 和 Office 文件。
- 🧩 **可重複使用的個人工作流程** — 用 `AGENTS.md` 說明筆記庫規則，用 Skills 保存常用任務，也能透過 `/name` 直接呼叫。
- 👀 **看得見、可復原的變更** — 跟隨修改定位到筆記段落或 Canvas 卡片，查看執行步驟，並在本次工作階段的快照仍可用時復原某次回答的變更。
- 💬 **獨立且可繼續的對話** — 為不同任務保留命名對話，重新啟動後接著聊，也能編輯之前的訊息、重新產生回答。

支援 **Anthropic API**、**OpenAI API** 和 **ChatGPT 帳號登入**三種連線方式，沿用你既有的 AI 使用習慣。

## 🎬 可以拿它做什麼

### 在筆記、檔案和 Canvas 之間完成工作

直接用自然語言提出需求。助理會選擇工具、閱讀相關資料，再在筆記庫裡執行操作。

> 找出 Books 資料夾裡缺少評分的筆記，加上 `rating: ?`。
>
> 比較這幾篇會議紀錄，把決定整理成專案計畫。
>
> 把 Canvas 上的想法分組，連接相關卡片。

依內容、標籤或屬性尋找筆記；檢查傳入、傳出連結和未連結提及；讀取和編輯 Canvas 卡片及連線；查看庫內圖片，並把網頁讀成文字。

### 為每個任務提供合適的上下文

從目前筆記開始，或輸入 `@` / `[[` 引用指定檔案。透過輸入框或貼上附加圖片、PDF、Word、Excel、PowerPoint 和文字檔。Canvas 可以提供結構大綱，也能由助理查看畫面配置。

只想改一段時，選取文字並選擇 **Send selection to chat**。工具會把對該筆記的直接編輯限制在選取範圍內；其他筆記仍可編輯，重新命名其他檔案時，Obsidian 也仍可能更新這裡的連結。

### 讓助理遵循你的工作方式

根目錄的 `AGENTS.md` 定義整個庫的規則；某個資料夾中的 `AGENTS.md` 會在對話首次涉及該目錄時補充局部規則。在庫內 `Skills` 資料夾中保存可重複使用的任務，每個任務包含 `SKILL.md`，還可以帶範本和範例。助理能依任務載入相應技能，你也可以輸入 `/` 主動選擇。

Skills 沿用 Claude Code / Codex 的資料夾格式。助理可以讀取說明和配套檔案，但不會執行其中的指令碼。

### 檢查變更，繼續對話

**Follow the AI's edits** 會定位到修改的筆記段落或 Canvas 卡片，同時保留聊天輸入焦點。完成的工具步驟摺疊成一行，需要時展開。每次回答的 **Undo** 可以還原記錄下來的編輯、建立、重新命名和刪除；如果檔案之後又被修改，會先詢問。復原快照有容量限制且僅保存在記憶體裡，重新啟動或快照過期後不能再復原。

可以新增、切換、重新命名和刪除獨立對話，每個對話只向模型傳送自己的聊天紀錄，重新啟動 Obsidian 後也能繼續。還支援編輯歷史訊息、複製回答和重新產生最後一次回答。編輯或重新產生不會復原已經發生的檔案變更。

回答隨模型寫作即時顯示，並支援 Markdown、表格、雙向連結和數學公式。向上閱讀舊訊息時不會被強制拉回底部，需要時可以一鍵回到最新回答。

## ⚙️ 三種連線方式

| 連線方式 | 需要什麼 | 如何使用 |
|---|---|---|
| **Anthropic** | Anthropic API key | 使用 Claude 模型；思考和網頁搜尋能力取決於模型。 |
| **OpenAI** | OpenAI API key | 透過 Responses API 使用 OpenAI 模型；推理和網頁搜尋能力取決於模型。 |
| **ChatGPT 帳號** | 具備 Codex 存取權限的 ChatGPT 方案 | 登入帳號，使用該帳號可存取的 Codex 模型。 |

模型清單從對應服務或帳號取得，快取 24 小時，也可以隨時手動重新整理；服務提供相關資訊時，思考等級跟隨模型目錄。實際可用模型及權限取決於服務和帳號。

桌面端 ChatGPT 登入會開啟瀏覽器並自動返回。桌面也可用裝置驗證碼登入，手機目前採用這一方式。憑據依裝置保存，同步筆記庫不會讓另一台裝置自動登入。

## 🚀 快速上手

需要 **Obsidian 1.11.4 或更新版本**，支援桌面、iOS 和 Android。

1. 開啟 **設定 → 社群外掛 → 瀏覽**。
2. 搜尋 **Chatting with AI**，點擊 **安裝**，再點擊 **啟用**。
3. 開啟 **設定 → Chatting with AI**，選擇連線方式。
4. 填入 API key，或連接 ChatGPT 帳號。
5. 從側邊欄圖示或命令面板開啟聊天，開始處理筆記。

## 📦 安裝

### 社群外掛(推薦)

Chatting with AI 已進入官方 Obsidian 社群外掛目錄,這是預設的首選安裝方式。

1. 在 Obsidian 裡開啟 **設定 → 社群外掛**。
2. 若有提示,先關閉 Restricted Mode / 開啟社群外掛。
3. 點擊 **瀏覽**,搜尋 **Chatting with AI**。
4. 點擊 **安裝**,再點擊 **啟用**。

### 從 BRAT 遷移

如果你之前透過 BRAT 安裝 beta 版本,等外掛市場中能搜尋到後可以遷移到社群版本:

1. 在 **設定 → 社群外掛 → 已安裝外掛** 先停用 **Chatting with AI**。
2. 開啟 **BRAT** 設定,從 beta 外掛列表移除 `o1xhack/obsidian-chatting`。
3. 回到 **設定 → 社群外掛 → 瀏覽**,搜尋 **Chatting with AI**。
4. 如果 Obsidian 顯示 **已安裝**,進入外掛詳情後點擊 **啟用**。如果顯示 **安裝**,點擊 **安裝**,再 **啟用**。
5. 開啟 **設定 → Chatting with AI**,確認 provider 設定仍然存在。

外掛首次啟動時會把舊的 `obsidian-chatting` 資料夾資料遷移到 `chatting-with-ai`。如果你使用的是很早的 beta,社群外掛瀏覽器沒有辨識為已安裝,直接安裝社群版本也可以;新外掛啟動時會執行遷移。

<details>
<summary><b>手動 release 安裝</b></summary>

1. 從 [最新發佈版本](https://github.com/o1xhack/obsidian-chatting/releases/latest) 下載 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<vault>/.obsidian/plugins/chatting-with-ai/`
3. 重新啟動 Obsidian,在社群外掛中啟用 **Chatting with AI**

</details>

<details>
<summary><b>從原始碼建置</b></summary>

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run build
```

連結至測試 vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/chatting-with-ai
```

</details>

## 🔐 隱私與控制

- **不在背景上傳或索引整個庫。** 訊息、目前筆記上下文、引用或附加的檔案、載入的規則及工具讀取的資料，會依對話需要傳送給選定的模型服務。這是雲端模型助理，不是裝置端本機模型。
- **憑據使用 Obsidian SecretStorage。** API key 和 ChatGPT 登入憑據不寫入外掛的 `data.json`，每台裝置需要單獨連線。
- **聊天紀錄保存在筆記庫的外掛目錄。** 命名對話的列表寫入 `chat-state.json`，每個聊天各存為 `chats` 資料夾中的一個檔案。外掛沒有聊天同步服務，這些檔案是否到達其他裝置取決於你的同步設定。附件資料有保留上限，較舊附件可能只顯示名稱。
- **變更直接發生在筆記庫裡。** 選取範圍限制針對所選筆記的直接編輯；復原依賴目前可用的快照，長期恢復請使用日常備份或版本歷程。
- **網頁與附件屬於外部輸入。** 讀取網頁會使用本機網路，包括本機能存取的區域網路位址。不要把網頁或檔案裡隱藏的指令當作可信規則。附件和請求設有容量限制，以控制裝置記憶體和請求大小。

附件限制、不同模型對 PDF / Office 的處理方式、完整工具清單、設定和恢復說明見 **[使用指南（英文）](../user-guide.md)**。已記錄的驗證範圍見[桌面與 iPhone 驗收紀錄](../phase1-review.md)。

## 🗺️ 接下來

命名對話、圖片和文件附件、模型目錄重新整理、Canvas、筆記庫規則和 Skills 均已提供。**歷史對話的封存與搜尋仍在路線圖中。** 每個版本的變化見[發行紀錄](https://github.com/o1xhack/obsidian-chatting/releases)，也歡迎[提交 Issue](https://github.com/o1xhack/obsidian-chatting/issues) 回饋。

## 🤝 參與貢獻

歡迎 Issue 和 PR。程式碼變更請執行 `npm test`、`npx tsc --noEmit`、`npm run svelte-check` 和 `npm run build`；影響應用使用的變更，還應至少在一個行動平台上驗證。較大變更請先開 Issue 對齊方向。

## 🙏 致謝

最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（MIT），原版權資訊保留在 `LICENSE` 中。Chatting with AI 現在是獨立專案，擁有自己的 agent loop、行動裝置支援、ChatGPT 帳號連線和筆記庫工作流程。

感謝 [Thomas Schierl](https://github.com/thomas0schierl) 對聊天持久化、渲染、筆記工具和回歸測試框架的貢獻。

## 📄 授權條款

[MIT](../../LICENSE)。

---

作者：[Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
