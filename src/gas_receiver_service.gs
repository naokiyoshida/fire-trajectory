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

/**
 * スプレッドシート起動時にカスタムメニューを追加する
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Fire Trajectory')
    .addItem('シミュレーションの再構築', 'setupSimulation')
    .addItem('レポートの再構築', 'setupReports')
    .addItem('表示形式の適用', 'applyFormatting')
    .addToUi();
}

// ===== 表示色（編集可能セルとデフォルト値の視覚区別） =====
const COLOR_EDITABLE = '#fff3cd';   // ユーザーが編集してよいセル（薄い黄）
const COLOR_DEFAULT  = '#f3f3f3';   // 参照のみのデフォルト値・ヘッダー（薄い灰）
const COLOR_HEADER   = '#e6f7ff';   // テーブルヘッダー（薄い青）

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
    dashSheet.clear();
  }

  const headers = ['fire-trajectory: 設定', '設定値', '説明', 'デフォルト値'];

  // 「現在の資産」のデフォルト値: 「資産推移」シートが存在すれば最新の純資産（N列）を参照、
  // データが無ければ初期値 25,000,000 を使用。
  const assetsRef = Q(SHEET.ASSETS);
  const currentAssetFormula =
    '=IFERROR(IF(COUNTA(' + assetsRef + '!A:A)>1, INDEX(' + assetsRef + '!N:N, COUNTA(' + assetsRef + '!A:A)), 25000000), 25000000)';

  // [項目名, デフォルト値, 説明, フォーマット種別]
  // フォーマット種別: 'yen' | 'int' | 'date' | 'pct' | null
  // ナラティブ層（別 Claude プロジェクト「資産運用計画」）に合わせた前提値:
  //   生活費 月35万 / 配偶者収入 月20万 / 本人退職金 300万 / 配偶者退職金 0 (当てにしない) / インフレ率 0
  const items = [
    ['本人誕生日',                '1977/03/09',         'YYYY/MM/DD',                                                'date'],
    ['配偶者誕生日',              '1976/06/27',         'YYYY/MM/DD',                                                'date'],
    ['現在の資産',                currentAssetFormula,  '「資産推移」最新の純資産を自動参照（B列に手動値があれば優先）', 'yen'],
    ['リタイア予定日',            '2037/03/31',         'この日以降、本人収入停止',                                  'date'],
    ['基本生活費_月額',           350000,               'ベースとなる生活費 (ナラティブ層: 月35万)',                 'yen'],
    ['運用利回り_名目',           0.05,                 '年率 (例: 5% と入力 = 0.05)',                              'pct'],
    ['インフレ率',                0,                    '年率 (ナラティブ層: 考慮しない=0)',                         'pct'],
    ['ローン完済予定日',          '2042/03/31',         '住宅ローン等の終了日',                                      'date'],
    ['ローン月額',                100000,               'ローン返済額',                                              'yen'],
    ['本人年金_年額',             1800000,              '本人年金 年額 (ナラティブ層: 月15万)',                      'yen'],
    ['配偶者年金_年額',           780000,               '配偶者年金 年額 (ナラティブ層: 月6.5万)',                   'yen'],
    ['息子支援終了日',            '2028/03/31',         '教育費・養育費の終了',                                      'date'],
    ['息子支援月額',              50000,                '支援終了までかかる費用',                                    'yen'],
    ['配偶者年収_年額',           2400000,              '配偶者の手取り年収 (ナラティブ層: 月20万 × 12)',            'yen'],
    ['配偶者退職予定日',          '2041/06/30',         '配偶者の収入停止日',                                        'date'],
    ['本人退職時一時金',          3000000,              '本人リタイア予定日に加算 (ナラティブ層: 300万)',            'yen'],
    ['配偶者退職時一時金',        0,                    '配偶者退職予定日に加算 (現状当てにせず 0、確定したら更新)',  'yen'],
    ['本人手取り月収',            500000,               '本人の月次収入',                                            'yen'],
    // --- 想定・閾値（変更しうるパラメータ） ---
    ['本人年金開始年齢',          65,                   '本人の年金受給開始年齢（繰上 60〜64 / 標準 65 / 繰下 66〜75）', 'int'],
    ['配偶者年金開始年齢',        65,                   '配偶者の年金受給開始年齢（同上、本人と独立に設定可）',        'int'],
    ['FIRE射程_盤石閾値',         30000000,             'シミュレーション終了年齢時点の予想資産がこの額超で「◎◎◎ 盤石」', 'yen'],
    ['FIRE射程_余裕閾値',         5000000,              '同上で「◎ 余裕」',                                         'yen'],
    ['シミュレーション終了年齢',  100,                  '何歳までを月次シミュレーション対象とするか',                 'int']
  ];

  const dashboardData = [headers];
  const formatByRow = []; // 1始まりの行番号 → フォーマット種別

  items.forEach(item => {
    const key = item[0];
    const defaultVal = item[1];
    const desc = item[2];
    const fmt = item[3] || null;

    const currentVal = existingValues.hasOwnProperty(key) ? existingValues[key] : defaultVal;

    dashboardData.push([key, currentVal, desc, defaultVal]);
    formatByRow.push(fmt);
  });

  dashSheet.getRange(1, 1, dashboardData.length, 4).setValues(dashboardData);
  dashSheet.setColumnWidth(1, 200);
  dashSheet.setColumnWidth(2, 200);
  dashSheet.setColumnWidth(3, 320);
  dashSheet.setColumnWidth(4, 200);

  // ヘッダー
  dashSheet.getRange('A1:D1').setBackground(COLOR_HEADER).setFontWeight('bold');

  // 編集可能セル（B列）に黄色、デフォルト値（D列）に灰色＋斜体
  const dataRows = dashboardData.length - 1;
  if (dataRows > 0) {
    dashSheet.getRange(2, 2, dataRows, 1).setBackground(COLOR_EDITABLE);
    dashSheet.getRange(2, 4, dataRows, 1).setBackground(COLOR_DEFAULT).setFontStyle('italic');
  }

  // 行ごとに B 列・D 列のフォーマット適用
  for (let i = 0; i < formatByRow.length; i++) {
    const rowNum = i + 2;
    const fmt = formatByRow[i];
    const f = (fmt === 'yen') ? FMT_YEN
            : (fmt === 'int') ? FMT_INT
            : (fmt === 'date') ? FMT_DATE
            : (fmt === 'pct') ? FMT_PCT
            : null;
    if (f) {
      dashSheet.getRange(rowNum, 2).setNumberFormat(f);
      dashSheet.getRange(rowNum, 4).setNumberFormat(f);
    }
  }

  // --- 2. 「シミュレーション」シート ---
  let simSheet = ss.getSheetByName(SHEET.SIMULATION);
  if (!simSheet) {
    simSheet = ss.insertSheet(SHEET.SIMULATION);
  }
  simSheet.clear();

  const simHeaders = ['年月', '本人年齢', '期首資産', '収入', '支出', '収支', '実質利回り(月)', '期末資産'];
  simSheet.getRange(1, 1, 1, simHeaders.length).setValues([simHeaders]).setBackground('#f3f3f3').setFontWeight('bold');

  const startDate = new Date();
  startDate.setDate(1);

  const userBdayVal = getCurrentValue_(items, existingValues, '本人誕生日');
  let userBdayDate = new Date(userBdayVal);
  if (isNaN(userBdayDate.getTime())) {
    userBdayDate = new Date('1977/03/09');
  }

  let simEndAge = parseInt(String(getCurrentValue_(items, existingValues, 'シミュレーション終了年齢')), 10);
  if (!Number.isFinite(simEndAge) || simEndAge <= 0 || simEndAge > 200) simEndAge = 100;

  const endYear = userBdayDate.getFullYear() + simEndAge;
  const endMonth = userBdayDate.getMonth();

  let initialRows = (endYear - startDate.getFullYear()) * 12 + (endMonth - startDate.getMonth()) + 1;
  if (isNaN(initialRows) || initialRows < 12) initialRows = 12;

  const rows = [];

  // 「設定」シートの行番号は items 配列と同期している。items に項目を追加した場合、
  // ここの $B$NN を必ず追従させること（B2 = items[0]、以降+1ずつ）。
  const dashRef = Q(SHEET.DASHBOARD);
  const D = {
    UserBday:              dashRef + '!$B$2',   // 本人誕生日
    SpouseBday:            dashRef + '!$B$3',   // 配偶者誕生日
    CurrentAsset:          dashRef + '!$B$4',   // 現在の資産
    RetireDate:            dashRef + '!$B$5',   // リタイア予定日（本人）
    BasicExpense:          dashRef + '!$B$6',   // 基本生活費_月額
    NominalYield:          dashRef + '!$B$7',   // 運用利回り_名目
    Inflation:             dashRef + '!$B$8',   // インフレ率
    GtLoanDate:            dashRef + '!$B$9',   // ローン完済予定日
    LoanAmount:            dashRef + '!$B$10',  // ローン月額
    UserPension:           dashRef + '!$B$11',  // 本人年金_年額
    SpousePension:         dashRef + '!$B$12',  // 配偶者年金_年額
    GtSonDate:             dashRef + '!$B$13',  // 息子支援終了日
    SonAmount:             dashRef + '!$B$14',  // 息子支援月額
    SpouseIncome:          dashRef + '!$B$15',  // 配偶者年収_年額
    GtSpouseRetire:        dashRef + '!$B$16',  // 配偶者退職予定日
    UserRetireLump:        dashRef + '!$B$17',  // 本人退職時一時金
    SpouseRetireLump:      dashRef + '!$B$18',  // 配偶者退職時一時金
    UserMonthly:           dashRef + '!$B$19',  // 本人手取り月収
    UserPensionStartAge:   dashRef + '!$B$20',  // 本人年金開始年齢
    SpousePensionStartAge: dashRef + '!$B$21',  // 配偶者年金開始年齢
    FireSafeThreshold:     dashRef + '!$B$22',  // FIRE射程_盤石閾値
    FireComfortThreshold:  dashRef + '!$B$23',  // FIRE射程_余裕閾値
    SimEndAge:             dashRef + '!$B$24'   // シミュレーション終了年齢
  };

  for (let i = 0; i < initialRows; i++) {
    const targetDate = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const rowIdx = i + 2;

    const aColVal = `=DATE(${targetDate.getFullYear()}, ${targetDate.getMonth() + 1}, 1)`;
    const dateRef = `$A${rowIdx}`;

    const ageFormula = `=DATEDIF(${D.UserBday}, ${dateRef}, "Y")`;

    const openingBalance = (i === 0) ? `=${D.CurrentAsset}` : `=H${rowIdx - 1}`;

    const incUser = `IF(${dateRef} <= ${D.RetireDate}, ${D.UserMonthly}, 0)`;
    const incSpouse = `IF(${dateRef} <= ${D.GtSpouseRetire}, ${D.SpouseIncome}/12, 0)`;
    // 年金は本人・配偶者で開始年齢を独立に設定可能（繰上/繰下に対応）
    const startUserPen = `EDATE(${D.UserBday}, 12*${D.UserPensionStartAge})`;
    const startSpousePen = `EDATE(${D.SpouseBday}, 12*${D.SpousePensionStartAge})`;
    const incUserPen = `IF(${dateRef} >= ${startUserPen}, ${D.UserPension}/12, 0)`;
    const incSpousePen = `IF(${dateRef} >= ${startSpousePen}, ${D.SpousePension}/12, 0)`;
    // 退職一時金: 本人はリタイア予定月、配偶者は配偶者退職予定月にそれぞれ加算
    const incUserLump = `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${D.RetireDate},"yyyyMM"), ${D.UserRetireLump}, 0)`;
    const incSpouseLump = `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${D.GtSpouseRetire},"yyyyMM"), ${D.SpouseRetireLump}, 0)`;

    const income = `=${incUser} + ${incSpouse} + ${incUserPen} + ${incSpousePen} + ${incUserLump} + ${incSpouseLump}`;

    const expBasic = `${D.BasicExpense}`;
    const expLoan = `IF(${dateRef} <= ${D.GtLoanDate}, ${D.LoanAmount}, 0)`;
    const expSon = `IF(${dateRef} <= ${D.GtSonDate}, ${D.SonAmount}, 0)`;

    const expense = `=${expBasic} + ${expLoan} + ${expSon}`;

    const monthlyRealYield = `=((1+${D.NominalYield})/(1+${D.Inflation}))^(1/12) - 1`;

    rows.push([
      aColVal,
      ageFormula,
      openingBalance,
      income,
      expense,
      `=D${rowIdx}-E${rowIdx}`,
      monthlyRealYield,
      `=(C${rowIdx}+F${rowIdx})*(1+G${rowIdx})`
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
    createTrajectoryChart(simSheet);
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

function createTrajectoryChart(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const existingCharts = sheet.getCharts();
  for (const c of existingCharts) {
    sheet.removeChart(c);
  }

  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.AREA)
    .addRange(sheet.getRange(1, 1, lastRow, 1))
    .addRange(sheet.getRange(1, 8, lastRow, 1))
    .setPosition(2, 10, 0, 0)
    .setOption('title', '資産推移シミュレーション')
    .setOption('hAxis', { title: '年月' })
    .setOption('vAxis', { title: '資産額 (円)' })
    .setOption('width', 900)
    .setOption('height', 500)
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

  // 各しきい値・年齢を「設定」シートから参照（行番号は setupSimulation の D マップと同期）
  const refSimEndAge            = dashRef + '!$B$24';
  const refUserPensionStartAge  = dashRef + '!$B$20';
  const refFireSafe             = dashRef + '!$B$22';
  const refFireComfort          = dashRef + '!$B$23';

  // スナップショット日 (資産推移 最新)
  sheet.getRange('A5').setValue('スナップショット日');
  sheet.getRange('B5').setFormula(
    '=IFERROR(IF(COUNTA(' + assetsRef + '!A:A)>1, INDEX(' + assetsRef + '!A:A, COUNTA(' + assetsRef + '!A:A)), ""), "")'
  );

  // 現在純資産
  sheet.getRange('A6').setValue('現在純資産（' + SHEET.DASHBOARD + '!B4）');
  sheet.getRange('B6').setFormula('=' + dashRef + '!B4');

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

  sheet.setColumnWidth(1, 230);
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

  applyFormattingManualAssets_(ss);
  applyFormattingTransactions_(ss);
  applyFormattingAssets_(ss);
  applyFormattingSimulation_(ss);
  applyFormattingReports_(ss);

  console.log("【完了】applyFormatting");
}

function applyFormattingManualAssets_(ss) {
  const sheet = ss.getSheetByName(SHEET.MANUAL_ASSETS);
  if (!sheet) return;
  const lastRow = Math.max(sheet.getLastRow(), 2);

  // ヘッダー
  sheet.getRange('A1:C1').setBackground(COLOR_HEADER).setFontWeight('bold');

  // 編集可能セル：B 列（値）と C 列（備考）に黄色背景
  const dataRows = lastRow - 1;
  if (dataRows > 0) {
    sheet.getRange(2, 2, dataRows, 2).setBackground(COLOR_EDITABLE);
    sheet.getRange(2, 2, dataRows, 1).setNumberFormat(FMT_YEN);
  }

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 280);
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

  sheet.getRange('A1:H1').setBackground(COLOR_DEFAULT).setFontWeight('bold');

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const dataRows = lastRow - 1;
    // A 年月
    sheet.getRange(2, 1, dataRows, 1).setNumberFormat(FMT_YM);
    // B 本人年齢
    sheet.getRange(2, 2, dataRows, 1).setNumberFormat(FMT_INT);
    // C/D/E/F/H 円
    sheet.getRange(2, 3, dataRows, 4).setNumberFormat(FMT_YEN);
    sheet.getRange(2, 8, dataRows, 1).setNumberFormat(FMT_YEN);
    // G 月次実質利回り
    sheet.getRange(2, 7, dataRows, 1).setNumberFormat('0.000%');
  }

  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 90);
  for (let c = 3; c <= 8; c++) sheet.setColumnWidth(c, 130);
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

  // FIRE射程：B5 日付、B6/B7/B8 円
  const fr = ss.getSheetByName(SHEET.REPORT_FIRE);
  if (fr) {
    fr.getRange('B5').setNumberFormat(FMT_DATE);
    fr.getRange('B6:B8').setNumberFormat(FMT_YEN);
  }
}
