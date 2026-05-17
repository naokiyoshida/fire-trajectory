import { describe, expect, it } from "vitest";
import {
  APPEND_GUARD_MAX_FRESH_RATIO,
  APPEND_GUARD_MIN_ABS,
  assessAppendSafety,
} from "../../app/pipeline/append-guard.js";

describe("assessAppendSafety", () => {
  it("フルモードは全件追記が正常なのでガード非対象", () => {
    const v = assessAppendSafety({
      fullMode: true,
      hadExistingIds: false,
      uniqueCount: 5000,
      freshCount: 5000,
    });
    expect(v.safe).toBe(true);
    expect(v.ratio).toBe(0);
  });

  it("既存IDが無い（空シート）ならガード非対象", () => {
    const v = assessAppendSafety({
      fullMode: false,
      hadExistingIds: false,
      uniqueCount: 1000,
      freshCount: 1000,
    });
    expect(v.safe).toBe(true);
  });

  it("走査0件ならガード非対象", () => {
    const v = assessAppendSafety({
      fullMode: false,
      hadExistingIds: true,
      uniqueCount: 0,
      freshCount: 0,
    });
    expect(v.safe).toBe(true);
  });

  it("健全な増分同期（新規はごく少数）は safe", () => {
    const v = assessAppendSafety({
      fullMode: false,
      hadExistingIds: true,
      uniqueCount: 600,
      freshCount: 20,
    });
    expect(v.safe).toBe(true);
    expect(v.ratio).toBeCloseTo(20 / 600);
  });

  it("新規率は高いが絶対数がしきい値未満なら誤検知回避で safe", () => {
    const v = assessAppendSafety({
      fullMode: false,
      hadExistingIds: true,
      uniqueCount: APPEND_GUARD_MIN_ABS - 5,
      freshCount: APPEND_GUARD_MIN_ABS - 5,
    });
    expect(v.safe).toBe(true);
  });

  it("増分なのに走査ほぼ全件が新規（remap-ids 事故型）は中止判定", () => {
    const v = assessAppendSafety({
      fullMode: false,
      hadExistingIds: true,
      uniqueCount: 423,
      freshCount: 423,
    });
    expect(v.safe).toBe(false);
    expect(v.ratio).toBe(1);
    expect(v.message).toContain("doctor");
  });

  it("しきい値ちょうど（比率境界）は safe 側（> 判定）", () => {
    const unique = 200;
    const fresh = Math.round(unique * APPEND_GUARD_MAX_FRESH_RATIO); // ちょうど 0.5
    const v = assessAppendSafety({
      fullMode: false,
      hadExistingIds: true,
      uniqueCount: unique,
      freshCount: fresh,
    });
    expect(v.safe).toBe(true);
  });
});
