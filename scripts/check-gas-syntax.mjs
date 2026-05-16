// GAS (.gs) はプレーンな Apps Script で tsc 対象外のため、デプロイ前に
// 構文だけでも検証する。vm.Script はパースのみ行い実行はしないので、
// SpreadsheetApp 等の GAS グローバルが未定義でも問題なく構文チェックできる。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const files = ["src/gas_receiver_service.gs"];
let ok = true;

for (const file of files) {
  try {
    const src = readFileSync(file, "utf8");
    // eslint-disable-next-line no-new
    new vm.Script(src, { filename: file });
    console.log(`GAS syntax OK: ${file}`);
  } catch (e) {
    ok = false;
    console.error(`GAS syntax error in ${file}:`);
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
}

process.exit(ok ? 0 : 1);
