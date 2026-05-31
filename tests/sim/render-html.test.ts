import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SimParams } from "../../app/sim/engine.js";
import { buildHtml, engineToBrowserJs } from "../../app/sim/render-html.js";

const ENGINE_SRC = readFileSync(
  fileURLToPath(new URL("../../app/sim/engine.ts", import.meta.url)),
  "utf8",
);

const PARAMS = { asOf: "2026-05-01", currentAssets: 1 } as unknown as SimParams;

describe("engineToBrowserJs", () => {
  const js = engineToBrowserJs(ENGINE_SRC);

  it("型と export が落ちて素の simulate 関数になる", () => {
    expect(js).toContain("function simulate");
    expect(js).not.toMatch(/^export\s/m);
    expect(js).not.toContain("interface SimParams");
  });
});

describe("buildHtml", () => {
  const html = buildHtml({
    template: readFileSync(
      fileURLToPath(new URL("../../app/sim/template.html", import.meta.url)),
      "utf8",
    ),
    engineJs: engineToBrowserJs(ENGINE_SRC),
    params: PARAMS,
    generatedAt: "2026-05-17T00:00:00.000Z",
  });

  it("全トークンが置換され未置換が残らない", () => {
    expect(html).not.toContain("__ENGINE_JS__");
    expect(html).not.toContain("__PARAMS_JSON__");
    expect(html).not.toContain("__SLIDERS_JSON__");
    expect(html).not.toContain("__PROFILE_DEFAULT__");
    expect(html).not.toContain("__GENERATED_AT__");
  });

  it("入力と既定プロファイルが埋め込まれる", () => {
    expect(html).toContain('"asOf":"2026-05-01"');
    expect(html).toContain('PROFILE = "detailed"');
    expect(html).toContain("function simulate");
  });

  // template.html の手書き JS（描画・スライダー・ツールチップ等）は tsc 対象外。
  // engine JS と結合した <script> 全体を new Function で構文解析し（DOM は実行
  // しない）、波括弧/引数の付け忘れ等の構文リグレッションをローカルで閉じる。
  it("結合した <script> が構文エラーなくパースできる（手書きJSの回帰防止）", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1] ?? "",
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) {
      expect(() => new Function(body)).not.toThrow();
    }
  });
});
