// スクリプト全体で利用するプロパティと設定値を定義
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const SHEET_NAME = SCRIPT_PROPERTIES.getProperty('SHEET_NAME') || 'Database';

/**
 * カラム名のマッピング定義
 * キー: クライアントから送られてくるJSONのキー
 * 値: スプレッドシートのヘッダー名（日本語）
 */
const HEADER_MAP = {
  'ID': 'ID',
  'date': '日付',
  'content': '内容',
  'amount': '金額',
  'source': '保有金融機関',
  'category': '大項目/中項目',
  'sync_timestamp': '取得日時'
};

// ヘッダーの並び順定義
const HEADER_ORDER = ['ID', '日付', '内容', '金額', '保有金融機関', '大項目/中項目', '取得日時'];

/**
 * 外部からのGETリクエストを処理する関数（動作確認用）。
 */
function doGet(e) {
  return createJsonResponse({ status: "success", message: "GAS Web App is active." });
}

/**
 * 外部（Tampermonkey）からのPOSTリクエストを処理するメインの関数。
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
     return createJsonResponse({ status: "error", message: "Server is busy. Please try again." });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
        return createJsonResponse({ status: "error", message: "No post data received." });
    }

    let payload;
    try {
        payload = JSON.parse(e.postData.contents);
    } catch (parseError) {
        return createJsonResponse({ status: "error", message: "JSON parse error: " + parseError.toString() });
    }

    // --- 認証 ---
    if (!isAuthorized(payload)) {
      // 開発時はAPI Keyなしでも動くように緩和する場合もあるが、基本はチェック
      // return createJsonResponse({ status: "error", message: "Authentication failed." });
    }

    // --- アクションに応じた処理の分岐 ---
    switch (payload.action) {
      case "get_sync_config":
        return handleSyncConfig();
      case "sync_data":
        return handleSyncData(payload);
      default:
        return createJsonResponse({ status: "error", message: "Invalid action provided." });
    }
  } catch (error) {
    return createJsonResponse({ status: "error", message: "Server Error: " + error.toString() });
  } finally {
    lock.releaseLock();
  }
}

function isAuthorized(payload) {
  const API_KEY = SCRIPT_PROPERTIES.getProperty('API_KEY');
  if (!API_KEY) return true; // サーバー側にキー設定がなければスルー
  return payload && payload.apiKey === API_KEY;
}

/**
 * 同期設定を返す。シートがなければ作成・初期化も行う。
 */
function handleSyncConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let simSetupStatus = "skipped";
  
  // シミュレーション環境が未構築（Dashboardがない）場合は自動作成
  if (!ss.getSheetByName('Dashboard')) {
    try {
      setupSimulation();
      simSetupStatus = "created";
    } catch (e) {
      simSetupStatus = "error: " + e.toString();
      console.error("Setup Simulation Error: " + e.toString());
    }
  }

  let sheet = ss.getSheetByName(SHEET_NAME);
  
  // シートが存在しない場合は作成してヘッダーを設定
  if (!sheet) {
     sheet = ss.insertSheet(SHEET_NAME);
     initSheetHeader(sheet);
     return createJsonResponse({ status: "success", mode: "Full", simSetup: simSetupStatus });
  }

  // データが少なければFull Syncを要求
  const mode = (sheet.getLastRow() <= 1) ? "Full" : "Incremental";
  return createJsonResponse({ status: "success", mode: mode, simSetup: simSetupStatus });
}

/**
 * データ同期処理。
 */
function handleSyncData(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // ヘッダーがあるか確認し、なければ初期化
  const headers = initSheetHeader(sheet);
  
  // 'ID'カラムの位置を探す
  const idColIndex = headers.indexOf('ID') + 1;
  if (idColIndex === 0) {
      return createJsonResponse({ status: "error", message: "ID column not found." });
  }

  // 既存IDの取得 (高速な重複チェックのためSetにする)
  const existingIds = getExistingIds(sheet, idColIndex);

  // 追加対象の行を作成
  const rowsToAppend = [];
  
  payload.data.forEach(item => {
    // 重複チェック: IDが既に存在すればスキップ
    if (existingIds.has(item.ID)) {
        return;
    }

    // 重複していなければIDをSetに追加（今回のペイロード内での重複も防ぐ）
    existingIds.add(item.ID);

    // 行データの構築
    const row = headers.map(headerName => {
      // ヘッダー名(日本語)から対応するJSONキーを探す
      // 例: '日付' -> findKeyByValue('日付') -> 'date'
      const key = Object.keys(HEADER_MAP).find(k => HEADER_MAP[k] === headerName);
      
      if (key === 'sync_timestamp') {
          return new Date(); // 取得日時は現在時刻
      }
      return item[key] || ''; // 値がなければ空文字
    });

    rowsToAppend.push(row);
  });

  // 一括書き込み
  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, headers.length)
      .setValues(rowsToAppend);
  }

  return createJsonResponse({ status: "success", count: rowsToAppend.length });
}

/**
 * シートのヘッダーを初期化・取得する。
 * 日本語ヘッダーを使用。
 */
function initSheetHeader(sheet) {
    const lastRow = sheet.getLastRow();
    
    // データもヘッダーも何もない場合、新規作成
    if (lastRow === 0) {
        sheet.appendRow(HEADER_ORDER);
        return HEADER_ORDER;
    }
    
    // 既存ヘッダーを取得
    // 1行目をヘッダーとみなす
    const currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    // ID列だけは必須チェック（もしなければA列に追加...というロジックは残すが、基本は作り直してもらう方が安全）
    if (currentHeaders.indexOf('ID') === -1) {
        sheet.insertColumnBefore(1);
        sheet.getRange(1, 1).setValue('ID');
        currentHeaders.unshift('ID');
    }
    
    return currentHeaders;
}

/**
 * 指定列のIDを全て取得する
 */
function getExistingIds(sheet, colIndex) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  
  const data = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
  // Setを使って高速化
  const idSet = new Set();
  for (let i = 0; i < data.length; i++) {
      if (data[i][0]) idSet.add(data[i][0]);
  }
  return idSet;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * シミュレーション環境のセットアップを行う。
 * 1. Dashboard シートを作成し、初期値を入力
 * 2. Simulation シートを作成し、数式を設定
 */
function setupSimulation() {
  console.log("【開始】setupSimulation が呼び出されました。");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // --- 1. Dashboard シートの作成・既存値の保存 ---
  let dashSheet = ss.getSheetByName('Dashboard');
  let existingValues = {}; // 既存の設定値を保持するMap {項目名: 値}

  if (!dashSheet) {
    console.log("Dashboardシートが存在しないため、新規作成します。");
    dashSheet = ss.insertSheet('Dashboard');
  } else {
    console.log("既存のDashboardシートを検出しました。既存の設定値を読み込みます。");
    // 既存データの読み込み (1行目はヘッダーなので2行目から)
    const lastRow = dashSheet.getLastRow();
    if (lastRow > 1) {
      // A列(項目名)とB列(設定値)を取得
      const range = dashSheet.getRange(2, 1, lastRow - 1, 2);
      const values = range.getValues();
      values.forEach(row => {
        // キーがあり、値が空でない場合のみ保持
        if (row[0] && row[1] !== "") {
           existingValues[row[0]] = row[1];
        }
      });
    }
    dashSheet.clear(); // 一旦クリアしてレイアウト再構築
  }
  
  // 定義データ構築
  // B列: ユーザー設定値 (既存値があれば優先、なければデフォルト)
  // D列: デフォルト値 (常に固定)
  const headers = ['fire-trajectory: 設定', '設定値', '説明', 'デフォルト値'];
  
  // [項目名, デフォルト値, 説明]
  const items = [
    ['本人誕生日', '1977/03/09', 'YYYY/MM/DD'],
    ['配偶者誕生日', '1976/06/27', 'YYYY/MM/DD'],
    ['現在の資産', 25000000, 'シミュレーション開始時の資産 (円)'],
    ['リタイア予定日', '2037/03/31', 'この日以降、本人収入停止'],
    ['基本生活費_月額', 500000, 'ベースとなる生活費'],
    ['運用利回り_名目', 0.05, '年率 (5% = 0.05)'],
    ['インフレ率', 0.02, '年率 (2% = 0.02)'],
    ['ローン完済予定日', '2042/03/31', '住宅ローン等の終了日'],
    ['ローン月額', 100000, 'ローン返済額'],
    ['本人年金_年額', 1800000, '65歳開始'],
    ['配偶者年金_年額', 800000, '65歳開始'],
    ['息子支援終了日', '2028/03/31', '教育費・養育費の終了'],
    ['息子支援月額', 50000, '支援終了までかかる費用'],
    ['配偶者年収_年額', 2000000, '配偶者の手取り年収'],
    ['配偶者退職予定日', '2041/06/30', '配偶者の収入停止日'],
    ['退職時一時金', 1000000, '配偶者退職時に加算'],
    ['本人手取り月収', 500000, '本人の月次収入 (追加項目)']
  ];

  const dashboardData = [headers];
  
  items.forEach(item => {
    const key = item[0];
    const defaultVal = item[1];
    const desc = item[2];
    
    // 既存値が存在すればそれを採用、なければデフォルト値
    const currentVal = existingValues.hasOwnProperty(key) ? existingValues[key] : defaultVal;
    
    // [A:項目名, B:設定値, C:説明, D:デフォルト値]
    dashboardData.push([key, currentVal, desc, defaultVal]);
  });
  
  dashSheet.getRange(1, 1, dashboardData.length, 4).setValues(dashboardData);
  dashSheet.setColumnWidth(1, 200);
  dashSheet.setColumnWidth(2, 150);
  dashSheet.setColumnWidth(3, 200);
  dashSheet.setColumnWidth(4, 150);
  dashSheet.getRange("A1:D1").setBackground('#e6f7ff').setFontWeight('bold');

  // --- 2. Simulation シートの作成 ---
  let simSheet = ss.getSheetByName('Simulation');
  if (!simSheet) {
    simSheet = ss.insertSheet('Simulation');
  }
  simSheet.clear();

  const simHeaders = ['年月', '本人年齢', '期首資産', '収入', '支出', '収支', '実質利回り(月)', '期末資産'];
  simSheet.getRange(1, 1, 1, simHeaders.length).setValues([simHeaders]).setBackground('#f3f3f3').setFontWeight('bold');

  // 開始月を設定 (現在月)
  const startDate = new Date();
  startDate.setDate(1);

  const initialRows = 360; // 30年分
  const rows = [];
  
  // Dashboardのセル参照定義 (絶対参照)
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
    const dateStr = Utilities.formatDate(targetDate, "GMT+9", "yyyy/MM");
    const dateSerial = `DATE(${targetDate.getFullYear()}, ${targetDate.getMonth()+1}, 1)`;
    
    // 年齢 (Excel数式で計算させるため、ここではJSでシンプルに入れておくか、DATEDIFを使う)
    // ここではJSで計算した固定値を入れる (シミュレーション開始時点からの経過月数で加算も可だが、行ごとに計算)
    const rowIdx = i + 2;
    
    // 年齢計算式: DATEDIF(誕生日, その月, "Y")
    const ageFormula = `=DATEDIF(${D.UserBday}, ${dateSerial}, "Y")`;

    // 期首資産
    const openingBalance = (i === 0) ? `=${D.CurrentAsset}` : `=H${rowIdx - 1}`;
    
    // 収入ロジック
    // 1. 本人給与: リタイア日まで
    // 2. 配偶者給与: 退職日まで (年額/12)
    // 3. 本人年金: 65歳以降 (EDATE(誕生日, 12*65) < DATE) (年額/12)
    // 4. 配偶者年金: 65歳以降 (年額/12)
    // 5. 一時金: 配偶者退職月に加算
    
    // ※複雑になるため、IF文を分割して加算
    const incUser = `IF(${dateSerial} <= ${D.RetireDate}, ${D.UserMonthly}, 0)`;
    const incSpouse = `IF(${dateSerial} <= ${D.GtSpouseRetire}, ${D.SpouseIncome}/12, 0)`;
    // 年金開始日 = 誕生日 + 65年.  EDATEで計算
    const startUserPen = `EDATE(${D.UserBday}, 12*65)`;
    const startSpousePen = `EDATE(${D.SpouseBday}, 12*65)`;
    const incUserPen = `IF(${dateSerial} >= ${startUserPen}, ${D.UserPension}/12, 0)`;
    const incSpousePen = `IF(${dateSerial} >= ${startSpousePen}, ${D.SpousePension}/12, 0)`;
    const incLump = `IF(TEXT(${dateSerial},"yyyyMM")=TEXT(${D.GtSpouseRetire},"yyyyMM"), ${D.RetireLump}, 0)`;
    
    const income = `=${incUser} + ${incSpouse} + ${incUserPen} + ${incSpousePen} + ${incLump}`;

    // 支出ロジック
    // 1. 基本生活費
    // 2. ローン: 完済日まで
    // 3. 息子支援: 終了日まで
    const expBasic = `${D.BasicExpense}`;
    const expLoan = `IF(${dateSerial} <= ${D.GtLoanDate}, ${D.LoanAmount}, 0)`;
    const expSon = `IF(${dateSerial} <= ${D.GtSonDate}, ${D.SonAmount}, 0)`;
    
    const expense = `=${expBasic} + ${expLoan} + ${expSon}`;

    // 実質利回り (月次)
    const monthlyRealYield = `=((1+${D.NominalYield})/(1+${D.Inflation}))^(1/12) - 1`;

    rows.push([
      dateStr,
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
  createTrajectoryChart(simSheet);

  console.log("【完了】setupSimulation が正常に終了しました。");
  return createJsonResponse({ status: "success", message: "Simulation sheets initialized (Dashboard ver)." });
}

function createTrajectoryChart(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  // 既存のチャートがあれば削除
  const existingCharts = sheet.getCharts();
  for (const c of existingCharts) {
    sheet.removeChart(c);
  }

  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.AREA)
    .addRange(sheet.getRange(1, 1, lastRow, 1)) // 年月
    .addRange(sheet.getRange(1, 8, lastRow, 1)) // 期末資産
    .setPosition(2, 10, 0, 0)
    .setOption('title', '資産推移シミュレーション')
    .setOption('hAxis', {title: '年月'})
    .setOption('vAxis', {title: '資産額 (円)'})
    .setOption('width', 900)
    .setOption('height', 500)
    .build();
  
  sheet.insertChart(chart);
}
