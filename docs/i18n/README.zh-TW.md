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

Chatting with AI 把自然對話變成 Obsidian 裡的實際工作：尋找相關筆記、修改草稿、整理專案、調整 Canvas，並在多個對話和長對話裡持續推進。核心能力分為七組：

- 📱 **行動裝置優先，可邊聊邊推進** — 在手機、平板和桌面閱讀陸續到來的回答，助理工作時也能追加需求，不需建立筆記庫索引或部署獨立後端。
- 🧰 **筆記庫操作與外部工具** — 22 個內建工具處理筆記、檔案、屬性、連結、Canvas 和網頁；使用 Anthropic 或 OpenAI API key 時，還能依需要連接遠端 MCP 工具。
- 📎 **由你選擇任務上下文** — 使用目前筆記、把修改限制在選取範圍、透過 `@` 或 `[[` 引用檔案，並帶上圖片、PDF 和 Office 文件。
- 🧩 **可重複使用的個人工作流程** — 用 `AGENTS.md` 說明筆記庫規則，用 Skills 保存常用任務，也能透過 `/name` 直接呼叫。
- 👀 **看得見、可復原的變更** — 跟隨修改定位到筆記段落或 Canvas 卡片，查看執行步驟，並在本次工作階段的快照仍可用時復原某次回答的變更。
- 💬 **可隨時追加、切換和繼續的對話** — 為不同任務保留命名對話，切換聊天時已傳送的任務繼續執行，重新啟動後也能返回保存的對話。
- 🧠 **長對話與清楚的用量資訊** — 查看上下文佔用、token 總量和有價格資料時的 API 費用估算，透過壓縮早期上下文繼續推進對話。

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

使用 **Anthropic 或 OpenAI API key** 時，可以新增公開 HTTPS MCP 伺服器，把其他服務的工具帶入對話。模型服務連接已啟用的伺服器，呼叫和結果會與筆記工具一樣顯示為步驟。本外掛的 ChatGPT 帳號連線暫不支援遠端 MCP，也不支援本機或 stdio 伺服器。

### 為每個任務提供合適的上下文

從目前筆記開始，或輸入 `@` / `[[` 引用指定檔案。透過輸入框或貼上附加圖片、PDF、Word、Excel、PowerPoint 和文字檔。Canvas 可以提供結構大綱，也能由助理查看畫面配置。

只想改一段時，選取文字並選擇 **Send selection to chat**。工具會把對該筆記的直接編輯限制在選取範圍內；其他筆記仍可編輯，重新命名其他檔案時，Obsidian 也仍可能更新這裡的連結。

### 讓助理遵循你的工作方式

根目錄的 `AGENTS.md` 定義整個庫的規則；某個資料夾中的 `AGENTS.md` 會在對話首次涉及該目錄時補充局部規則。在庫內 `Skills` 資料夾中保存可重複使用的任務，每個任務包含 `SKILL.md`，還可以帶範本和範例。助理能依任務載入相應技能，你也可以輸入 `/` 主動選擇。

Skills 沿用 Claude Code / Codex 的資料夾格式。助理可以讀取說明和配套檔案，但不會執行其中的指令碼。

### 檢查和復原筆記庫變更

**Follow the AI's edits** 會定位到修改的筆記段落或 Canvas 卡片，同時保留聊天輸入焦點。完成的工具步驟摺疊成一行，需要時展開。每次回答的 **Undo** 可以還原記錄下來的編輯、建立、重新命名和刪除；如果檔案之後又被修改，會先詢問。復原快照有容量限制且僅保存在記憶體裡，重新啟動或快照過期後不能再復原。

### 讓任務在對話中持續推進

可以新增、切換、重新命名和刪除獨立對話，每個對話保留自己的模型上下文。切換聊天後，已經送出的回答會在原對話繼續，清單顯示 *Answering…*；需要你回答的問題會留在原對話等你返回。工作時可以繼續輸入並傳送文字，加入下一步或作為下一輪執行；新增附件和選取範圍會留到下一輪。

如果切換 App 或鎖定螢幕中斷了請求，回到 Obsidian 後可恢復符合條件的暫時失敗；重新啟動後，符合條件的未完成任務會提供 **Continue**。這表示回來後恢復，不保證手機在背景持續執行。遠端 MCP 操作可能已經發生時，需要先查看外部服務，結果不確定的遠端請求不會自動重複執行。

連線支援時逐步顯示回答，否則整段返回；停止會保留已經顯示的文字。支援 Markdown、表格、雙向連結和數學公式，向上閱讀時不會被拉回底部。可以複製回答、編輯模型仍保留的歷史訊息、重新產生最後一次回答；編輯或重新產生不會復原檔案變更。

### 讓長對話保持可用

聊天標題列的上下文圓環顯示對話佔用了多少模型視窗。點開可查看 token 總量、**有價格資料時的 API 費用估算**，並使用 **Compact now**。ChatGPT 帳號會提供方案用量入口，不估算訂閱費用。

用 **Compaction point** 設定何時總結早期上下文，也可以手動壓縮。完整的可見聊天紀錄仍可向上捲動閱讀，模型則依據摘要和近期上下文繼續。摘要可能遺失細節，最近一次壓縮已涵蓋的訊息不能再編輯或重新產生。

每個對話單獨保存在本機，開啟時再載入；設定裡顯示保存對話的總大小，較大的對話也會在清單中顯示體積。舊版聊天遷移前會保留原歷史檔案備份。本機歷史與模型上下文視窗是兩回事，保存完整聊天並不代表模型視窗無限。

## ⚙️ 三種連線方式

| 連線方式 | 需要什麼 | 如何使用 | 遠端 MCP |
|---|---|---|---|
| **Anthropic** | Anthropic API key | 使用 Claude 模型；思考和網頁搜尋能力取決於模型。 | 支援 |
| **OpenAI** | OpenAI API key | 透過 Responses API 使用 OpenAI 模型；推理和網頁搜尋能力取決於模型。 | 支援 |
| **ChatGPT 帳號** | 具備 Codex 存取權限的 ChatGPT 方案 | 登入帳號，使用該帳號可存取的 Codex 模型。 | 此連線暫不支援 |

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
- **MCP 伺服器預設關閉，啟用後呼叫不逐次確認。** 模型服務可能向工具傳遞對話上下文及設定的 token，請只連接可信伺服器；token 保存在本機 SecretStorage。停止不能收回已傳送的遠端請求，筆記庫復原也不會回復外部 MCP 變更。
- **網頁與附件屬於外部輸入。** 讀取網頁會使用本機網路，包括本機能存取的區域網路位址。不要把網頁或檔案裡隱藏的指令當作可信規則。附件和請求設有容量限制，以控制裝置記憶體和請求大小。

附件限制、不同模型對 PDF / Office 的處理方式、完整工具清單、設定和恢復說明見 **[使用指南（英文）](../user-guide.md)**。已記錄的驗證範圍見[桌面與 iPhone 驗收紀錄](../phase1-review.md)。

## 🗺️ 接下來

筆記與 Canvas 操作、上下文選擇、Skills、檢查與復原、串流回答、執行中追加訊息、長對話壓縮和用量查看均已提供。Anthropic/OpenAI API key 連線還可依需要啟用遠端 MCP。**歷史對話的封存與搜尋仍在路線圖中。** 每個版本的變化見[發行紀錄](https://github.com/o1xhack/obsidian-chatting/releases)，也歡迎[提交 Issue](https://github.com/o1xhack/obsidian-chatting/issues) 回饋。

## 🤝 參與貢獻

歡迎 Issue 和 PR。程式碼變更請執行 `npm test`、`npx tsc --noEmit`、`npm run svelte-check` 和 `npm run build`；影響應用使用的變更，還應至少在一個行動平台上驗證。較大變更請先開 Issue 對齊方向。

## 🙏 致謝

最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（MIT），原版權資訊保留在 `LICENSE` 中。Chatting with AI 現在是獨立專案，擁有自己的 agent loop、行動裝置支援、ChatGPT 帳號連線和筆記庫工作流程。

感謝 [Thomas Schierl](https://github.com/thomas0schierl) 對聊天持久化、渲染、筆記工具和回歸測試框架的貢獻。

## 📄 授權條款

[MIT](../../LICENSE)。

---

作者：[Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
