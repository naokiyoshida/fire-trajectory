# fire-trajectory (自由への軌道)

Money Forward ME の資産データを自動収集・蓄積し、FIRE (Financial Independence, Retire Early) 達成に向けた軌跡を可視化・シミュレーションするためのシステムです。

## プロジェクト構成

本システムは、クライアントサイド（データ収集）とサーバーサイド（データ蓄積）の2層構造で動作します。

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
  - gas_receiver_service.gs (Web API)
       |
       v
[ Google Sheets ]
  - Database (蓄積データ)
  - Simulation (将来予測/可視化)
```

## 主要コンポーネント

| コンポーネント | ファイル名 | 役割 |
|---|---|---|
| **Sync Client** | `mf_sync_client.user.js` | Money Forward ME の画面からデータをスクレイピングし、GASへ送信します。SPA遷移検知、自動ページめくり、重複排除機能を搭載。 |
| **Launcher** | `RunSyncHidden.ps1` | タスクスケジューラからChromeを「非表示（または最小化）」で起動するためのPowerShellスクリプト。自動同期モード(`force_auto_sync`)を強制します。 |
| **Receiver** | `gas_receiver_service.gs` | データを受信し、スプレッドシートへ追記するためのGoogle Apps Script (Web App)。 |
| **Config** | `appsscript.json` | GASプロジェクト定義ファイル。 |

## 主要機能

### 1. Robust Adaptive Sync (堅牢な適応型同期)

- **期間自動調整**: 新規シート作成時は「全期間（2021年〜）」、運用中は「直近6ヶ月」と、データの蓄積状況に応じて同期範囲を自動で切り替えます。
- **日付不一致耐性**: Money Forward側で未来の日付ページなどが表示できない場合でも、現在表示されているページの日付を正として同期を継続し、無限リロードループを回避します。
- **SPA対応**: 画面遷移を監視し、論理的な年月カウンターと実際のURL/DOMを正確に同期させます。

### 2. Task Scheduler Integration (完全自動実行)

- **強制自動モード**: URLパラメータ `?force_auto_sync=true` を付与することで、前回同期時刻に関わらず即座に同期プロセスを開始します。
- **ステルス実行**: `RunSyncHidden.ps1` とタスクスケジューラの「表示しない」設定を組み合わせることで、完全バックグラウンドでの定期実行を実現します。

### 3. Sandbox Bypass (自動終了)

- 同期完了後、指定された待機時間（デフォルト3秒）を経てブラウザタブを自動的に閉じます。これにより、毎日の定期実行でタブが溜まり続けるのを防ぎます。

### 4. Simulation & Sensitivity Analysis (シミュレーション)

- **フィッシャー方程式**: インフレ率を考慮した実質利回り計算 ($r = (1+n)/(1+i)-1$) を適用。
- **ライフイベント**: ローン完済 (2028/03)、配偶者退職、年金受給開始などを考慮したキャッシュフロー計算をスプレッドシート上で実現（仕様詳細は `FUNCTIONAL_SPEC.md` 参照）。

## ライセンス (License)

本ソフトウェアは [MIT License](LICENSE) の下で公開されています。

## 免責事項 (Disclaimer)

本ツールは開発者個人の学習・研究を目的として作成されたものであり、Money Forward ME の公式ツールではありません。

1. **利用のリスク**: 本ツールのご利用により生じた、いかなる損害・損失・トラブル（アカウント停止措置等を含む）についても、開発者は一切の責任を負いません。ご利用は全て**自己責任**でお願いいたします。
2. **規約の遵守**: スクレイピングや自動化を行う際は、対象サイト（Money Forward ME）の利用規約および `robots.txt` を必ず確認し、遵守してください。過度なアクセス（短時間の連続リクエスト等）はサーバーへの攻撃とみなされる恐れがあります。
3. **APIの変更**: 本ツールはWeb画面の構造に依存しています。Money Forward ME の仕様変更により、予告なく動作しなくなる可能性があります。
