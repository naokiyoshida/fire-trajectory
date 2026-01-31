# デプロイ・運用ガイド: fire-trajectory

本プロジェクトの開発環境セットアップ、デプロイ、および日常の運用手順について解説します。

## 1. 開発環境のセットアップ

### 1.1. 前提ツール

- **Git**: リポジトリ管理用
- **Node.js**: `clasp` (GAS管理ツール) の実行に必要

### 1.2. リポジトリの準備

```bash
git clone https://github.com/your-username/fire-trajectory.git
cd fire-trajectory
npm install -g @google/clasp
clasp login
```

## 2. サーバーサイド (GAS) のデプロイ

### 2.1. プロジェクトの紐付け

- **新規作成**: `clasp create --title "fire-trajectory" --rootDir ./src`
- **既存紐付け**: `clasp clone "YOUR_SCRIPT_ID" --rootDir ./src`

### 2.2. コードの反映と公開

1. **アップロード**: `clasp push`
2. **ウェブアプリ公開**:
    - GASエディタで「新しいデプロイ」を選択。
    - 種類「ウェブアプリ」、実行ユーザー「自分」、アクセス「自分のみ」でデプロイ。
    - 発行された **ウェブアプリURL** をメモする。

### 2.3. シミュレーションの初期化

GASエディタで `setupSimulation` 関数を選択して実行します。これにより、スプレッドシートに `Settings` と `Simulation` シートが自動生成されます。

## 3. クライアントサイドのセットアップ

### 3.1. ユーザースクリプト (Tampermonkey)

1. `src/mf_sync_client.user.js` を Tampermonkey に新規登録。
2. スクリプト実行時、またはメニューから **ウェブアプリURL** を設定。

### 3.2. GitHub自動更新 (推奨)

スクリプトヘッダーの `@updateURL` を自身の GitHub Raw URL に書き換えることで、コード修正を自動的に Tampermonkey へ反映できます。

## 4. 自動実行の設定 (Windows)

### 4.1. 起動スクリプトの調整

`RunSyncHidden.ps1` 内の `$ProfileDir` を、使用する Chrome のプロファイル名に合わせて修正します。

### 4.2. タスクスケジューラ

- **プログラム**: `powershell.exe`
- **引数**: `-ExecutionPolicy Bypass -File "C:\path\to\RunSyncHidden.ps1"`
- **設定**: 「ユーザーがログオンしているかどうかにかかわらず実行する」は避け、「ログオンしているときのみ」＋「表示しない」を推奨します。

## 5. 秘匿情報の管理

`API_KEY` などの重要設定は、GASの「スクリプトプロパティ」で管理します。これにより、GitHub にコードを公開しても認証情報が漏洩することはありません。
