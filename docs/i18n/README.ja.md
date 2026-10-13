# Chatting with AI

[![最新リリース](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![ダウンロード総数](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![ライセンス](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](../../LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.11.4%2B-7c3aed)](https://obsidian.md)
<br>
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-o1xhack-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/o1xhack)

**会話で Obsidian のノートを読み、編集・整理する、モバイルを中心に設計した AI アシスタント。**

> 🌐 [English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · **日本語**

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone のプロバイダ設定画面" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="ウェブ検索を使った中国語の回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="箇条書き付きの英語回答" width="260">
</p>

---

## ✨ 会話で Vault の作業を進める

Chatting with AI は、関連ノートの検索、下書きの修正、プロジェクトの整理、Canvas の編集を Obsidian 内で実行するアシスタントです。主な機能は次の 6 つです。

- 📱 **モバイルを中心にした軽量なチャット** — スマートフォン、タブレット、デスクトップに対応。Vault のインデックス作成や専用バックエンドの構築は不要です。
- 🧰 **実際に作業するノートアシスタント** — 22 個の内蔵ツールでノートの検索と編集、ファイルとプロパティの整理、リンクの確認、Canvas の操作、ウェブページの読み取りを行います。
- 📎 **タスクに合わせて選べるコンテキスト** — 現在のノート、選択範囲への編集制限、`@` や `[[` によるファイル参照、画像・PDF・Office 文書を組み合わせられます。
- 🧩 **繰り返し使える自分のワークフロー** — `AGENTS.md` で Vault のルールを伝え、Skills に定型作業を保存。`/name` で直接呼び出すこともできます。
- 👀 **確認して元に戻せる変更** — 編集したノートの箇所や Canvas カードを表示し、実行手順を確認。現在のセッションにスナップショットが残っている間は、回答ごとの変更を元に戻せます。
- 💬 **独立した、続きから話せる会話** — タスク別に名前付きのチャットを保存し、再起動後も再開。過去のメッセージの編集や回答の再生成もできます。

接続方法は **Anthropic API**、**OpenAI API**、**ChatGPT アカウントでのサインイン**の 3 つ。普段使っている AI に合わせて選べます。

## 🎬 できること

### ノート、ファイル、Canvas をまたいで作業する

自然な言葉で依頼すると、アシスタントが必要なツールを選び、資料を読んでから Vault 内で操作します。

> Books フォルダで評価がないノートを探して、`rating: ?` を追加して。
>
> この議事録を比較して、決定事項をプロジェクト計画にまとめて。
>
> Canvas のアイデアをグループ分けして、関連するカードをつないで。

本文、タグ、プロパティでノートを検索し、被リンク・発リンク・未リンクのメンションを確認できます。Canvas のカードや接続の読み取りと編集、Vault 内画像の確認、ウェブページのテキスト読み取りにも対応します。

### タスクに合った資料を渡す

現在のノートから始めるか、`@` / `[[` で指定したファイルを会話に含めます。入力欄や貼り付けから画像、PDF、Word、Excel、PowerPoint、テキストファイルを添付できます。Canvas は構造のアウトラインとして渡したり、アシスタントにレイアウトを画像で確認させたりできます。

一部分だけ書き直すなら、テキストを選択して **Send selection to chat** を選びます。ツールは、そのノートへの直接の編集を選択範囲内に制限します。他のノートは編集でき、別ファイルの名前変更に伴うリンク更新は Obsidian が引き続き行います。

### 自分の作業方法を伝える

Vault 直下の `AGENTS.md` で全体のルールを指定し、各フォルダの `AGENTS.md` で会話中にそのフォルダを初めて扱う際の追加ルールを伝えられます。定型作業は Vault の `Skills` フォルダに保存。各スキルに `SKILL.md` と必要なテンプレートや例を置きます。アシスタントが合うスキルを読み込むほか、`/` で自分で選べます。

Skills は Claude Code / Codex のフォルダ形式を使用します。説明と関連ファイルは読み取れますが、同梱スクリプトは実行しません。

### 変更を確認し、会話を続ける

**Follow the AI's edits** は、チャットの入力フォーカスを保ったまま変更箇所や Canvas カードを表示します。完了したツール手順は 1 行に折り畳まれ、必要に応じて展開できます。回答ごとの **Undo** は記録された編集・作成・名前変更・削除を戻します。後から変更されたファイルを上書きする前には確認します。スナップショットには容量制限があり、メモリ内にのみ保存されるため、再起動後やスナップショット失効後は元に戻せません。

チャットの新規作成、切り替え、名前変更、削除に対応し、各チャットは自分の会話履歴だけをプロバイダに送ります。Obsidian の再起動後も再開できます。過去のメッセージの編集、回答のコピー、最後の回答の再生成も可能です。編集や再生成で、既に行ったファイル変更が元に戻ることはありません。

回答はモデルが書くそばから表示され、Markdown、表、ウィキリンク、数式を表示できます。過去のメッセージを読む間は末尾へ強制スクロールされず、必要なときに最新の回答へ戻れます。

## ⚙️ 3 つの接続方法

| 接続先 | 必要なもの | 利用方法 |
|---|---|---|
| **Anthropic** | Anthropic API キー | Claude モデルを使用。思考やウェブ検索の対応はモデルによります。 |
| **OpenAI** | OpenAI API キー | Responses API 経由で OpenAI モデルを使用。推論やウェブ検索の対応はモデルによります。 |
| **ChatGPT アカウント** | Codex を利用できる ChatGPT プラン | アカウントでサインインし、利用可能な Codex モデルを使用。 |

モデル一覧はプロバイダやアカウントから取得して 24 時間キャッシュし、手動でも更新できます。思考レベルはカタログに情報がある場合にそれに従います。利用できるモデルや権限はプロバイダとアカウントによります。

デスクトップの ChatGPT サインインはブラウザを開き、自動で Obsidian に戻ります。デバイスコード方式もデスクトップで利用でき、現在のモバイル認証はこの方式です。認証情報は端末ごとに保存され、Vault の同期だけでは別端末にサインインしません。

## 🚀 クイックスタート

**Obsidian 1.11.4 以降**が必要です。デスクトップ、iOS、Android に対応します。

1. **設定 → Community plugins → Browse** を開きます。
2. **Chatting with AI** を検索し、**Install**、**Enable** を選びます。
3. **設定 → Chatting with AI** で接続先を選びます。
4. API キーを入力するか、ChatGPT アカウントを接続します。
5. リボンアイコンやコマンドパレットからチャットを開き、ノートについて依頼します。

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

## 🔐 プライバシーと管理

- **Vault 全体のバックグラウンド送信やインデックス作成はありません。** メッセージ、現在のノート、参照・添付ファイル、読み込んだルール、ツールで取得した資料は、会話に必要な範囲で選んだプロバイダに送られます。クラウドモデルを使うアシスタントであり、端末内だけで動くモデルではありません。
- **認証情報は Obsidian SecretStorage を使用します。** API キーや ChatGPT 認証情報はプラグインの `data.json` に保存しません。端末ごとに接続してください。
- **会話履歴は Vault のプラグインフォルダに保存します。** 名前付きチャットは `chat-state.json` に保存されます。プラグイン独自のチャット同期サービスはなく、ファイルが他端末に移るかは同期設定によります。添付データには保存量の上限があり、古い添付は名前のみになる場合があります。
- **変更は Vault 内で直接行われます。** 選択範囲の制限は選んだノートへの直接の編集が対象です。Undo には有効なスナップショットが必要です。長期の復元には普段のバックアップやバージョン履歴を使ってください。
- **ウェブページや添付ファイルは外部の入力です。** ページの取得には端末のネットワークを使い、端末から到達できるローカルアドレスにもアクセスできます。ページやファイルに隠された指示を信頼しないでください。端末メモリとリクエストサイズを抑えるため、添付や送信サイズには上限があります。

添付の上限、プロバイダ別の PDF / Office 処理、全ツール一覧、設定、復元の詳細は **[ユーザーガイド（英語）](../user-guide.md)** を参照してください。検証済みの範囲は[デスクトップと iPhone の QA 記録](../phase1-review.md)にあります。

## 🗺️ 今後の予定

名前付きチャット、画像・文書の添付、モデル一覧の更新、Canvas、Vault のルール、Skills は利用できます。**過去の会話のアーカイブと検索は今後の予定です。** バージョンごとの変更は[リリース](https://github.com/o1xhack/obsidian-chatting/releases)を参照し、フィードバックは [Issue](https://github.com/o1xhack/obsidian-chatting/issues) へお願いします。

## 🤝 コントリビューション

Issue と PR を歓迎します。コードを変更したら `npm test`、`npx tsc --noEmit`、`npm run svelte-check`、`npm run build` を実行し、アプリの利用に影響する変更は少なくとも 1 つのモバイル環境でも検証してください。大きな変更は先に Issue で相談してください。

## 🙏 謝辞

[omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（MIT）から派生し、元の著作権表示を `LICENSE` に保持しています。現在は独立したプロジェクトとして、独自のエージェントループ、モバイル対応、ChatGPT アカウント接続、Vault のワークフローを開発しています。

チャット保存、描画、Vault ツール、回帰テスト基盤に貢献してくださった [Thomas Schierl](https://github.com/thomas0schierl) に感謝します。

## 📄 ライセンス

[MIT](../../LICENSE)。

---

作者：[Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
