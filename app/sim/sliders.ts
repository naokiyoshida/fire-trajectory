/**
 * UI に出すスライダー定義（宣言的・データ駆動）。
 *
 * engine は常に全 SimParams でフル精度計算する。ここは「どの項目をスライダーに
 * 出すか／範囲／プロファイル／分類」だけを定義する。スライダーの追加・範囲変更・
 * プロファイル変更・分類変更はこの配列の1行編集で済み、engine/UI コードは触らない。
 *
 * profile: "simple" = 将来のスマホ向け最小セット, "detailed" = PC 既定。
 * "simple" は "detailed" の部分集合（simple は detailed にも含める）。
 * group: UI で見出し付きにまとめる分類。配列はこの分類順に並べる
 *   （renderSliders は配列順のまま、group が変わる箇所で見出しを差し込む）。
 */
import type { SimParams } from "./engine.js";

export type SliderProfile = "simple" | "detailed";

export type SliderGroup = "市場前提" | "生活費・支出" | "本人" | "配偶者";

export interface SliderDef {
  /** SimParams の数値キー */
  key: Extract<
    keyof SimParams,
    | "nominalYield"
    | "inflation"
    | "dividendYield"
    | "nisaRatio"
    | "foreignDivShare"
    | "baseLivingMonthly"
    | "loanMonthly"
    | "childSupportMonthly"
    | "selfRetireAge"
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
  /** UI 見出し分類（配列はこの分類が連続するよう並べる） */
  group: SliderGroup;
}

export const SLIDERS: SliderDef[] = [
  // ── 市場前提 ──
  {
    key: "nominalYield",
    label: "運用利回り(名目)",
    min: 0,
    max: 0.1,
    step: 0.001,
    unit: "%",
    profiles: ["simple", "detailed"],
    group: "市場前提",
  },
  {
    key: "inflation",
    label: "インフレ率",
    min: 0,
    max: 0.05,
    step: 0.001,
    unit: "%",
    profiles: ["simple", "detailed"],
    group: "市場前提",
  },
  {
    // 総リターンのうち分配（配当）で実現する利回り。課税口座分だけ 20.315%
    // 課税され実効リターンを下げる（engine §4.1a）。範囲は暫定（次回ログインの
    // 実保有から確定予定）。NISA比率と組で効く。
    key: "dividendYield",
    label: "分配金利回り(課税)",
    min: 0,
    max: 0.05,
    step: 0.001,
    unit: "%",
    profiles: ["detailed"],
    group: "市場前提",
  },
  {
    // 分配金のうち NISA（非課税）で受け取る割合。100%で分配課税ドラッグが消える
    // （資産割合ではなく「分配のうち NISA 割合」で与えるのが正確・engine §4.1a）。
    key: "nisaRatio",
    label: "NISA比率(分配の非課税割合)",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "%",
    profiles: ["detailed"],
    group: "市場前提",
  },
  {
    // 分配金のうち外国源泉（米株配当など）の割合。NISA 分でも外国源泉税(≒10%)は
    // 回収できず恒久ドラッグになる（engine §4.1a）。米株 ETF・米株比率の高い投信を
    // 多く持つほど大きい。NISA比率100%でも消えない数少ない実コストを表す。
    key: "foreignDivShare",
    label: "分配の外国源泉割合(米株等)",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "%",
    profiles: ["detailed"],
    group: "市場前提",
  },
  // ── 生活費・支出 ──
  {
    key: "baseLivingMonthly",
    label: "基本生活費(月)",
    min: 200000,
    max: 600000,
    step: 5000,
    unit: "万円",
    profiles: ["simple", "detailed"],
    group: "生活費・支出",
  },
  {
    key: "loanMonthly",
    label: "ローン月額",
    min: 0,
    max: 300000,
    step: 5000,
    unit: "万円",
    profiles: ["detailed"],
    group: "生活費・支出",
  },
  {
    key: "childSupportMonthly",
    label: "息子支援 月額",
    min: 0,
    max: 200000,
    step: 5000,
    unit: "万円",
    profiles: ["detailed"],
    group: "生活費・支出",
  },
  // ── 本人 ──
  {
    key: "selfRetireAge",
    label: "本人 退職年齢",
    min: 45,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["simple", "detailed"],
    group: "本人",
  },
  {
    key: "selfMonthlyIncome",
    label: "本人 月収(家計入金)",
    min: 0,
    max: 600000,
    step: 5000,
    unit: "万円",
    profiles: ["detailed"],
    group: "本人",
  },
  {
    key: "selfBonusAnnual",
    label: "本人 賞与年額(家計入金)",
    min: 0,
    max: 3000000,
    step: 50000,
    unit: "万円",
    profiles: ["detailed"],
    group: "本人",
  },
  {
    key: "selfPensionAnnual",
    label: "本人 年金年額",
    min: 0,
    max: 4000000,
    step: 10000,
    unit: "万円",
    profiles: ["detailed"],
    group: "本人",
  },
  {
    key: "selfPensionStartAge",
    label: "本人 年金開始年齢",
    min: 60,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["simple", "detailed"],
    group: "本人",
  },
  // ── 配偶者 ──
  {
    key: "spousePensionAnnual",
    label: "配偶者 年金年額",
    min: 0,
    max: 4000000,
    step: 10000,
    unit: "万円",
    profiles: ["detailed"],
    group: "配偶者",
  },
  {
    key: "spousePensionStartAge",
    label: "配偶者 年金開始年齢",
    min: 60,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["detailed"],
    group: "配偶者",
  },
];
