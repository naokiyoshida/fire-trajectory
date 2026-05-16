import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dashLookup,
  fireNeedFormula,
  LEGACY_DISCARDED_DASHBOARD_KEYS,
  lumpIncomeFormula,
  pensionIncomeFormula,
  quoteSheetNameForFormula,
  realDeflator,
} from "../../app/gas/formula-builders.js";

const GAS_SRC = readFileSync(
  new URL("../../src/gas_receiver_service.gs", import.meta.url),
  "utf8",
);

describe("formula-builders (canonical spec)", () => {
  it("quoteSheetNameForFormula escapes single quotes", () => {
    expect(quoteSheetNameForFormula("設定")).toBe("'設定'");
    expect(quoteSheetNameForFormula("a'b")).toBe("'a''b'");
  });

  it("dashLookup builds name-based INDEX/MATCH", () => {
    expect(dashLookup("'設定'", "基本生活費_月額")).toBe(
      `INDEX('設定'!$B:$B, MATCH("基本生活費_月額", '設定'!$A:$A, 0))`,
    );
  });

  it("realDeflator compounds inflation over elapsed months", () => {
    expect(realDeflator("設定!$B$23", 24)).toBe("(1+設定!$B$23)^(24/12)");
    expect(realDeflator("INF", 0)).toBe("(1+INF)^(0/12)");
  });

  it("pensionIncomeFormula deflates nominal annual pension to real", () => {
    expect(
      pensionIncomeFormula({
        dateRef: "$A5",
        startRef: "EDATE(BD,12*65)",
        pensionAnnualRef: "PEN",
        deflator: "DEF",
      }),
    ).toBe("IF($A5 >= EDATE(BD,12*65), (PEN/12)/DEF, 0)");
  });

  it("lumpIncomeFormula deflates a one-off nominal lump to real", () => {
    expect(
      lumpIncomeFormula({
        dateRef: "$A5",
        eventDateRef: "RD",
        lumpRef: "LUMP",
        deflator: "DEF",
      }),
    ).toBe('IF(TEXT($A5,"yyyyMM")=TEXT(RD,"yyyyMM"), LUMP/DEF, 0)');
  });

  it("fireNeedFormula builds the backward-recursion cell", () => {
    expect(
      fireNeedFormula({
        rowIdx: 5,
        ageCol: "B",
        targetAgeRef: "TGT",
        nextReq: "NR",
        yieldCol: "G",
        niExpr: "(NI)",
        expenseCol: "E",
      }),
    ).toBe('=IF(B5 > TGT, "", (NR)/(1+G5) - (NI) + E5)');
  });
});

// 契約テスト: .gs 側の生成テンプレが本モジュールの正準仕様と一致しているか。
// どちらか片方だけ変更すると失敗し、サイレントなドリフトを防ぐ。
describe("gas_receiver_service.gs ↔ formula-builders contract", () => {
  it("dashLookup_ template matches dashLookup()", () => {
    expect(GAS_SRC).toContain(
      "return 'INDEX(' + dashRef + '!$B:$B, MATCH(\"' + key + '\", ' + dashRef + '!$A:$A, 0))';",
    );
  });

  it("realDeflator template present", () => {
    expect(GAS_SRC).toContain(
      "const realDeflator = `(1+${D.Inflation})^(${i}/12)`;",
    );
  });

  it("pension income is real-deflated (nominal→real bug fix stays)", () => {
    expect(GAS_SRC).toContain(
      "const incUserPen = `IF(${dateRef} >= ${startUserPen}, (${D.UserPension}/12)/${realDeflator}, 0)`;",
    );
    expect(GAS_SRC).toContain(
      "const incSpousePen = `IF(${dateRef} >= ${startSpousePen}, (${D.SpousePension}/12)/${realDeflator}, 0)`;",
    );
  });

  it("retirement lump is real-deflated", () => {
    expect(GAS_SRC).toContain(
      'const incUserLump = `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${D.RetireDate},"yyyyMM"), ${D.UserRetireLump}/${realDeflator}, 0)`;',
    );
  });

  it("fireNeed cell template matches fireNeedFormula()", () => {
    expect(GAS_SRC).toContain(
      'const fireNeed = `=IF(B${rowIdx} > ${D.FireTargetAge}, "", (${nextReq})/(1+G${rowIdx}) - ${niFire} + E${rowIdx})`;',
    );
  });

  it("legacy discarded keys are still migrated in the .gs", () => {
    for (const key of LEGACY_DISCARDED_DASHBOARD_KEYS) {
      expect(GAS_SRC).toContain(`existingValues.hasOwnProperty('${key}')`);
    }
  });
});
