/**
 * fire-trajectory: GAS スクリプト
 *
 * 役割:
 *   - 「設定」「シミュレーション」「月次収支」「カテゴリ別支出」
 *     「純資産推移」「資産配分」「FIRE射程」シートの自動構築
 *   - スプレッドシートを開いた時のカスタムメニュー
 *
 * シート名（すべて日本語に統一）:
 *   - 取引履歴       (Node 側で書き込み)
 *   - 資産推移       (Node 側で書き込み)
 *   - 手動入力資産   (ユーザー入力)
 *   - 設定           (このスクリプトで構築・ユーザー編集)
 *   - シミュレーション (このスクリプトで構築)
 *   - 月次収支 / カテゴリ別支出 / 純資産推移 / 資産配分 / FIRE射程 (このスクリプトで構築)
 *
 * 廃止された役割（Node.js + Playwright 側に移行）:
 *   - マネフォME からのデータ受信 (doPost / sync_data 系) は削除済み
 *   - データ書き込みは Node 側が Google Sheets API で直接行う
 */

// ===== シート名定数（一箇所に集約） =====
const SHEET = {
  TRANSACTIONS: '取引履歴',
  ASSETS: '資産推移',
  MANUAL_ASSETS: '手動入力資産',
  DASHBOARD: '設定',
  SIMULATION: 'シミュレーション',
  REPORT_CASHFLOW: '月次収支',
  REPORT_SPENDING: 'カテゴリ別支出',
  REPORT_NETWORTH: '純資産推移',
  REPORT_ALLOCATION: '資産配分',
  REPORT_FIRE: 'FIRE射程'
};

// 数式内でシート名を 'シート名' 形式に引用するヘルパー
function quoteSheetName_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

// 「設定」シートの値を、行番号ではなく「項目名(A列)」で参照する数式フラグメントを返す。
// これにより設定シートの並び替え・セクション見出し挿入をしても数式が壊れない。
//   例: dashLookup_("'設定'", '基本生活費_月額')
//     → INDEX('設定'!$B:$B, MATCH("基本生活費_月額", '設定'!$A:$A, 0))
function dashLookup_(dashRef, key) {
  return 'INDEX(' + dashRef + '!$B:$B, MATCH("' + key + '", ' + dashRef + '!$A:$A, 0))';
}

/**
 * スプレッドシート起動時にカスタムメニューを追加する
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Fire Trajectory')
    .addItem('シミュレーションの再構築', 'setupSimulation')
    .addItem('レポートの再構築', 'setupReports')
    .addItem('表示形式の適用', 'applyFormatting')
    .addSeparator()
    .addItem('月次トリガーの設定（初回のみ）', 'setupMonthlyTrigger')
    .addToUi();
}

/**
 * 毎月2日 7時(JST)に setupReports を自動実行する time-based トリガーを1回だけ登録する。
 * Node 側の月次同期（タスクスケジューラ、通常1日）が書き込んだ後に
 * 集計シートを自動再構築するための「最後の1マイル」。
 * 既存の同名トリガーは重複登録を避けるため作り直す。setupReports は冪等。
 */
function setupMonthlyTrigger() {
  const fn = 'setupReports';
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === fn) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger(fn)
    .timeBased()
    .onMonthDay(2)
    .atHour(7)
    .create();
  try {
    SpreadsheetApp.getActive().toast(
      '月次トリガーを設定しました（毎月2日 7時に「レポートの再構築」を自動実行）',
      'Fire Trajectory', 5
    );
  } catch (e) {
    console.log('月次トリガー設定完了（toast 失敗: ' + e + '）');
  }
}

// ===== 表示色（編集可能セルとデフォルト値の視覚区別） =====
const COLOR_EDITABLE = '#fff3cd';   // ユーザーが編集してよいセル（薄い黄）
const COLOR_FORMULA  = '#e1f5fe';   // 数式が入っているセル（自動計算、編集非推奨、薄い水色）
const COLOR_DEFAULT  = '#f3f3f3';   // 参照のみのデフォルト値・ヘッダー（薄い灰）
const COLOR_HEADER   = '#e6f7ff';   // テーブルヘッダー（薄い青）
const COLOR_SECTION  = '#bcdcff';   // セクション見出し（共通/本人/配偶者の区切り、やや濃い青）

// ===== 数値フォーマット =====
const FMT_YEN  = '¥#,##0';        // 円（小数点なし、3桁区切り）
const FMT_INT  = '0';             // 整数（年齢など）
const FMT_DATE = 'yyyy/MM/dd';
const FMT_YM   = 'yyyy/MM';
const FMT_PCT  = '0.00%';

/**
 * 「設定」シート上の項目について、現在値を取得するヘルパー。
 * existingValues に値があればそれ、なければ items のデフォルトを返す。
 */
function getCurrentValue_(items, existingValues, key) {
  if (existingValues.hasOwnProperty(key)) return existingValues[key];
  for (let i = 0; i < items.length; i++) {
    if (items[i][0] === key) return items[i][1];
  }
  return null;
}

/**
 * シミュレーション環境のセットアップ。
 * 1. 「設定」シートの作成・初期値入力（既存値は保持）
 * 2. 「シミュレーション」シートの作成・数式モデル構築
 */
function setupSimulation() {
  console.log("【開始】setupSimulation");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const Q = quoteSheetName_;

  // --- 1. 「設定」シートの作成・既存値の保存 ---
  let dashSheet = ss.getSheetByName(SHEET.DASHBOARD);
  let existingValues = {};

  if (!dashSheet) {
    console.log("「" + SHEET.DASHBOARD + "」シートを新規作成");
    dashSheet = ss.insertSheet(SHEET.DASHBOARD);
  } else {
    console.log("既存「" + SHEET.DASHBOARD + "」の設定値を読み込み");
    const lastRow = dashSheet.getLastRow();
    if (lastRow > 1) {
      const range = dashSheet.getRange(2, 1, lastRow - 1, 2);
      const values = range.getValues();
      values.forEach(row => {
        if (row[0] && row[1] !== "") {
          existingValues[row[0]] = row[1];
        }
      });
    }
    // 旧項目名 → 新項目名のマイグレーション（ユーザーがカスタムした値を失わせない）
    //   2026-05 退職金/年金開始年齢を本人/配偶者に分割した際の互換処理
    if (existingValues.hasOwnProperty('退職時一時金') &&
        !existingValues.hasOwnProperty('本人退職時一時金')) {
      existingValues['本人退職時一時金'] = existingValues['退職時一時金'];
      console.log("旧「退職時一時金」を「本人退職時一時金」に移行: " + existingValues['退職時一時金']);
    }
    if (existingValues.hasOwnProperty('年金開始年齢')) {
      if (!existingValues.hasOwnProperty('本人年金開始年齢')) {
        existingValues['本人年金開始年齢'] = existingValues['年金開始年齢'];
      }
      if (!existingValues.hasOwnProperty('配偶者年金開始年齢')) {
        existingValues['配偶者年金開始年齢'] = existingValues['年金開始年齢'];
      }
      console.log("旧「年金開始年齢」を本人/配偶者の年金開始年齢に移行: " + existingValues['年金開始年齢']);
    }
    // 2026-05 家計入金モデル化（旧キーはサイレントに破棄、新デフォルトで上書き）
    if (existingValues.hasOwnProperty('本人手取り月収')) {
      console.log("旧「本人手取り月収」を破棄（家計入金モデルに刷新、新「本人月収_家計入金」のデフォルトを使用）: 旧値=" + existingValues['本人手取り月収']);
    }
    if (existingValues.hasOwnProperty('配偶者年収_年額')) {
      console.log("旧「配偶者年収_年額」を破棄（家計入金モデルに刷新、新「配偶者月収_家計入金」のデフォルトを使用）: 旧値=" + existingValues['配偶者年収_年額']);
    }
    dashSheet.clear();
  }

  const headers = ['fire-trajectory 設定', '設定値', '説明・入力例', 'デフォルト値'];
  // 凡例（2行目に A:D 結合で表示）。色の意味をユーザーに明示する。
  const legendText =
    '凡例 ―  ■ 黄色(B列「設定値」)＝あなたが編集してよい  ／  ' +
    '■ 水色＝自動計算なので変更しない  ／  ' +
    '■ 灰色(D列「デフォルト値」)＝初期値の控え(参照用)。' +
    '編集するのは「設定値」(B列) だけにしてください。';

  // 「現在の資産」のデフォルト値: 「資産推移」シートが存在すれば最新の純資産（N列）を参照、
  // データが無ければ初期値 25,000,000 を使用。
  const assetsRef = Q(SHEET.ASSETS);
  const currentAssetFormula =
    '=IFERROR(IF(COUNTA(' + assetsRef + '!A:A)>1, INDEX(' + assetsRef + '!N:N, COUNTA(' + assetsRef + '!A:A)), 25000000), 25000000)';

  // レイアウト定義: セクション見出し { section } と 設定項目 { key, def, desc, fmt }
  // を上から順に並べる。実セル行は描画時に動的決定し、数式は行番号ではなく
  // 「項目名で MATCH 参照」(dashLookup_) するため、並び替え・見出し挿入をしても壊れない。
  // フォーマット種別: 'yen' | 'int' | 'date' | 'pct' | null
  // 前提値（ナラティブ層「資産運用計画」と整合）:
  //   生活費 月35万 / 本人月収_家計入金 30万 / 妻月収_家計入金 13万
  //   本人ボーナス_家計入金 90万/年 / 妻ボーナス 0 / 本人退職金 300万 / 配偶者退職金 0
  //   インフレ率 2%（日銀目標 / 直近CPI 2.7〜3.2%）
  const layout = [
    { section: '■ 共通設定（家計全体）' },
    { key: '現在の資産',                def: currentAssetFormula, desc: '「資産推移」最新の純資産を自動参照（水色＝自動計算。固定したい時だけ数値で上書き）', fmt: 'yen' },
    { key: '基本生活費_月額',           def: 350000,    desc: '住宅ローン・教育費を除く毎月の家計支出。例: 350000（取引履歴 直近12ヶ月実測 ≒ 36万）', fmt: 'yen' },
    { key: 'ローン月額',                def: 100000,    desc: '住宅ローン等の毎月返済額。例: 100000', fmt: 'yen' },
    { key: 'ローン完済予定日',          def: '2042/03/31', desc: 'この日まで「ローン月額」を支出に加算。例: 2042/03/31', fmt: 'date' },
    { key: '息子支援月額',              def: 50000,     desc: '教育費・養育費・仕送り等。例: 50000', fmt: 'yen' },
    { key: '息子支援終了日',            def: '2028/03/31', desc: 'この日まで「息子支援月額」を支出に加算。例: 2028/03/31', fmt: 'date' },
    { key: '退職後社会保険料_月額',     def: 50000,     desc: 'リタイア予定日以降に加算する国民健康保険・介護保険料の月額目安（就労時は手取り入金額に内包のため0扱い）。保険料通知後に実額へ更新。例: 50000', fmt: 'yen' },
    { key: '運用利回り_名目',           def: 0.05,      desc: '年率（名目）。例: 0.05 = 5%（目安 3〜6%）', fmt: 'pct' },
    { key: 'インフレ率',                def: 0.02,      desc: '年率。例: 0.02 = 2%（日銀目標2% / 直近CPI 2.7〜3.2%。0 は非現実的）', fmt: 'pct' },
    { key: 'FIRE射程_盤石閾値',         def: 30000000,  desc: '終了年齢時点の予想資産がこの額超で「◎◎◎ 盤石」。例: 30000000', fmt: 'yen' },
    { key: 'FIRE射程_余裕閾値',         def: 5000000,   desc: '同上で「◎ 余裕」。例: 5000000', fmt: 'yen' },
    { key: 'FIRE必要資産_目標年齢',     def: 100,       desc: 'この年齢まで資産が枯渇しなければFIRE可と判定（年金のみ・就労収入と退職金は当てにしない前提）。例: 100（保守的にするなら95等。範囲 1〜200）', fmt: 'int' },
    { key: 'FIRE必要資産_目標残額',     def: 0,         desc: '目標年齢の時点で残しておきたい資産。0=使い切り、相続等で残すなら金額。例: 0', fmt: 'yen' },
    { key: 'シミュレーション終了年齢',  def: 100,       desc: '本人が何歳になるまで月次試算するか。例: 100（範囲 1〜200）', fmt: 'int' },

    { section: '■ 本人（僕）の設定' },
    { key: '本人誕生日',                def: '1977/03/09', desc: '形式 YYYY/MM/DD。例: 1977/03/09', fmt: 'date' },
    { key: 'リタイア予定日',            def: '2037/03/31', desc: 'この日以降、本人の月収・ボーナス家計入金を停止。例: 2037/03/31', fmt: 'date' },
    { key: '本人月収_家計入金',         def: 300000,    desc: '本人が家計に入れる月額（手取り35万のうち30万、残5万は個人）。例: 300000', fmt: 'yen' },
    { key: '本人ボーナス_年額_家計入金', def: 900000,   desc: '本人ボーナスのうち家計入金 年額（月割で平準化）。例: 900000', fmt: 'yen' },
    { key: '本人退職時一時金',          def: 3000000,   desc: 'リタイア予定月に一度だけ加算。将来名目額で入力（内部でインフレ実質割戻し）。例: 3000000', fmt: 'yen' },
    { key: '本人年金_年額',             def: 1800000,   desc: '本人年金 年額。ねんきん定期便の将来名目額のままでOK（内部でインフレ実質割戻し）。例: 1800000 = 月15万', fmt: 'yen' },
    { key: '本人年金開始年齢',          def: 65,        desc: '例: 65（繰上 60〜64 / 標準 65 / 繰下 66〜75）', fmt: 'int' },

    { section: '■ 配偶者（妻）の設定' },
    { key: '配偶者誕生日',              def: '1976/06/27', desc: '形式 YYYY/MM/DD。例: 1976/06/27', fmt: 'date' },
    { key: '配偶者退職予定日',          def: '2041/06/30', desc: 'この日以降、配偶者の月収・ボーナス家計入金を停止。例: 2041/06/30', fmt: 'date' },
    { key: '配偶者月収_家計入金',       def: 130000,    desc: '配偶者が家計に入れる月額（手取り20万のうち13万）。例: 130000', fmt: 'yen' },
    { key: '配偶者ボーナス_年額_家計入金', def: 0,      desc: '配偶者ボーナスのうち家計入金 年額（無ければ 0）。例: 0', fmt: 'yen' },
    { key: '配偶者退職時一時金',        def: 0,         desc: '配偶者退職予定月に一度だけ加算（当てにせず 0、確定後更新）。将来名目額で入力（内部で実質割戻し）。例: 0', fmt: 'yen' },
    { key: '配偶者年金_年額',           def: 780000,    desc: '配偶者年金 年額。ねんきん定期便の将来名目額のままでOK（内部でインフレ実質割戻し）。例: 780000 = 月6.5万', fmt: 'yen' },
    { key: '配偶者年金開始年齢',        def: 65,        desc: '例: 65（本人と独立に設定可）', fmt: 'int' }
  ];

  // getCurrentValue_ / フォーマット適用用に「項目だけ」を取り出した配列
  const settingItems = layout
    .filter(function (e) { return e.key; })
    .map(function (e) { return [e.key, e.def, e.desc, e.fmt]; });

  // ===== 「設定」シートへの描画 =====
  // 1行目: ヘッダー / 2行目: 凡例(A:D結合) / 3行目以降: セクション見出し＋項目
  const grid = [];
  grid.push(headers);                   // row 1
  grid.push([legendText, '', '', '']);  // row 2（A:D 結合）

  const sectionRows = [];   // セクション見出しの行番号(1始まり)
  const itemRows = [];      // { row, fmt }

  layout.forEach(function (entry) {
    const rowNum = grid.length + 1;     // これから push する行の 1 始まり行番号
    if (entry.section) {
      grid.push([entry.section, '', '', '']);
      sectionRows.push(rowNum);
      return;
    }
    const currentVal = existingValues.hasOwnProperty(entry.key)
      ? existingValues[entry.key]
      : entry.def;
    grid.push([entry.key, currentVal, entry.desc, entry.def]);
    itemRows.push({ row: rowNum, fmt: entry.fmt || null });
  });

  // 旧レイアウトの結合セルが残っていると行ズレするため一旦すべて解除してから書き込む
  dashSheet.getRange(1, 1, dashSheet.getMaxRows(), dashSheet.getMaxColumns()).breakApart();
  dashSheet.getRange(1, 1, grid.length, 4).setValues(grid);

  dashSheet.setColumnWidth(1, 230);
  dashSheet.setColumnWidth(2, 170);
  dashSheet.setColumnWidth(3, 470);
  dashSheet.setColumnWidth(4, 150);
  dashSheet.setFrozenRows(1);

  // ヘッダー（1行目）
  dashSheet.getRange('A1:D1').setBackground(COLOR_HEADER).setFontWeight('bold');

  // 凡例（2行目）: A:D を結合し、色の意味を文章で明示
  dashSheet.getRange(2, 1, 1, 4).merge()
    .setBackground(COLOR_DEFAULT).setFontStyle('italic').setWrap(true)
    .setVerticalAlignment('middle');
  dashSheet.setRowHeight(2, 46);

  // セクション見出し: A:D 結合 + 太字 + セクション色
  sectionRows.forEach(function (rn) {
    dashSheet.getRange(rn, 1, 1, 4).merge()
      .setBackground(COLOR_SECTION).setFontWeight('bold');
  });

  // 項目行: B列を編集可否で色分け（黄=編集可 / 水色=数式・自動計算）、
  //         C列は折り返し、D列はデフォルト灰＋斜体。B/D に数値フォーマット適用。
  itemRows.forEach(function (it) {
    const bCell = dashSheet.getRange(it.row, 2);
    const dCell = dashSheet.getRange(it.row, 4);
    const isFormula = String(bCell.getFormula() || '').length > 0;
    bCell.setBackground(isFormula ? COLOR_FORMULA : COLOR_EDITABLE);
    dashSheet.getRange(it.row, 3).setWrap(true);
    dCell.setBackground(COLOR_DEFAULT).setFontStyle('italic');

    const f = (it.fmt === 'yen') ? FMT_YEN
            : (it.fmt === 'int') ? FMT_INT
            : (it.fmt === 'date') ? FMT_DATE
            : (it.fmt === 'pct') ? FMT_PCT
            : null;
    if (f) {
      bCell.setNumberFormat(f);
      dCell.setNumberFormat(f);
    }

    // 入力規則（誤入力で全試算が壊れるのを防ぐ）。数式セル（自動計算）は対象外。
    if (!isFormula) {
      let rule = null;
      if (it.fmt === 'pct') {
        rule = SpreadsheetApp.newDataValidation()
          .requireNumberBetween(-0.1, 1)
          .setHelpText('年率は 0〜1 の小数で入力（例: 0.05 = 5%）。「5」と入れると500%扱いになります。デフレ考慮で -0.1 まで可。')
          .setAllowInvalid(false).build();
      } else if (it.fmt === 'date') {
        rule = SpreadsheetApp.newDataValidation()
          .requireDate()
          .setHelpText('日付を入力（例: 2037/03/31）。文字列だと DATEDIF が壊れシミュレーション全体が崩れます。')
          .setAllowInvalid(false).build();
      } else if (it.fmt === 'int') {
        rule = SpreadsheetApp.newDataValidation()
          .requireNumberBetween(1, 200)
          .setHelpText('1〜200 の整数（年齢）を入力。')
          .setAllowInvalid(false).build();
      } else if (it.fmt === 'yen') {
        rule = SpreadsheetApp.newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setHelpText('0 以上の金額を半角数値で入力（¥ やカンマは不要）。')
          .setAllowInvalid(false).build();
      }
      if (rule) bCell.setDataValidation(rule);
    } else {
      bCell.setDataValidation(null); // 旧バージョンの規則が残っていれば解除
    }
  });

  // --- 2. 「シミュレーション」シート ---
  let simSheet = ss.getSheetByName(SHEET.SIMULATION);
  if (!simSheet) {
    simSheet = ss.insertSheet(SHEET.SIMULATION);
  }
  simSheet.clear();

  const simHeaders = ['年月', '本人年齢', '期首資産', '収入', '支出', '収支', '実質利回り(月)', '期末資産', 'FIRE必要資産(目標年齢まで)'];
  simSheet.getRange(1, 1, 1, simHeaders.length).setValues([simHeaders]).setBackground('#f3f3f3').setFontWeight('bold');

  const startDate = new Date();
  startDate.setDate(1);

  const userBdayVal = getCurrentValue_(settingItems, existingValues, '本人誕生日');
  let userBdayDate = new Date(userBdayVal);
  if (isNaN(userBdayDate.getTime())) {
    userBdayDate = new Date('1977/03/09');
  }

  let simEndAge = parseInt(String(getCurrentValue_(settingItems, existingValues, 'シミュレーション終了年齢')), 10);
  if (!Number.isFinite(simEndAge) || simEndAge <= 0 || simEndAge > 200) simEndAge = 100;

  // FIRE必要資産ライン（I列）は末尾の「目標年齢の月」から逆算する。
  // そのアンカー行が必ず存在するよう、行数は シミュレーション終了年齢 と
  // FIRE必要資産_目標年齢 の大きい方まで生成する。
  let fireTargetAge = parseInt(String(getCurrentValue_(settingItems, existingValues, 'FIRE必要資産_目標年齢')), 10);
  if (!Number.isFinite(fireTargetAge) || fireTargetAge <= 0 || fireTargetAge > 200) fireTargetAge = 100;
  const effEndAge = Math.max(simEndAge, fireTargetAge);

  const endYear = userBdayDate.getFullYear() + effEndAge;
  const endMonth = userBdayDate.getMonth();

  let initialRows = (endYear - startDate.getFullYear()) * 12 + (endMonth - startDate.getMonth()) + 1;
  if (isNaN(initialRows) || initialRows < 12) initialRows = 12;

  const rows = [];

  // 数式は「設定」シートの項目を行番号ではなく "項目名で MATCH" 参照する（dashLookup_）。
  // これにより設定シートの並び替え・セクション見出し挿入をしても数式が壊れない。
  const dashRef = Q(SHEET.DASHBOARD);
  const L = function (key) { return dashLookup_(dashRef, key); };
  const D = {
    UserBday:              L('本人誕生日'),
    SpouseBday:            L('配偶者誕生日'),
    CurrentAsset:          L('現在の資産'),
    RetireDate:            L('リタイア予定日'),
    GtSpouseRetire:        L('配偶者退職予定日'),
    GtLoanDate:            L('ローン完済予定日'),
    GtSonDate:             L('息子支援終了日'),
    BasicExpense:          L('基本生活費_月額'),
    LoanAmount:            L('ローン月額'),
    SonAmount:             L('息子支援月額'),
    PostRetireInsurance:   L('退職後社会保険料_月額'),
    UserMonthlyHH:         L('本人月収_家計入金'),
    UserBonusHH:           L('本人ボーナス_年額_家計入金'),
    SpouseMonthlyHH:       L('配偶者月収_家計入金'),
    SpouseBonusHH:         L('配偶者ボーナス_年額_家計入金'),
    UserRetireLump:        L('本人退職時一時金'),
    SpouseRetireLump:      L('配偶者退職時一時金'),
    UserPension:           L('本人年金_年額'),
    SpousePension:         L('配偶者年金_年額'),
    UserPensionStartAge:   L('本人年金開始年齢'),
    SpousePensionStartAge: L('配偶者年金開始年齢'),
    NominalYield:          L('運用利回り_名目'),
    Inflation:             L('インフレ率'),
    FireSafeThreshold:     L('FIRE射程_盤石閾値'),
    FireComfortThreshold:  L('FIRE射程_余裕閾値'),
    FireTargetAge:         L('FIRE必要資産_目標年齢'),
    FireTargetResidual:    L('FIRE必要資産_目標残額'),
    SimEndAge:             L('シミュレーション終了年齢')
  };

  for (let i = 0; i < initialRows; i++) {
    const targetDate = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const rowIdx = i + 2;

    const aColVal = `=DATE(${targetDate.getFullYear()}, ${targetDate.getMonth() + 1}, 1)`;
    const dateRef = `$A${rowIdx}`;

    const ageFormula = `=DATEDIF(${D.UserBday}, ${dateRef}, "Y")`;

    const openingBalance = (i === 0) ? `=${D.CurrentAsset}` : `=H${rowIdx - 1}`;

    // 月次収入は「月収_家計入金 + ボーナス_家計入金_年額/12」で平準化
    const incUser = `IF(${dateRef} <= ${D.RetireDate}, ${D.UserMonthlyHH} + ${D.UserBonusHH}/12, 0)`;
    const incSpouse = `IF(${dateRef} <= ${D.GtSpouseRetire}, ${D.SpouseMonthlyHH} + ${D.SpouseBonusHH}/12, 0)`;
    // 実質割戻し係数: 本シミュレーションは「今日の円（実質）」で計算する。
    // 年金・退職一時金は ねんきん定期便等の「将来名目額」で入力されるため、
    // 開始月までの経過年数ぶんインフレで割り戻して実質化する。
    // （給与・基本生活費はインフレ連動＝実質ほぼ一定と仮定し割戻さない）
    const realDeflator = `(1+${D.Inflation})^(${i}/12)`;
    // 年金は本人・配偶者で開始年齢を独立に設定可能（繰上/繰下に対応）
    const startUserPen = `EDATE(${D.UserBday}, 12*${D.UserPensionStartAge})`;
    const startSpousePen = `EDATE(${D.SpouseBday}, 12*${D.SpousePensionStartAge})`;
    const incUserPen = `IF(${dateRef} >= ${startUserPen}, (${D.UserPension}/12)/${realDeflator}, 0)`;
    const incSpousePen = `IF(${dateRef} >= ${startSpousePen}, (${D.SpousePension}/12)/${realDeflator}, 0)`;
    // 退職一時金: 本人はリタイア予定月、配偶者は配偶者退職予定月にそれぞれ加算（実質割戻し済み）
    const incUserLump = `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${D.RetireDate},"yyyyMM"), ${D.UserRetireLump}/${realDeflator}, 0)`;
    const incSpouseLump = `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${D.GtSpouseRetire},"yyyyMM"), ${D.SpouseRetireLump}/${realDeflator}, 0)`;

    const income = `=${incUser} + ${incSpouse} + ${incUserPen} + ${incSpousePen} + ${incUserLump} + ${incSpouseLump}`;

    const expBasic = `${D.BasicExpense}`;
    const expLoan = `IF(${dateRef} <= ${D.GtLoanDate}, ${D.LoanAmount}, 0)`;
    const expSon = `IF(${dateRef} <= ${D.GtSonDate}, ${D.SonAmount}, 0)`;
    // リタイア予定日以降は就労時の社会保険控除が消えるため、国保・介護保険料を加算。
    const expInsurance = `IF(${dateRef} >= ${D.RetireDate}, ${D.PostRetireInsurance}, 0)`;

    const expense = `=${expBasic} + ${expLoan} + ${expSon} + ${expInsurance}`;

    const monthlyRealYield = `=((1+${D.NominalYield})/(1+${D.Inflation}))^(1/12) - 1`;

    // FIRE必要資産ライン（I列）:
    //   「この月で就労収入が途絶えても、年金だけで FIRE必要資産_目標年齢 まで
    //    資産が尽きない最低期首資産」を末尾から逆算する。
    //   退職一時金は『働き続けないと得られない』ため当てにしない（年金のみ算入）。
    //   逆算: I(r) = I(r+1)/(1+実質利回り) - 年金(r) + 支出(r)
    //         末尾（目標年齢の最終月）の次は I の代わりに 目標残額 を使う。
    //   予想資産(H) がこの線(I) を上回った最初の月 = FIRE 可能時期。
    const niFire = `(${incUserPen} + ${incSpousePen})`;
    // 最終行は下の行を参照しない（行トリム後は枠外参照になり #REF! になるため）。
    // 最終行は effEndAge（>= 目標年齢）なので、目標年齢ならここが終端、超過なら IF で "" になる。
    const isLastRow = (i === initialRows - 1);
    const nextReq = isLastRow
      ? `${D.FireTargetResidual}`
      : `IF(OR(NOT(ISNUMBER(B${rowIdx + 1})), B${rowIdx + 1} > ${D.FireTargetAge}), ${D.FireTargetResidual}, I${rowIdx + 1})`;
    // 支出 E列は名目固定なので、実質モデルに合わせ realDeflator で割り戻して計上
    // （年金 niFire は実質割戻し済み。実質−実質で単位を揃える）。
    const fireNeed = `=IF(B${rowIdx} > ${D.FireTargetAge}, "", (${nextReq})/(1+G${rowIdx}) - ${niFire} + (E${rowIdx}/${realDeflator}))`;

    rows.push([
      aColVal,
      ageFormula,
      openingBalance,
      income,
      expense,
      `=D${rowIdx}-E${rowIdx}`,
      monthlyRealYield,
      `=(C${rowIdx}+F${rowIdx})*(1+G${rowIdx})`,
      fireNeed
    ]);
  }

  simSheet.getRange(2, 1, rows.length, simHeaders.length).setValues(rows);
  simSheet.getRange(2, 1, rows.length, 1).setNumberFormat("yyyy/MM");

  const maxRows = simSheet.getMaxRows();
  const requiredRows = rows.length + 1;
  if (maxRows > requiredRows) {
    simSheet.deleteRows(requiredRows + 1, maxRows - requiredRows);
  } else if (maxRows < requiredRows) {
    simSheet.insertRowsAfter(maxRows, requiredRows - maxRows);
  }

  try {
    createTrajectoryChart(simSheet, userBdayDate);
  } catch (e) {
    console.warn("createTrajectoryChart failed (continuing without chart): " + e);
  }

  // 表示形式を再適用（再構築で消えた可能性があるため）
  try {
    applyFormatting();
  } catch (e) {
    console.warn("applyFormatting failed (continuing): " + e);
  }

  console.log("【完了】setupSimulation");
}

function createTrajectoryChart(sheet, userBday) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const existingCharts = sheet.getCharts();
  for (const c of existingCharts) {
    sheet.removeChart(c);
  }

  // x軸: 5歳刻みで「2027年 (50歳)」のようなカスタム目盛りを生成する。
  // 妻と本人は学年が同じなので本人年齢を併記対象とする（妻はほぼ同年）。
  let hAxisOption = { title: '年月' };
  try {
    if (userBday && !isNaN(userBday.getTime())) {
      const firstDate = sheet.getRange(2, 1).getValue();
      const lastDate = sheet.getRange(lastRow, 1).getValue();
      if (firstDate instanceof Date && lastDate instanceof Date) {
        const interval = 5;
        const firstAge = firstDate.getFullYear() - userBday.getFullYear();
        const lastAge = lastDate.getFullYear() - userBday.getFullYear() + 1;
        const startAge = Math.ceil(firstAge / interval) * interval;
        const ticks = [];
        for (let age = startAge; age <= lastAge; age += interval) {
          const tickDate = new Date(
            userBday.getFullYear() + age,
            userBday.getMonth(),
            userBday.getDate()
          );
          if (tickDate < firstDate || tickDate > lastDate) continue;
          ticks.push({ v: tickDate, f: tickDate.getFullYear() + '年 (' + age + '歳)' });
        }
        if (ticks.length > 0) {
          hAxisOption = { title: '年 / 本人年齢', ticks: ticks };
        }
      }
    }
  } catch (e) {
    console.warn('Custom hAxis ticks failed, falling back: ' + e);
  }

  // 期末資産(H)と FIRE必要資産(I) の2本を折れ線で重ね、交点＝FIRE可能時期を読み取れるようにする
  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sheet.getRange(1, 1, lastRow, 1))   // x: 年月
    .addRange(sheet.getRange(1, 8, lastRow, 1))   // 系列1: 期末資産（予想）
    .addRange(sheet.getRange(1, 9, lastRow, 1))   // 系列2: FIRE必要資産（目標年齢まで枯渇しない最低ライン）
    .setPosition(2, 11, 0, 0)
    .setOption('title', '資産推移と FIRE必要ライン（予想資産が必要ラインを上回った時がFIRE可能）')
    .setOption('hAxis', hAxisOption)
    .setOption('vAxis', { title: '資産額 (円)' })
    .setOption('legend', { position: 'bottom' })
    .setOption('width', 960)
    .setOption('height', 520)
    .build();

  sheet.insertChart(chart);
}

/**
 * 集計シート（月次収支・カテゴリ別支出・純資産推移・資産配分・FIRE射程）を構築する。
 * 取引履歴 / 資産推移 / シミュレーション を参照する数式ベースの集計シート。
 */
function setupReports() {
  console.log("【開始】setupReports");
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  setupReportCashFlow_(ss);
  setupReportSpending_(ss);
  setupReportNetWorth_(ss);
  setupReportAllocation_(ss);
  setupReportFireReadiness_(ss);

  try {
    applyFormatting();
  } catch (e) {
    console.warn("applyFormatting failed (continuing): " + e);
  }

  console.log("【完了】setupReports");
}

function setupReportCashFlow_(ss) {
  const Q = quoteSheetName_;
  let sheet = ss.getSheetByName(SHEET.REPORT_CASHFLOW);
  if (!sheet) sheet = ss.insertSheet(SHEET.REPORT_CASHFLOW);
  sheet.clear();

  sheet.getRange('A1').setValue(SHEET.REPORT_CASHFLOW + ': 月次収支').setFontWeight('bold');
  sheet.getRange('A2').setValue('「' + SHEET.TRANSACTIONS + '」から年月別に集計。収支差／収入／支出を3エリアに分けて表示');

  // QUERY Language は IF をサポートしないため、収支差・収入・支出を別エリアに出す
  // 取引履歴: B=日付 (YYYY/MM/DD), D=金額
  const txRef = Q(SHEET.TRANSACTIONS);
  const waitMsg = '「' + SHEET.TRANSACTIONS + '」のデータをお待ちください';

  sheet.getRange('A3').setValue('月別収支差').setFontWeight('bold');
  const formulaTotal =
    '=IFERROR(' +
    'QUERY({ARRAYFORMULA(LEFT(' + txRef + '!B2:B,7)),' + txRef + '!D2:D},' +
    '"select Col1, sum(Col2) where Col1 is not null and Col1 != \'\'' +
    ' group by Col1 order by Col1 desc' +
    ' label Col1 \'年月\', sum(Col2) \'収支\'", 0)' +
    ', "' + waitMsg + '")';
  sheet.getRange('A4').setFormula(formulaTotal);

  sheet.getRange('D3').setValue('月別収入').setFontWeight('bold');
  const formulaIncome =
    '=IFERROR(' +
    'QUERY({ARRAYFORMULA(LEFT(' + txRef + '!B2:B,7)),' + txRef + '!D2:D},' +
    '"select Col1, sum(Col2) where Col2 > 0 and Col1 is not null and Col1 != \'\'' +
    ' group by Col1 order by Col1 desc' +
    ' label Col1 \'年月\', sum(Col2) \'収入\'", 0)' +
    ', "' + waitMsg + '")';
  sheet.getRange('D4').setFormula(formulaIncome);

  sheet.getRange('G3').setValue('月別支出').setFontWeight('bold');
  const formulaExpense =
    '=IFERROR(' +
    'QUERY({ARRAYFORMULA(LEFT(' + txRef + '!B2:B,7)),' + txRef + '!D2:D},' +
    '"select Col1, sum(Col2) where Col2 < 0 and Col1 is not null and Col1 != \'\'' +
    ' group by Col1 order by Col1 desc' +
    ' label Col1 \'年月\', sum(Col2) \'支出\'", 0)' +
    ', "' + waitMsg + '")';
  sheet.getRange('G4').setFormula(formulaExpense);

  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 130);
  sheet.setColumnWidth(7, 100);
  sheet.setColumnWidth(8, 130);
}

function setupReportSpending_(ss) {
  const Q = quoteSheetName_;
  let sheet = ss.getSheetByName(SHEET.REPORT_SPENDING);
  if (!sheet) sheet = ss.insertSheet(SHEET.REPORT_SPENDING);
  sheet.clear();

  sheet.getRange('A1').setValue(SHEET.REPORT_SPENDING + ': カテゴリ別支出').setFontWeight('bold');
  sheet.getRange('A2').setValue('「' + SHEET.TRANSACTIONS + '」から「大項目/中項目」別の支出合計（金額が負の取引のみ）');

  // F列 = 大項目/中項目, D列 = 金額
  const txRef = Q(SHEET.TRANSACTIONS);
  const formula =
    '=IFERROR(' +
    'QUERY(' + txRef + '!D2:F,' +
    '"select F, sum(D)' +
    ' where D < 0 and F is not null and F != \'\'' +
    ' group by F' +
    ' order by sum(D) asc' +
    ' label F \'カテゴリ\', sum(D) \'合計\'", 0)' +
    ', "「' + SHEET.TRANSACTIONS + '」のデータをお待ちください")';

  sheet.getRange('A4').setFormula(formula);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 130);
}

function setupReportNetWorth_(ss) {
  const Q = quoteSheetName_;
  let sheet = ss.getSheetByName(SHEET.REPORT_NETWORTH);
  if (!sheet) sheet = ss.insertSheet(SHEET.REPORT_NETWORTH);
  sheet.clear();

  sheet.getRange('A1').setValue(SHEET.REPORT_NETWORTH + ': 純資産推移').setFontWeight('bold');
  sheet.getRange('A2').setValue('「' + SHEET.ASSETS + '」のミラー + 主要列の抜粋');

  // 資産推移: A=基準日, I=資産総額, M=負債総額, N=純資産
  const assetsRef = Q(SHEET.ASSETS);
  const formula =
    '=IFERROR(' +
    'QUERY(' + assetsRef + '!A:N,' +
    '"select A, I, M, N' +
    ' where A is not null' +
    ' order by A desc' +
    ' label A \'基準日\', I \'資産総額\', M \'負債総額\', N \'純資産\'", 1)' +
    ', "「' + SHEET.ASSETS + '」のデータをお待ちください")';

  sheet.getRange('A4').setFormula(formula);
  sheet.setColumnWidth(1, 130);
  sheet.setColumnWidths(2, 3, 150);
}

function setupReportAllocation_(ss) {
  const Q = quoteSheetName_;
  let sheet = ss.getSheetByName(SHEET.REPORT_ALLOCATION);
  if (!sheet) sheet = ss.insertSheet(SHEET.REPORT_ALLOCATION);
  sheet.clear();

  sheet.getRange('A1').setValue(SHEET.REPORT_ALLOCATION + ': 最新の資産配分').setFontWeight('bold');
  sheet.getRange('A2').setValue('「' + SHEET.ASSETS + '」最新行の各カテゴリ');

  sheet.getRange('A4:B4').setValues([['項目', '金額']]).setFontWeight('bold').setBackground('#e6f7ff');

  // 表示ラベル（日本語）と「資産推移」シート上の列文字
  const items = [
    ['預金・現金', 'B'],
    ['株式（現物）', 'C'],
    ['株式（未上場）', 'D'],
    ['投資信託', 'E'],
    ['年金', 'F'],
    ['ポイント', 'G'],
    ['その他資産', 'H'],
    ['資産総額', 'I'],
    ['クレジット未払', 'J'],
    ['住宅ローン', 'K'],
    ['その他負債', 'L'],
    ['負債総額', 'M'],
    ['純資産', 'N']
  ];

  const assetsRef = Q(SHEET.ASSETS);
  let r = 5;
  items.forEach(function (entry) {
    const label = entry[0];
    const col = entry[1];
    sheet.getRange('A' + r).setValue(label);
    sheet.getRange('B' + r).setFormula(
      '=IFERROR(IF(COUNTA(' + assetsRef + '!A:A)>1, INDEX(' + assetsRef + '!' + col + ':' + col + ', COUNTA(' + assetsRef + '!A:A)), 0), 0)'
    );
    r++;
  });

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 150);
}

function setupReportFireReadiness_(ss) {
  const Q = quoteSheetName_;
  let sheet = ss.getSheetByName(SHEET.REPORT_FIRE);
  if (!sheet) sheet = ss.insertSheet(SHEET.REPORT_FIRE);
  sheet.clear();

  sheet.getRange('A1').setValue(SHEET.REPORT_FIRE + ': FIRE射程').setFontWeight('bold');
  sheet.getRange('A2').setValue('「' + SHEET.SIMULATION + '」と「' + SHEET.ASSETS + '」の最新値から主要指標を算出');

  sheet.getRange('A4:B4').setValues([['項目', '値']]).setFontWeight('bold').setBackground('#e6f7ff');

  const assetsRef = Q(SHEET.ASSETS);
  const simRef = Q(SHEET.SIMULATION);
  const dashRef = Q(SHEET.DASHBOARD);
  const simNoData = '"「' + SHEET.SIMULATION + '」データなし"';

  // 各しきい値・年齢を「設定」シートから "項目名で MATCH" 参照（dashLookup_、行番号非依存）
  const refSimEndAge            = dashLookup_(dashRef, 'シミュレーション終了年齢');
  const refUserPensionStartAge  = dashLookup_(dashRef, '本人年金開始年齢');
  const refFireSafe             = dashLookup_(dashRef, 'FIRE射程_盤石閾値');
  const refFireComfort          = dashLookup_(dashRef, 'FIRE射程_余裕閾値');

  // スナップショット日 (資産推移 最新)
  sheet.getRange('A5').setValue('スナップショット日');
  sheet.getRange('B5').setFormula(
    '=IFERROR(IF(COUNTA(' + assetsRef + '!A:A)>1, INDEX(' + assetsRef + '!A:A, COUNTA(' + assetsRef + '!A:A)), ""), "")'
  );

  // 現在純資産
  sheet.getRange('A6').setValue('現在純資産（' + SHEET.DASHBOARD + ': 現在の資産）');
  sheet.getRange('B6').setFormula('=' + dashLookup_(dashRef, '現在の資産'));

  // シミュレーション 最終行（設定の「シミュレーション終了年齢」時点）の期末資産
  sheet.getRange('A7').setFormula('=' + refSimEndAge + '&"歳時点予想資産"');
  sheet.getRange('B7').setFormula(
    '=IFERROR(INDEX(' + simRef + '!H:H, COUNTA(' + simRef + '!A:A)), ' + simNoData + ')'
  );

  // 本人年金開始年齢時点（Simulation の B 列 = 本人年齢で MATCH）の期末資産
  sheet.getRange('A8').setFormula('="本人 "&' + refUserPensionStartAge + '&"歳時点予想資産"');
  sheet.getRange('B8').setFormula(
    '=IFERROR(INDEX(' + simRef + '!H:H, MATCH(' + refUserPensionStartAge + ', ' + simRef + '!B:B, 0)), ' + simNoData + ')'
  );

  // 資産が0以下になる最初の月（資産枯渇月）
  sheet.getRange('A9').setValue('資産枯渇月（あれば）');
  sheet.getRange('B9').setFormula(
    '=IFERROR(TEXT(INDEX(' + simRef + '!A:A, MATCH(TRUE, ARRAYFORMULA(' + simRef + '!H2:H<=0), 0)+1), "yyyy/MM"), "枯渇しません")'
  );

  // 余裕度フラグ：シミュレーション終了年時点の資産が
  //  > FIRE射程_盤石閾値    → 盤石(◎◎◎)
  //  > FIRE射程_余裕閾値    → 余裕(◎)
  //  > 0                    → ギリギリ(△)
  //  <= 0                   → 枯渇(✕)
  sheet.getRange('A10').setValue('余裕度判定');
  sheet.getRange('B10').setFormula(
    '=IFERROR(IF(B7>' + refFireSafe + ', "◎◎◎ 盤石",' +
    ' IF(B7>' + refFireComfort + ', "◎ 余裕",' +
    ' IF(B7>0, "△ ギリギリ", "✕ 枯渇"))), ' + simNoData + ')'
  );

  // FIRE可能時期: 予想資産(H) が FIRE必要資産ライン(I) を初めて上回る月。
  // I が数値の行のみ比較（目標年齢超の "" 行を除外）。到達済みなら最初の月＝今。
  const refFireTargetAge = dashLookup_(dashRef, 'FIRE必要資産_目標年齢');
  const fireMatch =
    'MATCH(TRUE, ARRAYFORMULA(IF(ISNUMBER(' + simRef + '!I2:I), ' +
    simRef + '!H2:H >= ' + simRef + '!I2:I, FALSE)), 0)';

  sheet.getRange('A11').setFormula('="FIRE可能時期（"&' + refFireTargetAge + '&"歳まで枯渇しない前提）"');
  sheet.getRange('B11').setFormula(
    '=IFERROR(TEXT(INDEX(' + simRef + '!A:A, ' + fireMatch + '+1), "yyyy/MM"), "期間内に到達せず")'
  );

  sheet.getRange('A12').setValue('FIRE可能時の本人年齢');
  sheet.getRange('B12').setFormula(
    '=IFERROR(INDEX(' + simRef + '!B:B, ' + fireMatch + '+1), ' + simNoData + ')'
  );

  // --- 逆算アクション指標（「何をどれだけ変えれば早まるか」を数値化）---

  // 現在の月次収支（実質, 収入−支出。プラス＝毎月この額を貯蓄に回せている）
  sheet.getRange('A13').setValue('現在の月次収支（実質, 収入−支出）');
  sheet.getRange('B13').setFormula(
    '=IFERROR(INDEX(' + simRef + '!F:F, 2), ' + simNoData + ')'
  );

  // FIRE可能までの目安年数（今＝0年。到達しなければメッセージ）
  sheet.getRange('A14').setValue('FIRE可能までの目安年数');
  sheet.getRange('B14').setFormula(
    '=IFERROR((' + fireMatch + '-1)/12, "期間内に到達せず")'
  );

  // FIRE を約1年前倒しするのに必要な「追加の月次貯蓄」目安（概算）。
  // 1年手前の月における不足額 = FIRE必要資産(I) − 予想資産(H) を、
  // 今からその月までの月数で割った近似。MAX(0,…) で負を丸める。
  sheet.getRange('A15').setValue('1年前倒しに必要な月次追加貯蓄（概算）');
  sheet.getRange('B15').setFormula(
    '=IFERROR(IF((' + fireMatch + ')<=13, "既に約1年以内（前倒し不要）",' +
    ' MAX(0, (INDEX(' + simRef + '!I2:I, (' + fireMatch + ')-12)' +
    ' - INDEX(' + simRef + '!H2:H, (' + fireMatch + ')-12)) / ((' + fireMatch + ')-13))),' +
    ' "期間内に到達せず")'
  );

  sheet.getRange('A16').setValue('※ 上記は概算。利回り/インフレ/生活費を変えた精密比較は設定値を変えて再構築');
  sheet.getRange('A16').setFontStyle('italic');

  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidth(2, 200);
}

/**
 * 全シートに表示形式（数値フォーマット・色分け）を適用する。
 * 各シートが存在すれば適用、無ければスキップ。
 * メニュー「表示形式の適用」から手動で実行できるほか、
 * setupSimulation / setupReports の末尾でも自動的に呼ばれる。
 */
function applyFormatting() {
  console.log("【開始】applyFormatting");
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  applyFormattingDashboard_(ss);
  applyFormattingManualAssets_(ss);
  applyFormattingTransactions_(ss);
  applyFormattingAssets_(ss);
  applyFormattingSimulation_(ss);
  applyFormattingReports_(ss);

  console.log("【完了】applyFormatting");
}

function applyFormattingDashboard_(ss) {
  const sheet = ss.getSheetByName(SHEET.DASHBOARD);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return;

  // ヘッダー（1行目）。2行目は凡例（A:D 結合済み）なので触らない。
  sheet.getRange('A1:D1').setBackground(COLOR_HEADER).setFontWeight('bold');

  // 3行目以降を走査。B も D も空の行はセクション見出し（setupSimulation で着色済み）
  // なのでスキップ。項目行のみ B を編集可否で色分け、D を灰＋斜体にする。
  for (let r = 3; r <= lastRow; r++) {
    const bCell = sheet.getRange(r, 2);
    const dCell = sheet.getRange(r, 4);
    const bVal = bCell.getValue();
    const dVal = dCell.getValue();
    const bEmpty = (bVal === '' || bVal === null);
    const dEmpty = (dVal === '' || dVal === null);
    if (bEmpty && dEmpty) continue; // セクション見出し行
    const isFormula = String(bCell.getFormula() || '').length > 0;
    bCell.setBackground(isFormula ? COLOR_FORMULA : COLOR_EDITABLE);
    dCell.setBackground(COLOR_DEFAULT).setFontStyle('italic');
  }
}

function applyFormattingManualAssets_(ss) {
  const sheet = ss.getSheetByName(SHEET.MANUAL_ASSETS);
  if (!sheet) return;

  // ヘッダー
  sheet.getRange('A1:C1').setBackground(COLOR_HEADER).setFontWeight('bold');

  // 入力対象ラベルが未投入なら雛形を seed（Node 側はラベル名で読むので安全）。
  // 既にユーザーが入力していれば（getLastRow>=2）触らない。
  if (sheet.getLastRow() < 2) {
    sheet.getRange('A2:A3').setValues([['未上場株式'], ['備考']]);
  }

  const lastRow = Math.max(sheet.getLastRow(), 2);

  // 編集可能セル：B 列（値）と C 列（備考）に黄色背景
  const dataRows = lastRow - 1;
  if (dataRows > 0) {
    sheet.getRange(2, 2, dataRows, 2).setBackground(COLOR_EDITABLE);
    sheet.getRange(2, 2, dataRows, 1).setNumberFormat(FMT_YEN);
  }

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 280);

  // 「未上場株式（インテグレ等）をシートに入れるべきか」を E:H に明示。
  // Node の loadManualAssets は A2:C しか読まないため E 以降は安全。
  sheet.getRange('E1:H1').merge()
    .setValue('■ 未上場株式（インテグレ等）の入れ方')
    .setFontWeight('bold').setBackground(COLOR_HEADER);
  const guide =
    '未上場株式は Money Forward のポートフォリオ自動取得（/bs/portfolio）には含まれません。\n' +
    '本ツールは「資産総額 ＝ MF取得合計 ＋ この『未上場株式』の値」として合算します。\n\n' +
    '原則：ここ（「未上場株式」行の B列「値」）に評価額を入力してください。\n' +
    'MF に登録していても、スクレイプ対象の資産総額には反映されないためです。\n\n' +
    '⚠ 例外（二重計上注意）：MF 側でも未上場株式が「資産総額」に含まれて表示\n' +
    'されている場合は、ここに入れると二重計上になります → その場合は空欄(0)に。\n\n' +
    '確認：MF の /bs/portfolio の「資産総額」にインテグレ評価額が入っているか。\n' +
    ' ・入っていない（連携外/未集計）→ ここに金額を入力（推奨）\n' +
    ' ・入っている（MFが資産総額に算入済み）→ ここは空欄(0)';
  sheet.getRange('E2:H12').merge()
    .setValue(guide)
    .setWrap(true).setVerticalAlignment('top').setBackground('#fffdf0');
  sheet.getRange('A1').setNote(
    '未上場株式（インテグレ等）の入れ方は右側 E 列の説明を参照。' +
    '原則ここに評価額を入力（MF自動取得には含まれないため）。' +
    'MFの資産総額に既に含まれている場合のみ空欄(0)。'
  );
  for (let c = 5; c <= 8; c++) sheet.setColumnWidth(c, 220);
}

function applyFormattingTransactions_(ss) {
  const sheet = ss.getSheetByName(SHEET.TRANSACTIONS);
  if (!sheet) return;

  // ヘッダー
  sheet.getRange('A1:G1').setBackground(COLOR_HEADER).setFontWeight('bold');

  // 金額列 D を ¥#,##0
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 4, lastRow - 1, 1).setNumberFormat(FMT_YEN);
  }

  sheet.setColumnWidth(1, 280);   // ID
  sheet.setColumnWidth(2, 110);   // 日付
  sheet.setColumnWidth(3, 280);   // 内容
  sheet.setColumnWidth(4, 130);   // 金額
  sheet.setColumnWidth(5, 220);   // 保有金融機関
  sheet.setColumnWidth(6, 220);   // 大項目/中項目
  sheet.setColumnWidth(7, 200);   // 取得日時
}

function applyFormattingAssets_(ss) {
  const sheet = ss.getSheetByName(SHEET.ASSETS);
  if (!sheet) return;

  // ヘッダー（A〜O = 15列）
  sheet.getRange(1, 1, 1, 15).setBackground(COLOR_HEADER).setFontWeight('bold');

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const dataRows = lastRow - 1;
    // A 列 = 基準日
    sheet.getRange(2, 1, dataRows, 1).setNumberFormat(FMT_DATE);
    // B〜N 列 = 円
    sheet.getRange(2, 2, dataRows, 13).setNumberFormat(FMT_YEN);
  }

  sheet.setColumnWidth(1, 110);
  for (let c = 2; c <= 15; c++) sheet.setColumnWidth(c, 130);
}

function applyFormattingSimulation_(ss) {
  const sheet = ss.getSheetByName(SHEET.SIMULATION);
  if (!sheet) return;

  sheet.getRange('A1:I1').setBackground(COLOR_DEFAULT).setFontWeight('bold');

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const dataRows = lastRow - 1;
    // A 年月
    sheet.getRange(2, 1, dataRows, 1).setNumberFormat(FMT_YM);
    // B 本人年齢
    sheet.getRange(2, 2, dataRows, 1).setNumberFormat(FMT_INT);
    // C/D/E/F 円
    sheet.getRange(2, 3, dataRows, 4).setNumberFormat(FMT_YEN);
    // H 期末資産 / I FIRE必要資産 円
    sheet.getRange(2, 8, dataRows, 2).setNumberFormat(FMT_YEN);
    // G 月次実質利回り
    sheet.getRange(2, 7, dataRows, 1).setNumberFormat('0.000%');
  }

  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 90);
  for (let c = 3; c <= 8; c++) sheet.setColumnWidth(c, 130);
  sheet.setColumnWidth(9, 180);
}

function applyFormattingReports_(ss) {
  // 月次収支：A,D,G が 年月文字列、B,E,H が ¥
  const cf = ss.getSheetByName(SHEET.REPORT_CASHFLOW);
  if (cf) {
    const last = cf.getLastRow();
    if (last >= 5) {
      const rows = last - 4;
      cf.getRange(5, 2, rows, 1).setNumberFormat(FMT_YEN);
      cf.getRange(5, 5, rows, 1).setNumberFormat(FMT_YEN);
      cf.getRange(5, 8, rows, 1).setNumberFormat(FMT_YEN);
    }
  }

  // カテゴリ別支出：B 列が ¥
  const sp = ss.getSheetByName(SHEET.REPORT_SPENDING);
  if (sp) {
    const last = sp.getLastRow();
    if (last >= 5) {
      sp.getRange(5, 2, last - 4, 1).setNumberFormat(FMT_YEN);
    }
  }

  // 純資産推移：A=日付、B/C/D=¥
  const nw = ss.getSheetByName(SHEET.REPORT_NETWORTH);
  if (nw) {
    const last = nw.getLastRow();
    if (last >= 5) {
      const rows = last - 4;
      nw.getRange(5, 1, rows, 1).setNumberFormat(FMT_DATE);
      nw.getRange(5, 2, rows, 3).setNumberFormat(FMT_YEN);
    }
  }

  // 資産配分：B 列が ¥
  const al = ss.getSheetByName(SHEET.REPORT_ALLOCATION);
  if (al) {
    const last = al.getLastRow();
    if (last >= 5) {
      al.getRange(5, 2, last - 4, 1).setNumberFormat(FMT_YEN);
    }
  }

  // FIRE射程：B5 日付、B6/B7/B8 円、B12 年齢、B13/B15 円、B14 年数
  const fr = ss.getSheetByName(SHEET.REPORT_FIRE);
  if (fr) {
    fr.getRange('B5').setNumberFormat(FMT_DATE);
    fr.getRange('B6:B8').setNumberFormat(FMT_YEN);
    fr.getRange('B12').setNumberFormat(FMT_INT);
    fr.getRange('B13').setNumberFormat(FMT_YEN);
    fr.getRange('B14').setNumberFormat('0.0"年"');
    fr.getRange('B15').setNumberFormat(FMT_YEN);
  }
}
