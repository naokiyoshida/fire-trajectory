# fire-trajectory (自由への軌道)

マネーフォワードMEの実績データに基づき、未来の資産寿命を「日付」単位で精密に演算・予測する、エンジニアのためのFIRE（早期リタイア）意思決定支援エンジン。

## 1. プロジェクト概要
本プロジェクトは、日々の家計実績をGoogleスプレッドシートへ自動統合し、誕生日を基点とした確定日付、名目利回り、およびインフレ率を考慮した実質購買力ベースでの資産寿命を可視化します。

開発者：吉田直樹 (Nagoya, Japan)

## 2. システムアーキテクチャ (ASCII Art)

 [Windows Task Scheduler]
          |
          | (1. 定期起動)
          v
 [src/fire-launcher.html] <--- (親ウィンドウ / リポジトリ内)
          |
          | (2. 子ウィンドウ生成 / Sandbox制限回避)
          v
 [Money Forward ME] <--------- (子ウィンドウ)
          |
          | (3. データ抽出 / UserScript実行)
          |      ^
          |      | (4. @require: ローカル設定読込)
          |      +---- [src/fire-config.js] (Git管理外: 秘密情報)
          |
          | (5. HTTPS POST JSON)
          v
 [src/gas_receiver_service.gs] (Google Apps Script)
          |
          | (6. 差分更新 & シミュレーション再計算)
          v
 [Spreadsheet: Dashboard] <--- (意思決定支援)

## 3. 主要機能と設計思想

### Adaptive Sync (適応型同期戦略)
ターゲットシートの状態を動的に判別し、同期期間を最適化します。
- Full Recovery: データベースが空の場合、実績データの基点(2021/10)から現在まで（約52ヶ月分）を一括同期。
- Incremental Sync: 運用開始後は、直近6ヶ月分を常に同期し、確定遅延や修正を確実にキャッチアップします。

### Sandbox Bypass (所有権ハックによるオートクローズ)
ブラウザのセキュリティ制限を突破し、完全無人運用を実現。
- fire-launcher.html（親）からMF（子）を開く構成により、同期完了後にUserScriptが自律的にタブを閉じる(window.close)ことを可能にしました。

### Dual Simulation (二段構えの意思決定支援)
- 詳細推移表 (F1:H列): リタイア予定日に基づく、90歳までの月次資産残高を精密に出力。
- 感度分析表 (J1:M列): リタイア年齢を50歳-75歳まで1歳刻みで変化させ、損益分岐点を一瞬で特定。

## 4. ファイル構成

- src/fire-launcher.html : ブラウザ制約回避用ランチャー
- src/mf_sync_client.user.js : 同期用UserScript (Tampermonkey用)
- src/fire-config.js : 個人設定ファイル (Git無視対象：GAS_URL等を記述)
- src/fire-config.js.sample : 設定ファイルのテンプレート
- src/gas_receiver_service.gs : バックエンド・演算エンジン (GAS)
- docs/FUNCTIONAL_SPEC.md : 詳細設計書
- prompt/ : ドキュメント生成用AIプロンプト集

## 5. セットアップ手順

### 5.1 秘匿情報の分離設定
1. src/fire-config.js.sample をコピーして src/fire-config.js を作成します。
2. 作成したファイルに、自身の GAS_URL を記入します（.gitignoreによりGitには公開されません）。

### 5.2 クライアント(Tampermonkey)の設定
1. ChromeのTampermonkey拡張設定で「ファイルのURLへのアクセスを許可する」をONにします。
2. mf_sync_client.user.js を登録し、@require のパスを自身のローカル絶対パス（file:///...）に書き換えます。

### 5.3 自動運用の構成
1. Windows タスクスケジューラにて、リポジトリ内の src/fire-launcher.html を直接指定して Chrome を起動するように設定します。
   例: --profile-directory="Default" "file:///C:/.../src/fire-launcher.html"

## 6. 技術仕様：実質利回り
将来の資産を現在の購買力で評価するため、以下のフィッシャー方程式に基づいた実質月利を適用しています。

r = ((1 + 名目利回り) / (1 + インフレ率)) ^ (1/12) - 1

---
Copyright (c) 2026 Naoki Yoshida. (Nagoya, Japan)