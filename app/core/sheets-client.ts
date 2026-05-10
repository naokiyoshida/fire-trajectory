import { google, type sheets_v4 } from "googleapis";
import { logger } from "./logger.js";

export interface SheetsClient {
  api: sheets_v4.Sheets;
  spreadsheetId: string;
}

export async function createSheetsClient(
  spreadsheetId: string,
  serviceAccountJsonPath: string,
): Promise<SheetsClient> {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountJsonPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const api = google.sheets({ version: "v4", auth });
  return { api, spreadsheetId };
}

export async function listSheets(client: SheetsClient): Promise<string[]> {
  const meta = await client.api.spreadsheets.get({
    spreadsheetId: client.spreadsheetId,
  });
  const titles: string[] = [];
  for (const s of meta.data.sheets ?? []) {
    const title = s.properties?.title;
    if (typeof title === "string") titles.push(title);
  }
  return titles;
}

/**
 * Sheets API の A1 表記でシート名を安全に引用する。
 * 日本語や記号を含むシート名は 'シングルクォート' で囲む必要があり、
 * 名前自体に ' を含む場合は '' にエスケープする。
 */
export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export async function ensureSheet(
  client: SheetsClient,
  name: string,
  headers: string[],
): Promise<{ created: boolean; headersWritten: boolean }> {
  const sheets = await listSheets(client);
  let created = false;
  if (!sheets.includes(name)) {
    await client.api.spreadsheets.batchUpdate({
      spreadsheetId: client.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: name } } }],
      },
    });
    created = true;
    logger.info(`Created sheet: ${name}`);
  }

  const quoted = quoteSheetName(name);
  const headerRange = `${quoted}!A1:${columnLetter(headers.length)}1`;
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: client.spreadsheetId,
    range: headerRange,
  });
  const current = (res.data.values?.[0] ?? []) as string[];

  let headersWritten = false;
  if (current.length === 0) {
    await client.api.spreadsheets.values.update({
      spreadsheetId: client.spreadsheetId,
      range: `${quoted}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [headers] },
    });
    headersWritten = true;
    logger.info(`Wrote headers to ${name}: ${headers.join(", ")}`);
  }

  return { created, headersWritten };
}

export async function readColumnValues(
  client: SheetsClient,
  sheetName: string,
  column: string,
  startRow = 2,
): Promise<string[]> {
  const range = `${quoteSheetName(sheetName)}!${column}${startRow}:${column}`;
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: client.spreadsheetId,
    range,
  });
  const rows = (res.data.values ?? []) as string[][];
  const out: string[] = [];
  for (const row of rows) {
    const v = row[0];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

export async function appendRows(
  client: SheetsClient,
  sheetName: string,
  rows: (string | number | null)[][],
): Promise<void> {
  if (rows.length === 0) return;
  await client.api.spreadsheets.values.append({
    spreadsheetId: client.spreadsheetId,
    range: `${quoteSheetName(sheetName)}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

export function columnLetter(col: number): string {
  if (col < 1) throw new Error(`columnLetter requires col >= 1 (got ${col})`);
  let result = "";
  let n = col;
  while (n > 0) {
    const m = (n - 1) % 26;
    result = String.fromCharCode(65 + m) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}
