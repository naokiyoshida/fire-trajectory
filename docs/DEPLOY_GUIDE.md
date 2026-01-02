# 開発・デプロイガイド

## 1. はじめに

本文書は、`fire-trajectory` プロジェクトのソースコードを自身の環境で開発・管理し、変更点を本番環境（Google Apps Script, ユーザースクリプト配布元）へデプロイするための手順を解説します。

このガイドは、プロジェクトを単に利用するエンドユーザー向けではなく、コードをフォークまたはクローンして、自身の環境で改変・デプロイする開発者を対象としています。

## 2. 開発環境のセットアップ

### 2.1. 前提ツール

開発には以下のツールが必要です。事前にインストールしてください。

-   Git
-   Node.js (npm を含む)

### 2.2. リポジトリのクローン

まず、本プロジェクトのリポジトリをローカル環境にクローンします。

`git clone https://github.com/naokiyoshida/fire-trajectory.git`
`cd fire-trajectory`

### 2.3. Google Apps Script 用CLIツール (clasp) の導入

Google Apps Script(GAS)のプロジェクトをローカルで管理するため、Google公式のCLIツールである `clasp` をインストールします。

`npm install -g @google/clasp`

## 3. サーバーサイド (GAS) のデプロイフロー

ローカルで編集したGASのソースコードを、`clasp` を使って効率的にGoogleのサーバーへ反映させます。

### 3.1. Googleアカウントへの認証

最初に、`clasp` からご自身のGoogleアカウントへアクセスするための認証を行います。

`clasp login`

ブラウザが開き、Googleアカウントへのログインと権限の承認を求められますので、許可してください。
また、GASプロジェクトをAPI経由で操作するために、[Google Apps Script API](https://script.google.com/home/usersettings) を有効にする必要があります。

### 3.2. GASプロジェクトとの紐付け

ローカルのリポジトリとGoogle上のGASプロジェクトを紐付けます。

#### 新規にGASプロジェクトを作成する場合

`clasp create --title "fire-trajectory" --rootDir ./src`

このコマンドにより、Google Drive上に "fire-trajectory" という名前のGASプロジェクトが新規作成され、ローカルの `./src` ディレクトリがGASプロジェクトのルートとして設定されます。

#### 既存のGASプロジェクトを利用する場合

1.  ブラウザで対象のGASプロジェクトを開き、「プロジェクトの設定」（歯車アイコン）から **スクリプトID** をコピーします。
2.  以下のコマンドを実行して、既存のプロジェクトをローカルにクローン（紐付け）します。

`clasp clone "ここにスクリプトIDを貼り付け" --rootDir ./src`

いずれの場合も、リポジトリのルートに `.clasp.json` ファイルが生成され、プロジェクトの紐付け情報が保存されます。

### 3.3. コードのアップロード

ローカルで `src/gas_receiver_service.gs` や `src/appsscript.json` などのファイルを編集した後、以下のコマンドでサーバーに内容を反映させます。

`clasp push`

### 3.4. 本番環境へのデプロイ

コードをウェブアプリケーションとして公開（または更新）するには、デプロイ作業が必要です。

`clasp deploy`

このコマンドを実行すると、デプロイ履歴（バージョン）が作成され、変更がウェブアプリに反映されます。
`README.md` のセットアップ手順に従い、GASの管理画面からウェブアプリのURLを取得してください。

## 4. クライアントサイド (ユーザースクリプト) の配布フロー

`mf_sync_client.user.js` を改変し、自身の利用環境や他のユーザーに配布するための推奨フローです。GitHubとTampermonkeyの連携機能を利用します。

### 4.1. GitHubリポジトリの準備

このリポジトリを自身のGitHubアカウントにフォークするか、全く新しいリポジトリとしてコードをプッシュします。

### 4.2. `@downloadURL` と `@updateURL` の設定

ユーザースクリプトが自身のGitHubリポジトリから更新を自動的に取得できるように、`src/mf_sync_client.user.js` のヘッダー部分を修正します。

```javascript
// ==UserScript==
// ...
// @downloadURL  https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPOSITORY/main/src/mf_sync_client.user.js
// @updateURL    https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPOSITORY/main/src/mf_sync_client.user.js
// ...
// ==/UserScript==
```

`YOUR_USERNAME` と `YOUR_REPOSITORY` をご自身のものに書き換えてください。

### 4.3. 更新の反映

1.  ローカルで `mf_sync_client.user.js` を編集します。
2.  変更をコミットし、自身のGitHubリポジトリにプッシュします (`git push`)。
3.  このURLからスクリプトをインストールしたTampermonkeyは、1日に1回程度の頻度で自動的に更新を確認し、変更があればスクリプトをアップデートします。

## 5. 秘匿情報の管理

`API_KEY` のような他者に知られてはならない秘匿情報は、Gitリポジトリに直接含めるべきではありません。

本プロジェクトでは、`API_KEY` は **GASのスクリプトプロパティ** を利用してサーバー側に保存されます。`clasp push` コマンドはソースコードのみをアップロードし、スクリプトプロパティは上書きしないため、Gitでコードを管理しても秘匿情報が漏洩することはありません。

スクリプトプロパティは、GASのWebエディタから手動で設定してください。
