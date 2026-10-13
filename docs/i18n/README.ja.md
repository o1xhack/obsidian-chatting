# Chatting with AI

[![最新リリース](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![ダウンロード総数](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![ライセンス](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](../../LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.11.4%2B-7c3aed)](https://obsidian.md)
<br>
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-o1xhack-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/o1xhack)

**Obsidian の Vault に常駐する agentic な AI アシスタント —— スマホ・タブレット・デスクトップで同じ体験。**

> 🌐 [English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · **日本語**

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone のプロバイダ設定画面" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="ウェブ検索を使った中国語の回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="箇条書き付きの英語回答" width="260">
</p>

---

## ✨ なぜ?

- **3 つのプロバイダから選べる** —— Anthropic API、OpenAI API、または ChatGPT アカウントでサインイン。中途半端なプロバイダのバザールはやりません。
- **14 個の vault ネイティブツール** —— 読み・編集・検索・作成・リネーム・frontmatter・backlinks。アイデアからファイル変更まで、チャットを離れずに完結します。
- **モバイル妥協なし、設計から** —— localhost コールバックに依存しません。iOS と Android はデスクトップと同じ動作。
- **ストリーミング表示** —— 回答はモデルが書くそばから表示されます。スマホでプロバイダーがそれを許可しない場合は、完成してからまとめて表示されます。
- **選択範囲スコープ** —— ノートのテキストを選択して送ると、アシスタントは選択範囲内だけを編集。
- **シークレットは OS のキーチェーンへ** —— `data.json` には絶対に書き込まれず、他端末に同期もされません。

## 🎬 一度の指示で複数ツールを連鎖

一度尋ねるだけで、アシスタントが必要なツールを選んで実行します:

```
あなた: /Books 配下で `rating` プロパティが欠けているノート全部に `rating: ?` を追加して。

アシスタント
  → search_vault("/Books")               → 12 ファイル
  → get_properties("Books/Sapiens.md")   → rating あり
  → get_properties("Books/Hail Mary.md") → rating なし
  → set_properties("Books/Hail Mary.md", { rating: "?" })
  → ... (あと 5 件)

  完了 —— 6 ノートに `rating: ?` を追加しました:
  - Books/Hail Mary.md
  - Books/Klara and the Sun.md
  - ...
```

方針は「編集する前に読む / 大きな書き換えより小さな修正を優先 / 一度確認したことは聞き直さない」です。

## 🎯 選択範囲スコープ

任意のノートでテキストを選択し、右クリックで **Send selection to Chat** を選びます。選択範囲は入力欄の上に pill として表示され、アシスタントはその範囲内だけを編集します —— ドキュメントの残りはバイト単位で完全に同一のままです。

```
[ pill: "...導入が少し冗長で、しかも..."  ✕ ]

あなた: 引き締めて —— 自分の声色は残して
```

アシスタントは選択テキストにスコープを限定して find-and-replace を行います。選択範囲外は一切触れません。

## 🛠️ 14 個の vault ネイティブツール

| グループ | ツール | できること |
|---|---|---|
| **読み取り** | `read_document`、`read_file`、`search_vault`、`list_files`、`get_backlinks`、`get_properties`、`get_current_datetime` | 任意のノート/ファイルを開く;ファイル名と内容で検索;ツリーを閲覧;バックリンクを取得;YAML frontmatter を読み取り;ユーザーロケールでの現在時刻を取得。 |
| **書き込み** | `edit_document`、`create_file`、`set_properties` | ピンポイントの find-and-replace / 挿入 / 全置換;新規ノート作成(親フォルダは自動作成);YAML frontmatter の安全な統合または削除。 |
| **管理** | `rename_file`、`delete_file`、`open_document`、`ask_user` | リネームまたは移動(リンクは自動追従);ゴミ箱へ移動(ユーザーのゴミ箱設定を尊重);エディタでファイルを開く;曖昧なときはこちらに質問し返す。 |

## ⚙️ 3 つのプロバイダ

| プロバイダ | 認証 | 既定モデル | メモ |
|---|---|---|---|
| **Anthropic** | API キー | Claude Sonnet 4.6 | 適応的思考、ウェブ検索、プロンプトキャッシュ。 |
| **OpenAI** | API キー | Codex 5.3 | Responses API、推論、ウェブ検索。 |
| **ChatGPT アカウント** | ChatGPT サインイン | GPT-5.5 | OpenAI API キーの代わりに ChatGPT プランを使用。 |

> **ChatGPT アカウントサインインについて。** このプロバイダは ChatGPT アカウントでサインインし、リクエストは ChatGPT/Codex バックエンド経由(`api.openai.com` ではない)で送られます。Codex が有効な ChatGPT プランが必要です。利用できるモデルは Codex CLI のカタログに準じます。

## 🚀 クイックスタート

1. **設定 → Community plugins → Browse** を開く。
2. **Chatting with AI** を検索する。
3. **Install**、続いて **Enable** をクリックする。
4. **設定 → Chatting with AI** → プロバイダを選び、API キーを貼り付け(または **Connect ChatGPT** をクリック)。
5. リボンアイコンまたはコマンドパレットからチャットを開く。

## 📦 インストール

### Community Plugins(推奨)

Chatting with AI は公式 Obsidian Community Plugins ディレクトリに掲載されています。これが既定の推奨インストール方法です。

1. Obsidian で **設定 → Community plugins** を開く。
2. 必要なら Restricted Mode をオフにして Community plugins を有効化する。
3. **Browse** をクリックし、**Chatting with AI** を検索する。
4. **Install**、続いて **Enable** をクリックする。

### BRAT から移行

以前 BRAT でベータ版をインストールしていた場合、プラグインブラウザに表示され次第、コミュニティ版へ移行できます。

1. **設定 → Community plugins → Installed plugins** で **Chatting with AI** を無効化する。
2. **BRAT** 設定を開き、beta plugin list から `o1xhack/obsidian-chatting` を削除する。
3. **設定 → Community plugins → Browse** に戻り、**Chatting with AI** を検索する。
4. Obsidian が **Installed** と表示する場合は詳細を開いて **Enable** をクリックする。**Install** と表示される場合は **Install**、続いて **Enable** をクリックする。
5. **設定 → Chatting with AI** を開き、プロバイダ設定が残っていることを確認する。

初回起動時に、古い `obsidian-chatting` フォルダのデータは `chatting-with-ai` に移行されます。古い beta を使っていてコミュニティプラグインブラウザがインストール済みとして認識しない場合でも、コミュニティ版を直接インストールして問題ありません。新しいプラグインの起動時に移行が実行されます。

<details>
<summary><b>手動 release インストール</b></summary>

1. [最新リリース](https://github.com/o1xhack/obsidian-chatting/releases/latest) から `main.js`、`manifest.json`、`styles.css` をダウンロード
2. `<vault>/.obsidian/plugins/chatting-with-ai/` に配置
3. Obsidian を再読み込みし、Community Plugins で **Chatting with AI** を有効化

</details>

<details>
<summary><b>ソースからビルド</b></summary>

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run build
```

テスト用 vault にシンボリックリンク:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/chatting-with-ai
```

</details>

## 🧭 設計原則

| 原則 | 意味 |
|---|---|
| **モバイルは後付けではない** | すべての変更を iOS と Android で検証。回答はプラットフォームが許す限りストリーミングし、それ以外は Obsidian の `requestUrl()` でまとめて届きます。localhost コールバックは使いません。 |
| **3 つの堅実なプロバイダ** | Anthropic + OpenAI で安定性、ChatGPT アカウントで API キー不要派をカバー。 |
| **シークレットはキーチェーンへ** | API キーと OAuth 認証情報は Obsidian SecretStorage 経由。`data.json` には入らないため、他の端末に同期もされません。 |
| **Vault のインデックス化は行わない** | 上限つきの線形検索のみ。予測可能で、バックグラウンドジョブなし、モバイルでもメモリを圧迫しません。 |
| **会話は永続化** | チャット履歴は Obsidian 再起動後も残ります。ローカルの `chat-state.json` に保存され、同期されません。 |
| **モバイルでは右からスライドイン** | 右端から入るサイドバーで、下のドキュメントは見えたまま。 |

## 🗺️ ロードマップ

- [x] 3 つのプロバイダ(Anthropic、OpenAI、ChatGPT アカウント)
- [x] 14 個の vault ネイティブツール
- [x] iOS / Android パリティ
- [x] 選択範囲スコープ
- [x] Obsidian Community Plugins への掲載
- [ ] 複数会話履歴 + アーカイブ/検索
- [ ] プロバイダがサポートする画像添付
- [ ] 上流で新しくリリースされたプロバイダモデルへの自動追従

要望があれば issue を立ててください。

## ❓ FAQ

<details>
<summary><b>ノートはどこかにアップロードされますか?</b></summary>

その場のターンに必要な分だけです。あなたが質問すると、アシスタントが呼び出すツール —— `read_document`、`search_vault` など —— を判断し、それらが取得した内容(プラスアクティブなノートのコンテキスト)が選択したプロバイダに送られます。バックグラウンドで何かをアップロードすることはありません。**Vault のインデックスも作りません。**

</details>

<details>
<summary><b>本当にモバイルで動きますか?</b></summary>

はい —— その制約こそが他のすべての設計の起点です。リクエストは Obsidian の `requestUrl()` を通ります(モバイル WebView は CORS を強制)。例外はチャットの回答で、ストリーミングします:デスクトップでは Node の `https`、モバイルではプロバイダーが許可すれば `fetch`、そうでなければ `requestUrl()` でまとめて。OAuth の localhost コールバックは使いません。iOS と Android はデスクトップと同じ機能を持ちます。

</details>

<details>
<summary><b>ChatGPT アカウントサインインは無料ですか?</b></summary>

既存の ChatGPT プラン(Plus、Pro、Team、Enterprise)を利用するため、別途課金は発生しません。Codex が有効な ChatGPT プランが必要です。プラグインは `api.openai.com` ではなく、Codex CLI が使うのと同じバックエンドに通信します。

</details>

<details>
<summary><b>X というプロバイダを追加できますか?</b></summary>

おそらく追加しません —— プロバイダ一覧を小さく保つのは意図的な選択です。2 つの API プロバイダで主要な API エコシステムをカバーし、ChatGPT アカウントサインインで「ChatGPT プランしか持っていない」ケースをカバーしています。これ以上増やすとモバイルで検証する組み合わせが増えます。

</details>

<details>
<summary><b>チャット履歴はどこに保存され、同期されますか?</b></summary>

ローカルの `<vault>/.obsidian/plugins/chatting-with-ai/chat-state.json` に保存されます。**Obsidian Sync は既定でプラグインデータファイルを除外する**ため、同期されません。API キーは SecretStorage 経由で OS のキーチェーンに保存され、これも同期されません。

</details>

## 🤝 コントリビューション

Issue と PR を歓迎します。PR を出す前に:

- `npx tsc --noEmit` と `npm run svelte-check` を実行
- 少なくとも 1 つのモバイルプラットフォーム(iOS または Android)で動作確認 ——「モバイルパリティ」は本気のルールです
- 大きめの変更は、まず Issue で方向性をすり合わせてから

## 🙏 謝辞

元々は [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)(MIT)から派生したもので、原版の著作権表示は `LICENSE` に保持されています。Chatting with AI は現在、独自のロードマップを持つ独立プロジェクトです —— 主な書き換えには agent ループ、モバイルパリティ対応、ChatGPT アカウントプロバイダ、選択範囲スコープ機能が含まれます。

## 📄 ライセンス

[MIT](../../LICENSE)。

---

作者: [Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
