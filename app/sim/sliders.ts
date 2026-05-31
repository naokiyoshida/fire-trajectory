/**
 * UI に出すスライダー定義（宣言的・データ駆動）。
 *
 * 【設計方針】このツールの目的は「現在の状況でいつ FIRE 可能かを見る」こと。
 * よってスライダーに出すのは “レバー” だけに絞る:
 *   (a) 本質的に不確実な前提（市場：運用利回り・インフレ率）= ストレステスト対象
 *   (b) ユーザーが実際に選べる/試したい判断（退職年齢・年金開始年齢・想定寿命・
 *       基本生活費）。
 * 現在の状況で “確定している事実”（年金年額・月収/賞与・ローン・息子支援・分配課税の
 * 保有実測値・年金の前提値など）はスライダーに出さず、設定シート（または engine 既定）
 * の値をそのまま使う。スライダーから外しても入力自体は消えず計算精度は不変＝純粋な
 * UI 簡素化（露出していない項目は engine がフル精度で計算に使い続ける）。
 *
 * engine は常に全 SimParams でフル精度計算する。ここは「どの項目をスライダーに
 * 出すか／範囲／プロファイル／分類」だけを定義する。スライダーの追加・範囲変更・
 * プロファイル変更・分類変更はこの配列の1行編集で済み、engine/UI コードは触らない。
 * 確定値を一時的に試したくなったら、その項目をこの配列に1行足すだけで復活できる。
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
  /**
   * SimParams の数値キー。レバー（不確実な前提 or 試したい判断）のみを列挙する。
   * 確定値（年金年額・月収/賞与・ローン・分配課税の実測値・年金前提値など）は
   * ここに入れず、設定シート/既定の値を engine がそのまま使う（上の設計方針）。
   */
  key: Extract<
    keyof SimParams,
    | "nominalYield"
    | "inflation"
    | "baseLivingMonthly"
    | "postRetireInsuranceMonthly"
    | "selfRetireAge"
    | "selfPensionStartAge"
    | "fireTargetAge"
    | "spouseRetireAge"
    | "spousePensionStartAge"
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
  // ── 市場前提（本質的に不確実＝ストレステスト対象）──
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
  // ── 生活費・支出 ──
  {
    // 達成可否の最大レバー。
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
    // 退職後に発生する国保・介護保険料の月額（就労中は給与天引きで内包のため
    // リタイア翌月以降のみ加算・engine §4.2）。実額が通知されるまでの暫定見積り
    // ＝不確実ゆえスライダーで残す（判明したら設定シートへ固定してもよい）。
    key: "postRetireInsuranceMonthly",
    label: "退職後社会保険料(月)",
    min: 0,
    max: 150000,
    step: 5000,
    unit: "万円",
    profiles: ["detailed"],
    group: "生活費・支出",
  },
  // ── 本人 ──
  {
    // 「いつ FIRE か」そのもの。早く辞めると年金（厚生年金の加入期間）も減る（§4.1b）。
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
    // 繰上げ/繰下げは実際の意思決定（§4.1b の pensionFactor で年額を自動換算）。
    key: "selfPensionStartAge",
    label: "本人 年金開始年齢",
    min: 60,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["simple", "detailed"],
    group: "本人",
  },
  {
    // 資産を保たせたい目標年齢（想定寿命）。FIRE必要資産ライン・FIRE可能判定・
    // グラフ終了年齢を兼ねる（engine の fireTargetAge。UI 側で simEndAge も同値に
    // 揃え二重地平をなくす）。長いほど必要資産が増え FIRE は厳しくなる。
    key: "fireTargetAge",
    label: "想定寿命(資産保全)",
    min: 85,
    max: 105,
    step: 1,
    unit: "歳",
    profiles: ["detailed"],
    group: "本人",
  },
  // ── 配偶者 ──
  {
    // 配偶者の退職年齢（本人 selfRetireAge と対称）。長く働くほど世帯収入が増える。
    key: "spouseRetireAge",
    label: "配偶者 退職年齢",
    min: 45,
    max: 75,
    step: 1,
    unit: "歳",
    profiles: ["detailed"],
    group: "配偶者",
  },
  {
    // 繰上げ/繰下げは本人と独立に設定できる（§4.1b）。
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
