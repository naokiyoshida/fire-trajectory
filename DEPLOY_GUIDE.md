# デプロイガイド (DEPLOY_GUIDE)

本プロジェクト『fire-trajectory』の開発環境セットアップおよび本番環境へのデプロイ手順を解説します。

## 1. はじめに

本ガイドは、ソースコードをフォークまたはクローンし、自身の環境（Google Apps Script および ローカルPC）で稼働させる開発者・利用者向けの手順書です。

## 2. 開発環境セットアップ

### 前提条件

- Node.js (v16以上推奨)
- Google アカウント

### リポジトリの取得

```bash
git clone https://github.com/your-username/fire-trajectory.git
cd fire-trajectory
```

### 依存ツールのインストール

GAS管理ツール `clasp` を使用します。

```bash
npm install -g @google/clasp
clasp login
```

ブラウザが開くので、Googleアカウントでログインして権限を承認してください。

## 3. サーバーサイド (Google Apps Script) のデプロイ

### GASプロジェクトの作成/紐付け

新規に作成する場合:

```bash
clasp create --type webapp --title "fire-trajectory-receiver"
# 作成後、生成された .clasp.json の scriptId を確認してください
```

既存プロジェクトがある場合は `.clasp.json` の `scriptId` を更新してください。

### コードの反映

```bash
clasp push
```

`src/gas_receiver_service.gs` および `appsscript.json` がアップロードされます。

### ウェブアプリとしてデプロイ

1. GASエディタ (`clasp open`) を開く。
2. 「デプロイ」 > 「新しいデプロイ」を選択。
3. **種類の選択**: 「ウェブアプリ」
4. **説明**: `v1` (任意)
5. **次のユーザーとして実行**: **自分 (Me)**
6. **アクセスできるユーザー**: **自分のみ (Only myself)** ※重要
7. 「デプロイ」を実行し、発行された **ウェブアプリURL** (`https://script.google.com/.../exec`) をコピーする。

### 環境変数の設定 (Secret Management)

GASエディタの「プロジェクトの設定」 > 「スクリプト プロパティ」を開き、以下を追加してください。

| プロパティ名 | 値 | 説明 |
|---|---|---|
| `SHEET_NAME` | `Database` | データを保存するシート名 (任意) |
| `API_KEY` | (任意のランダム文字列) | 簡易認証用キー (任意だが推奨) |

## 4. クライアントサイド (UserScript) のセットアップ

### Tampermonkey へのインストール

1. Chromeに拡張機能「Tampermonkey」をインストール。
2. `src/mf_sync_client.user.js` の内容をコピーし、新規スクリプトとして保存。
3. **初期設定**: 初回実行時、またはメニューの「GAS URLを再設定」から、先ほど取得したGASの **ウェブアプリURL** を入力して保存する。

### GitHub連携 (オプション)

GitHub上のコード更新を自動反映させたい場合は、スクリプトヘッダーの `@downloadURL` / `@updateURL` を自身のフォークしたリポジトリの Raw URL に書き換えてください。

## 5. 自動化セットアップ (Task Scheduler)

完全自動化を行うための手順です。

### PowerShellスクリプトの準備

1. `RunSyncHidden.ps1` を任意のエディタで開く。
2. `$ProfileDir` を、同期に使用するChromeプロファイル名（例: `"Profile 1"`）に変更する。

### タスクスケジューラの設定

1. Win+R > `taskschd.msc` でタスクスケジューラを起動。
2. 「タスクの作成」を選択。
    - **全般**: 「ユーザーがログオンしているときのみ実行する」+ **「表示しない (Hidden)」にチェック**。
    - **トリガー**: 毎日 AM 4:00 など任意。
    - **操作**:
        - プログラム/スクリプト: `powershell`
        - 引数: `-ExecutionPolicy Bypass -File "path\to\RunSyncHidden.ps1"`
    - **条件**: 「コンピューターをAC電源で使用している場合のみ開始する」のチェックを外す（推奨）。

これで、指定時刻に完全バックグラウンドで同期が実行されます。
