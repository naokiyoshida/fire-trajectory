/**
 * UI に出すスライダー定義（宣言的・データ駆動）。
 *
 * engine は常に全 SimParams でフル精度計算する。ここは「どの項目をスライダーに
 * 出すか／範囲／プロファイル」だけを定義する。スライダーの追加・範囲変更・
 * プロファイル変更はこの配列の1行編集で済み、engine/UI コードは触らない。
 *
 * profile: "simple" = 将来のスマホ向け最小セット, "detailed" = PC 既定。
 * "simple" は "detailed" の部分集合（simple は detailed にも含める）。
 */
import type { SimParams } from "./engine.js";

export type SliderProfile = "simple" | "detailed";

export interface SliderDef {
  /** SimParams の数値キー */
  key: Extract<
    keyof SimParams,
    | "nominalYield"
    | "inflation"
    | "baseLivingMonthly"
    | "loanMonthly"
    | "childSupportMonthly"
    | "selfMonthlyIncome"
    | "selfBonusAnnual"
    | "selfPensionStartAge"
    | "spousePensionStartAge"
    | "selfPensionAnnual"
    | "spousePensionAnnual"
  >;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 表示単位 ("%" は値×100 表示、"万円" は値/10000 表示) */
  unit: "%" | "円" | "万円" | "歳";
  profiles: SliderProfile[];
}

export const SLIDERS: SliderDef[] = [
  {
    key: "nominalYield",
    label: "運用利回り(名目)",
    min: 0,
    max: 0.1,
    step: 0.005,
    unit: "%",
    profiles: ["simple", "detailed"],
  },
  {
    key: "inflation",
    label: "インフレ率",
    min: 0,
    max: 0.05,
    step: 0.005,
    unit: "%",
    profiles: ["simple", "detailed"],
  },
  {
    key: "baseLivingMonthly",
    label: "基本生活費(月)",
    min: 200000,
    max: 600000,
    step: 10000,
    unit: "万円",
    profiles: ["simple", "detailed"],
  },
  {
    key: "selfPensionStartAge",
    label: "本人 年金開始年齢",
    min: 60,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["simple", "detailed"],
  },
  {
    key: "spousePensionStartAge",
    label: "配偶者 年金開始年齢",
    min: 60,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["detailed"],
  },
  {
    key: "selfMonthlyIncome",
    label: "本人 月収(家計入金)",
    min: 0,
    max: 600000,
    step: 10000,
    unit: "万円",
    profiles: ["detailed"],
  },
  {
    key: "selfBonusAnnual",
    label: "本人 賞与年額(家計入金)",
    min: 0,
    max: 3000000,
    step: 100000,
    unit: "万円",
    profiles: ["detailed"],
  },
  {
    key: "selfPensionAnnual",
    label: "本人 年金年額",
    min: 0,
    max: 4000000,
    step: 100000,
    unit: "万円",
    profiles: ["detailed"],
  },
  {
    key: "spousePensionAnnual",
    label: "配偶者 年金年額",
    min: 0,
    max: 4000000,
    step: 100000,
    unit: "万円",
    profiles: ["detailed"],
  },
  {
    key: "loanMonthly",
    label: "ローン月額",
    min: 0,
    max: 300000,
    step: 10000,
    unit: "万円",
    profiles: ["detailed"],
  },
  {
    key: "childSupportMonthly",
    label: "息子支援 月額",
    min: 0,
    max: 200000,
    step: 10000,
    unit: "万円",
    profiles: ["detailed"],
  },
];
