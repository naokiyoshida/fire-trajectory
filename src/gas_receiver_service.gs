// スクリプト全体で利用するプロパティと設定値を定義
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const SHEET_NAME = SCRIPT_PROPERTIES.getProperty('SHEET_NAME') || 'Database';

/**
 * 外部からのGETリクエストを処理する関数（動作確認用）。
 * ブラウザでURLを直接開いた場合に、アプリが稼働していることを示します。
 */
function doGet(e) {
  return createJsonResponse({ status: "success", message: "GAS Web App is active." });
}

/**
 * 外部（Tampermonkey）からのPOSTリクエストを処理するメインの関数。
 * リクエストの`action`に応じて、適切なハンドラ関数に処理を委譲します。
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  // ロック待機時間を短くして、競合時のタイムアウトを早める
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
      return createJsonResponse({ status: "error", message: "Authentication failed. Invalid or missing API key." });
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

/**
 * APIキーを使用してリクエストが正当であるかを認証します。
 * @param {object} payload - リクエストのペイロード。
 * @returns {boolean} 認証が成功した場合はtrue、それ以外はfalse。
 */
function isAuthorized(payload) {
  const API_KEY = SCRIPT_PROPERTIES.getProperty('API_KEY');
  // APIキーがサーバー側に設定されていない場合は、セキュリティチェックをスキップ（開発用/簡易モード）
  if (!API_KEY) {
    return true;
  }
  // キーが設定されている場合は、クライアントからのキーと一致するか確認
  return payload && payload.apiKey === API_KEY;
}

/**
 * 同期モード（'Full'または'Incremental'）を決定して返します。
 * @returns {ContentService.TextOutput} 同期モードを含むJSONレスポンス。
 */
function handleSyncConfig() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  // シートが存在しない場合は作成
  if (!sheet) {
     const newSheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_NAME);
     getOrCreateHeader(newSheet, 'ID');
     return createJsonResponse({ status: "success", mode: "Full" });
  }
  const mode = (sheet.getLastRow() <= 1) ? "Full" : "Incremental";
  return createJsonResponse({ status: "success", mode: mode });
}

/**
 * データ同期処理を実行します。ID列の確認、重複チェック、データの一括書き込みを行います。
 * @param {object} payload - クライアントから送信されたデータを含むペイロード。
 * @returns {ContentService.TextOutput} 処理結果を含むJSONレスポンス。
 */
function handleSyncData(payload) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_NAME);
  }

  // ヘッダーを取得し、ID列がなければ作成
  const headers = getOrCreateHeader(sheet, 'ID');
  const idColumnIndex = headers.indexOf('ID') + 1;

  // 既存のIDをSetとして取得
  const existingIds = getExistingIds(sheet, idColumnIndex);

  // 受信したデータから、重複していない新しい行だけを抽出
  const rowsToAppend = payload.data.filter(newRow => !existingIds.has(newRow.id))
    .map(newRow => {
      // ヘッダーの順序に従ってデータを並べ替える
      const rowData = new Array(headers.length).fill('');
      headers.forEach((header, index) => {
        if (header === 'sync_timestamp') {
          rowData[index] = new Date();
        } else if (newRow.hasOwnProperty(header)) {
          rowData[index] = newRow[header];
        }
      });
      return rowData;
    });

  // 追加する行がある場合、一括で書き込み
  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, headers.length)
      .setValues(rowsToAppend);
  }

  return createJsonResponse({ status: "success", count: rowsToAppend.length });
}

/**
 * シートのヘッダーを取得します。指定した列名がヘッダーにない場合、先頭に挿入します。
 * @param {Sheet} sheet - 対象のGoogle Sheetオブジェクト。
 * @param {string} requiredColumn - 存在を確認・追加する列の名前。
 * @returns {Array<string>} 更新後のヘッダー配列。
 */
function getOrCreateHeader(sheet, requiredColumn) {
    let headers = [];
    if (sheet.getLastRow() > 0) {
        headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    } else {
        // シートが空の場合は、ヘッダー行を初期化
        sheet.appendRow([requiredColumn, 'date', 'content', 'amount', 'source', 'category', 'sync_timestamp']);
        return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    }
    
    if (headers.indexOf(requiredColumn) === -1) {
        // ID列が存在しない場合、A列に挿入
        sheet.insertColumnBefore(1);
        sheet.getRange(1, 1).setValue(requiredColumn);
        headers.unshift(requiredColumn);
    }
    return headers;
}

/**
 * 指定された列から既存のIDをすべて読み込み、Setとして返します。
 * @param {Sheet} sheet - 対象のGoogle Sheetオブジェクト。
 * @param {number} idColumnIndex - IDが格納されている列のインデックス（1始まり）。
 * @returns {Set<string>} 既存のIDのセット。
 */
function getExistingIds(sheet, idColumnIndex) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return new Set();
  }
  const ids = sheet.getRange(2, idColumnIndex, lastRow - 1, 1).getValues()
    .flat() // 2D配列を1D配列に変換
    .filter(id => id !== ''); // 空白のIDを除外
  return new Set(ids);
}

/**
 * JSON形式のレスポンスを生成します。
 * @param {object} obj - レスポンスとして返すオブジェクト。
 * @returns {ContentService.TextOutput} JSON文字列に変換されたレスポンス。
 */
function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}