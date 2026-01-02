/**
 * 外部（Tampermonkey）からのデータを受信するメイン窓口
 */
function doPost(e) {
  // 複数タブから同時に送られても壊れないようにロックをかける
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // 最大10秒待機
  
  try {
    var jsonString = e.postData.contents;
    var payload = JSON.parse(jsonString);
    
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Database");
    
    // --- 同期設定の返却 ---
    if (payload.action === "get_sync_config") {
      var lastRow = sheet.getLastRow();
      var mode = (lastRow <= 1) ? "Full" : "Incremental";
      
      return ContentService.createTextOutput(JSON.stringify({
        "status": "success",
        "mode": mode
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // --- データの書き込み ---
    if (payload.action === "sync_data") {
      var data = payload.data;
      var existingData = sheet.getDataRange().getValues();
      var addedCount = 0;
      
      // 最初の行はヘッダーなのでスキップ
      existingData.shift(); 

      data.forEach(function(newRow) {
        var isDuplicate = existingData.some(function(existingRow) {
          // date(0), content(1), amount(2) が一致するかチェック
          return existingRow[0].toString() === newRow.date.toString() && 
                 existingRow[1].toString() === newRow.content.toString() &&
                 existingRow[2].toString() === newRow.amount.toString();
        });
        
        if (!isDuplicate) {
          sheet.appendRow([
            newRow.date,
            newRow.content,
            newRow.amount,
            newRow.source,
            newRow.category,
            new Date()
          ]);
          addedCount++;
        }
      });
      
      return ContentService.createTextOutput(JSON.stringify({
        "status": "success",
        "count": addedCount
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
  } catch (error) {
    // エラーが出た場合はその内容を返す
    return ContentService.createTextOutput(JSON.stringify({
      "status": "error",
      "message": error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
    
  } finally {
    // ロックを解除する
    lock.releaseLock();
  }
}