/**
 * engine.ts を typescript の transpileModule で単一ファイル JS 化し、
 * テンプレートのトークンを置換して dist/fire.html を生成する。
 *
 * ロジックは engine.ts の1箇所のみ（ブラウザもこれを実行）＝ドリフト不能。
 * バンドラ/新規依存は不要（typescript は既存 devDependency）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { SimParams } from "./engine.js";
import { SLIDERS } from "./sliders.js";

const ENGINE_PATH = fileURLToPath(new URL("./engine.ts", import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL("./template.html", import.meta.url));
export const OUTPUT_PATH = fileURLToPath(
  new URL("../../dist/fire.html", import.meta.url),
);

/** engine.ts を素の JS（export 除去）へ変換。 */
export function engineToBrowserJs(source: string): string {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  // 型は transpile で消える。残る `export ` 接頭辞のみ素の関数宣言に戻す。
  return out.replace(/^export\s+/gm, "");
}

/** トークン安全置換（$ 特殊置換を避けるため split/join）。 */
function put(haystack: string, token: string, value: string): string {
  return haystack.split(token).join(value);
}

/** テンプレ＋engineJS＋paramsから完成 HTML を組む（純粋・テスト可能）。 */
export function buildHtml(args: {
  template: string;
  engineJs: string;
  params: SimParams;
  generatedAt: string;
  defaultProfile?: "simple" | "detailed";
}): string {
  let html = args.template;
  html = put(html, "__ENGINE_JS__", args.engineJs);
  html = put(html, "__PARAMS_JSON__", JSON.stringify(args.params));
  html = put(html, "__SLIDERS_JSON__", JSON.stringify(SLIDERS));
  html = put(html, "__PROFILE_DEFAULT__", args.defaultProfile ?? "detailed");
  html = put(html, "__GENERATED_AT__", args.generatedAt);
  return html;
}

/** dist/fire.html を書き出し、絶対パスを返す。 */
export function renderHtml(params: SimParams, now = new Date()): string {
  const engineJs = engineToBrowserJs(readFileSync(ENGINE_PATH, "utf8"));
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const html = buildHtml({
    template,
    engineJs,
    params,
    generatedAt: now.toISOString(),
  });
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, html, "utf8");
  return OUTPUT_PATH;
}
