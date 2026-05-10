/**
 * fire-trajectory: GAS スクリプト
 *
 * 役割:
 *   - Dashboard / Simulation / Report_* シートの自動構築
 *   - スプレッドシートを開いた時のカスタムメニュー
 *
 * 廃止された役割（Node.js + Playwright 側に移行）:
 *   - マネフォME からのデータ受信 (doPost / sync_data 系) は削除済み
 *   - データ書き込みは Node 側が Google Sheets API で直接行う
 */

/**
 * スプレッドシート起動時にカスタムメニューを追加する
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Fire Trajectory')
    .addItem('シミュレーションの再構築', 'setupSimulation')
    .addItem('レポートの再構築', 'setupReports')
    .addToUi();
}

/**
 * シミュレーション環境のセットアップ。
 * 1. Dashboard シートの作成・初期値入力（既存値は保持）
 * 2. Simulation シートの作成・数式モデル構築
 */
function setupSimulation() {
  console.log("【開始】setupSimulation");
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- 1. Dashboard シートの作成・既存値の保存 ---
  let dashSheet = ss.getSheetByName('Dashboard');
  let existingValues = {};

  if (!dashSheet) {
    console.log("Dashboardシートを新規作成");
    dashSheet = ss.insertSheet('Dashboard');
  } else {
    console.log("既存 Dashboard の設定値を読み込み");
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
    dashSheet.clear();
  }

  const headers = ['fire-trajectory: 設定', '設定値', '説明', 'デフォルト値'];

  // 「現在の資産」のデフォルト値: Assets_Monthly が存在すれば最新の純資産（N列）を参照、
  // データが無ければ初期値 25,000,000 を使用。
  const currentAssetFormula =
    '=IFERROR(IF(COUNTA(Assets_Monthly!A:A)>1, INDEX(Assets_Monthly!N:N, COUNTA(Assets_Monthly!A:A)), 25000000), 25000000)';

  // [項目名, デフォルト値, 説明]
  // ナラティブ層（別 Claude プロジェクト「資産運用計画」）に合わせた前提値:
  //   生活費 月35万 / 配偶者収入 月20万 / 退職金 300万 / インフレ率 0
  const items = [
    ['本人誕生日', '1977/03/09', 'YYYY/MM/DD'],
    ['配偶者誕生日', '1976/06/27', 'YYYY/MM/DD'],
    ['現在の資産', currentAssetFormula, 'Assets_Monthly 最新の純資産を自動参照（B列に手動値があれば優先）'],
    ['リタイア予定日', '2037/03/31', 'この日以降、本人収入停止'],
    ['基本生活費_月額', 350000, 'ベースとなる生活費 (ナラティブ層: 月35万)'],
    ['運用利回り_名目', 0.05, '年率 (5% = 0.05)'],
    ['インフレ率', 0, '年率 (ナラティブ層: 考慮しない=0)'],
    ['ローン完済予定日', '2042/03/31', '住宅ローン等の終了日'],
    ['ローン月額', 100000, 'ローン返済額'],
    ['本人年金_年額', 1800000, '65歳開始 (ナラティブ層: 月15万)'],
    ['配偶者年金_年額', 780000, '65歳開始 (ナラティブ層: 月6.5万)'],
    ['息子支援終了日', '2028/03/31', '教育費・養育費の終了'],
    ['息子支援月額', 50000, '支援終了までかかる費用'],
    ['配偶者年収_年額', 2400000, '配偶者の手取り年収 (ナラティブ層: 月20万 × 12)'],
    ['配偶者退職予定日', '2041/06/30', '配偶者の収入停止日'],
    ['退職時一時金', 3000000, '配偶者退職時に加算 (ナラティブ層: 300万)'],
    ['本人手取り月収', 500000, '本人の月次収入']
  ];

  const dashboardData = [headers];

  items.forEach(item => {
    const key = item[0];
    const defaultVal = item[1];
    const desc = item[2];

    const currentVal = existingValues.hasOwnProperty(key) ? existingValues[key] : defaultVal;

    dashboardData.push([key, currentVal, desc, defaultVal]);
  });

  dashSheet.getRange(1, 1, dashboardData.length, 4).setValues(dashboardData);
  dashSheet.setColumnWidth(1, 200);
  dashSheet.setColumnWidth(2, 200);
  dashSheet.setColumnWidth(3, 280);
  dashSheet.setColumnWidth(4, 200);
  dashSheet.getRange("A1:D1").setBackground('#e6f7ff').setFontWeight('bold');

  // --- 2. Simulation シート ---
  let simSheet = ss.getSheetByName('Simulation');
  if (!simSheet) {
    simSheet = ss.insertSheet('Simulation');
  }
  simSheet.clear();

  const simHeaders = ['年月', '本人年齢', '期首資産', '収入', '支出', '収支', '実質利回り(月)', '期末資産'];
  simSheet.getRange(1, 1, 1, simHeaders.length).setValues([simHeaders]).setBackground('#f3f3f3').setFontWeight('bold');

  const startDate = new Date();
  startDate.setDate(1);

  let userBdayVal = '1977/03/09';
  if (existingValues.hasOwnProperty('本人誕生日')) {
    userBdayVal = existingValues['本人誕生日'];
  } else {
    const birthItem = items.find(i => i[0] === '本人誕生日');
    if (birthItem) userBdayVal = birthItem[1];
  }

  let userBdayDate = new Date(userBdayVal);
  if (isNaN(userBdayDate.getTime())) {
    userBdayDate = new Date('1977/03/09');
  }

  const endYear = userBdayDate.getFullYear() + 100;
  const endMonth = userBdayDate.getMonth();

  let initialRows = (endYear - startDate.getFullYear()) * 12 + (endMonth - startDate.getMonth()) + 1;
  if (isNaN(initialRows) || initialRows < 12) initialRows = 12;

  const rows = [];

  const D = {
    UserBday: 'Dashboard!$B$2',
    SpouseBday: 'Dashboard!$B$3',
    CurrentAsset: 'Dashboard!$B$4',
    RetireDate: 'Dashboard!$B$5',
    BasicExpense: 'Dashboard!$B$6',
    NominalYield: 'Dashboard!$B$7',
    Inflation: 'Dashboard!$B$8',
    GtLoanDate: 'Dashboard!$B$9',
    LoanAmount: 'Dashboard!$B$10',
    UserPension: 'Dashboard!$B$11',
    SpousePension: 'Dashboard!$B$12',
    GtSonDate: 'Dashboard!$B$13',
    SonAmount: 'Dashboard!$B$14',
    SpouseIncome: 'Dashboard!$B$15',
    GtSpouseRetire: 'Dashboard!$B$16',
    RetireLump: 'Dashboard!$B$17',
    UserMonthly: 'Dashboard!$B$18'
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
    const startUserPen = `EDATE(${D.UserBday}, 12*65)`;
    const startSpousePen = `EDATE(${D.SpouseBday}, 12*65)`;
    const incUserPen = `IF(${dateRef} >= ${startUserPen}, ${D.UserPension}/12, 0)`;
    const incSpousePen = `IF(${dateRef} >= ${startSpousePen}, ${D.SpousePension}/12, 0)`;
    const incLump = `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${D.GtSpouseRetire},"yyyyMM"), ${D.RetireLump}, 0)`;

    const income = `=${incUser} + ${incSpouse} + ${incUserPen} + ${incSpousePen} + ${incLump}`;

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
 * Report_* シリーズを構築する。
 * Database / Assets_Monthly / Simulation を参照する数式ベースの集計シート。
 *   - Report_CashFlow: 月次収支
 *   - Report_Spending: 大項目別支出
 *   - Report_NetWorth: 純資産推移
 *   - Report_Allocation: 最新月の資産配分
 *   - Report_FIRE_Readiness: FIRE射程の主要指標
 */
function setupReports() {
  console.log("【開始】setupReports");
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  setupReportCashFlow_(ss);
  setupReportSpending_(ss);
  setupReportNetWorth_(ss);
  setupReportAllocation_(ss);
  setupReportFireReadiness_(ss);

  console.log("【完了】setupReports");
}

function setupReportCashFlow_(ss) {
  let sheet = ss.getSheetByName('Report_CashFlow');
  if (!sheet) sheet = ss.insertSheet('Report_CashFlow');
  sheet.clear();

  sheet.getRange('A1').setValue('Report_CashFlow: 月次収支').setFontWeight('bold');
  sheet.getRange('A2').setValue('Database から年月別に集計。収支差／収入／支出を3エリアに分けて表示');

  // QUERY Language は IF をサポートしないため、収支差・収入・支出を別エリアに出す
  // Database: B=日付 (YYYY/MM/DD), D=金額

  sheet.getRange('A3').setValue('月別収支差').setFontWeight('bold');
  const formulaTotal =
    '=IFERROR(' +
    'QUERY({ARRAYFORMULA(LEFT(Database!B2:B,7)),Database!D2:D},' +
    '"select Col1, sum(Col2) where Col1 is not null and Col1 != \'\'' +
    ' group by Col1 order by Col1 desc' +
    ' label Col1 \'年月\', sum(Col2) \'収支\'", 0)' +
    ', "Database のデータをお待ちください")';
  sheet.getRange('A4').setFormula(formulaTotal);

  sheet.getRange('D3').setValue('月別収入').setFontWeight('bold');
  const formulaIncome =
    '=IFERROR(' +
    'QUERY({ARRAYFORMULA(LEFT(Database!B2:B,7)),Database!D2:D},' +
    '"select Col1, sum(Col2) where Col2 > 0 and Col1 is not null and Col1 != \'\'' +
    ' group by Col1 order by Col1 desc' +
    ' label Col1 \'年月\', sum(Col2) \'収入\'", 0)' +
    ', "Database のデータをお待ちください")';
  sheet.getRange('D4').setFormula(formulaIncome);

  sheet.getRange('G3').setValue('月別支出').setFontWeight('bold');
  const formulaExpense =
    '=IFERROR(' +
    'QUERY({ARRAYFORMULA(LEFT(Database!B2:B,7)),Database!D2:D},' +
    '"select Col1, sum(Col2) where Col2 < 0 and Col1 is not null and Col1 != \'\'' +
    ' group by Col1 order by Col1 desc' +
    ' label Col1 \'年月\', sum(Col2) \'支出\'", 0)' +
    ', "Database のデータをお待ちください")';
  sheet.getRange('G4').setFormula(formulaExpense);

  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 130);
  sheet.setColumnWidth(7, 100);
  sheet.setColumnWidth(8, 130);
}

function setupReportSpending_(ss) {
  let sheet = ss.getSheetByName('Report_Spending');
  if (!sheet) sheet = ss.insertSheet('Report_Spending');
  sheet.clear();

  sheet.getRange('A1').setValue('Report_Spending: カテゴリ別支出').setFontWeight('bold');
  sheet.getRange('A2').setValue('Database から「大項目/中項目」別の支出合計（金額が負の取引のみ）');

  // F列 = 大項目/中項目, D列 = 金額
  const formula =
    '=IFERROR(' +
    'QUERY(Database!D2:F,' +
    '"select F, sum(D)' +
    ' where D < 0 and F is not null and F != \'\'' +
    ' group by F' +
    ' order by sum(D) asc' +
    ' label F \'カテゴリ\', sum(D) \'合計\'", 0)' +
    ', "Database のデータをお待ちください")';

  sheet.getRange('A4').setFormula(formula);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 130);
}

function setupReportNetWorth_(ss) {
  let sheet = ss.getSheetByName('Report_NetWorth');
  if (!sheet) sheet = ss.insertSheet('Report_NetWorth');
  sheet.clear();

  sheet.getRange('A1').setValue('Report_NetWorth: 純資産推移').setFontWeight('bold');
  sheet.getRange('A2').setValue('Assets_Monthly のミラー + 前月比');

  // Assets_Monthly: A=snapshot_date, I=total_assets, M=total_liabilities, N=net_worth
  const formula =
    '=IFERROR(' +
    'QUERY(Assets_Monthly!A:N,' +
    '"select A, I, M, N' +
    ' where A is not null' +
    ' order by A desc' +
    ' label A \'snapshot_date\', I \'total_assets\', M \'total_liabilities\', N \'net_worth\'", 1)' +
    ', "Assets_Monthly のデータをお待ちください")';

  sheet.getRange('A4').setFormula(formula);
  sheet.setColumnWidth(1, 130);
  sheet.setColumnWidths(2, 3, 150);
}

function setupReportAllocation_(ss) {
  let sheet = ss.getSheetByName('Report_Allocation');
  if (!sheet) sheet = ss.insertSheet('Report_Allocation');
  sheet.clear();

  sheet.getRange('A1').setValue('Report_Allocation: 最新の資産配分').setFontWeight('bold');
  sheet.getRange('A2').setValue('Assets_Monthly 最新行の各カテゴリ');

  sheet.getRange('A4:B4').setValues([['項目', '金額']]).setFontWeight('bold').setBackground('#e6f7ff');

  const items = [
    ['cash', 'B'],
    ['stocks_listed', 'C'],
    ['stocks_unlisted', 'D'],
    ['funds', 'E'],
    ['pension', 'F'],
    ['points', 'G'],
    ['other_assets', 'H'],
    ['total_assets', 'I'],
    ['credit_card', 'J'],
    ['mortgage', 'K'],
    ['other_loans', 'L'],
    ['total_liabilities', 'M'],
    ['net_worth', 'N']
  ];

  let r = 5;
  items.forEach(([label, col]) => {
    sheet.getRange(`A${r}`).setValue(label);
    sheet.getRange(`B${r}`).setFormula(
      `=IFERROR(IF(COUNTA(Assets_Monthly!A:A)>1, INDEX(Assets_Monthly!${col}:${col}, COUNTA(Assets_Monthly!A:A)), 0), 0)`
    );
    r++;
  });

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 150);
}

function setupReportFireReadiness_(ss) {
  let sheet = ss.getSheetByName('Report_FIRE_Readiness');
  if (!sheet) sheet = ss.insertSheet('Report_FIRE_Readiness');
  sheet.clear();

  sheet.getRange('A1').setValue('Report_FIRE_Readiness: FIRE射程').setFontWeight('bold');
  sheet.getRange('A2').setValue('Simulation シートと Assets_Monthly の最新値から主要指標を算出');

  sheet.getRange('A4:B4').setValues([['項目', '値']]).setFontWeight('bold').setBackground('#e6f7ff');

  // スナップショット日 (Assets_Monthly 最新)
  sheet.getRange('A5').setValue('スナップショット日');
  sheet.getRange('B5').setFormula(
    '=IFERROR(IF(COUNTA(Assets_Monthly!A:A)>1, INDEX(Assets_Monthly!A:A, COUNTA(Assets_Monthly!A:A)), ""), "")'
  );

  // 現在純資産
  sheet.getRange('A6').setValue('現在純資産（Dashboard!B4）');
  sheet.getRange('B6').setFormula('=Dashboard!B4');

  // Simulation 最終行（≒100歳時点）の期末資産
  sheet.getRange('A7').setValue('100歳時点予想資産');
  sheet.getRange('B7').setFormula(
    '=IFERROR(INDEX(Simulation!H:H, COUNTA(Simulation!A:A)), "Simulation データなし")'
  );

  // 65歳到達月の期末資産（DATEDIF=65 となる行を探す）
  sheet.getRange('A8').setValue('65歳時点予想資産');
  sheet.getRange('B8').setFormula(
    '=IFERROR(INDEX(Simulation!H:H, MATCH(65, Simulation!B:B, 0)), "Simulation データなし")'
  );

  // 資産が0以下になる最初の月（資産枯渇月）
  sheet.getRange('A9').setValue('資産枯渇月（あれば）');
  sheet.getRange('B9').setFormula(
    '=IFERROR(TEXT(INDEX(Simulation!A:A, MATCH(TRUE, ARRAYFORMULA(Simulation!H2:H<=0), 0)+1), "yyyy/MM"), "枯渇しません")'
  );

  // 余裕度フラグ：100歳時点資産が
  //  > 30,000,000 → 盤石(◎◎◎)
  //  > 5,000,000  → 余裕(◎)
  //  > 0          → ギリギリ(△)
  //  <= 0         → 枯渇(✕)
  sheet.getRange('A10').setValue('余裕度判定');
  sheet.getRange('B10').setFormula(
    '=IFERROR(IF(B7>30000000, "◎◎◎ 盤石",' +
    ' IF(B7>5000000, "◎ 余裕",' +
    ' IF(B7>0, "△ ギリギリ", "✕ 枯渇"))), "Simulation データなし")'
  );

  sheet.setColumnWidth(1, 230);
  sheet.setColumnWidth(2, 200);
}
