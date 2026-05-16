import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../../app/core/sync-status.js";

const NOW = new Date("2026-05-17T00:00:00.000Z");
const daysAgo = (d: number): string =>
  new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("evaluateHealth", () => {
  it("記録なしは異常 (code 3)", () => {
    const v = evaluateHealth(null, NOW);
    expect(v.healthy).toBe(false);
    expect(v.code).toBe(3);
  });

  it("直近が失敗 (ok:false) は異常", () => {
    const v = evaluateHealth(
      { ok: false, ts: daysAgo(1), command: "sync", error: "boom" },
      NOW,
    );
    expect(v.healthy).toBe(false);
    expect(v.message).toContain("boom");
  });

  it("成功が古すぎ (>maxAgeDays) は異常", () => {
    const v = evaluateHealth(
      { ok: true, ts: daysAgo(50), command: "sync", appended: 12 },
      NOW,
    );
    expect(v.healthy).toBe(false);
    expect(v.code).toBe(3);
  });

  it("成功だが追記0件は異常（スクレイプ不全の疑い）", () => {
    const v = evaluateHealth(
      { ok: true, ts: daysAgo(1), command: "sync", appended: 0 },
      NOW,
    );
    expect(v.healthy).toBe(false);
  });

  it("直近成功 + 追記あり + 鮮度内なら正常 (code 0)", () => {
    const v = evaluateHealth(
      { ok: true, ts: daysAgo(3), command: "sync", appended: 42 },
      NOW,
    );
    expect(v.healthy).toBe(true);
    expect(v.code).toBe(0);
  });

  it("鮮度しきい値の境界: 39日は正常 / 41日は異常 (maxAgeDays=40)", () => {
    const base = { ok: true as const, command: "sync", appended: 5 };
    expect(evaluateHealth({ ...base, ts: daysAgo(39) }, NOW).healthy).toBe(true);
    expect(evaluateHealth({ ...base, ts: daysAgo(41) }, NOW).healthy).toBe(
      false,
    );
  });
});
