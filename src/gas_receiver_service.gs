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
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  // シートが存在しない場合は作成してヘッダーを設定
  if (!sheet) {
     sheet = ss.insertSheet(SHEET_NAME);
     initSheetHeader(sheet);
     return createJsonResponse({ status: "success", mode: "Full" });
  }

  // データが少なければFull Syncを要求
  const mode = (sheet.getLastRow() <= 1) ? "Full" : "Incremental";
  return createJsonResponse({ status: "success", mode: mode });
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
