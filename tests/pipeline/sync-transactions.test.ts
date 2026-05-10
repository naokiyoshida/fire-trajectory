import { describe, expect, it } from "vitest";
import { computeMonthsToSync } from "../../app/pipeline/sync-transactions.js";

describe("computeMonthsToSync", () => {
  const today = new Date(2026, 4, 10); // 2026-05-10

  it("returns SYNC_MONTHS in incremental mode", () => {
    expect(
      computeMonthsToSync({
        fullSync: false,
        databaseIsEmpty: false,
        fullSyncStart: "2021/10",
        defaultMonths: 6,
        today,
      }),
    ).toEqual({ months: 6, fullMode: false });
  });

  it("switches to full mode when database is empty", () => {
    expect(
      computeMonthsToSync({
        fullSync: false,
        databaseIsEmpty: true,
        fullSyncStart: "2021/10",
        defaultMonths: 6,
        today,
      }),
    ).toEqual({ months: 56, fullMode: true });
    // 2021/10 から 2026/05 = 4年7ヶ月+1 = 56
  });

  it("respects --fullSync flag even when DB has data", () => {
    expect(
      computeMonthsToSync({
        fullSync: true,
        databaseIsEmpty: false,
        fullSyncStart: "2021/10",
        defaultMonths: 6,
        today,
      }),
    ).toEqual({ months: 56, fullMode: true });
  });

  it("never goes below defaultMonths even if start is in the future", () => {
    expect(
      computeMonthsToSync({
        fullSync: true,
        databaseIsEmpty: false,
        fullSyncStart: "2030/01",
        defaultMonths: 6,
        today,
      }),
    ).toEqual({ months: 6, fullMode: true });
  });
});
