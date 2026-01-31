# fire-trajectory (自由への軌道)

Money Forward ME の資産データを自動収集・蓄積し、FIRE (Financial Independence, Retire Early) 達成に向けた軌跡を可視化・シミュレーションするためのシステムです。

## プロジェクト構成

本システムは、クライアントサイド（データ収集）とサーバーサイド（データ蓄積・分析）の2層構造で動作します。

```text
[User / Task Scheduler] 
       |
       v
[ PC / Chrome ] 
  - RunSyncHidden.ps1 (起動ランチャー)
  - mf_sync_client.user.js (Tampermonkeyスクリプト)
       |
       | (HTTPS/POST: JSON)
       v
[ Google Cloud / GAS ]
  - gas_receiver_service.gs (Web API / Logic)
       |
       v
[ Google Sheets ]
  - Database (蓄積データ)
  - Settings (シミュレーション設定)
  - Simulation (将来予測・資産推移グラフ)
```

## 主要コンポーネント

| コンポーネント | ファイル名 | 役割 |
|---|---|---|
| **Sync Client** | `mf_sync_client.user.js` | Money Forward ME の画面からデータをスクレイピングし、GASへ送信します。SPA遷移検知、自動ページめくり、重複排除機能を搭載。 |
| **Launcher** | `RunSyncHidden.ps1` | タスクスケジューラからChromeをバックグラウンドで起動するためのPowerShellスクリプト。 |
| **Receiver & Logic** | `gas_receiver_service.gs` | データ受信、スプレッドシートへの蓄積、およびシミュレーション環境の自動構築を行います。 |
| **Documentation** | `FUNCTIONAL_SPEC.md` | システムの詳細な計算論理、通信仕様、データ構造を定義。 |
| **Guide** | `DEPLOY_GUIDE.md` | 開発環境のセットアップおよびデプロイ手順を解説。 |

## 主要機能

### 1. Robust Adaptive Sync (堅牢な適応型同期)

- **期間自動調整**: データの蓄積状況に応じて同期範囲（全期間 or 直近6ヶ月）を自動で切り替えます。
- **日付不一致耐性**: 画面上の日付を正として同期を継続し、リロードループを回避します。
- **SPA対応**: 画面遷移を監視し、年月カウンターと正確に同期させます。

### 2. Simulation & Visualization (資産寿命予測)

- **自動セットアップ**: `setupSimulation` 関数により、シミュレーション用シートとグラフを自動生成。
- **実質利回り計算**: フィッシャー方程式に基づき、インフレ率を考慮した実質的な資産成長を予測。
- **ライフイベント制御**: ローン完済、配偶者の退職、年金受給開始などの収支変化を動的に反映。

### 3. Stealth Automation (ステルス自動実行)

- **タスクスケジューラ連携**: `RunSyncHidden.ps1` により、作業を妨げない完全バックグラウンド実行を実現。
- **Sandbox Bypass**: 同期完了後、ブラウザタブを自動的に閉じます。

## ドキュメント

- [機能仕様書](FUNCTIONAL_SPEC.md): 計算ロジックやデータ定義の詳細。
- [デプロイガイド](DEPLOY_GUIDE.md): セットアップとデプロイの手順。

## ライセンス (License)

本ソフトウェアは [MIT License](LICENSE) の下で公開されています。

## 免責事項 (Disclaimer)

本ツールはMoney Forward ME の公式ツールではありません。利用規約を遵守し、自己責任でご利用ください。
