/**
 * 追記前インバリアントガード（純粋関数・単体テスト可能）。
 *
 * 背景: remap-ids 事故では「増分同期なのに走査ほぼ全件が新規」と判定され、
 * 同一取引が新IDで 423 行二重追記された。健全な月次増分同期では走査分の
 * 大半は既存IDと一致して dedup されるはずで、新規はごく少数。新規率が
 * 異常に高い場合は ID 方式の不整合を疑い、サイレント二重追記をする前に
 * 明示エラーで停止させる（多ラウンドのデバッグをエラー1行に変換する）。
 */

/** 新規行の絶対数しきい値。これ未満なら比率が高くてもガードしない（小規模は誤検知回避）。 */
export const APPEND_GUARD_MIN_ABS = 50;
/** 走査ユニーク件数に対する新規行の許容比率。これ超で異常とみなす。 */
export const APPEND_GUARD_MAX_FRESH_RATIO = 0.5;

export interface AppendSafetyInput {
  /** フルモード（初回 / 空シート / --full）か。フルは全件追記が正常なので非対象。 */
  fullMode: boolean;
  /** シートに既存IDがあったか（増分照合が機能している前提）。 */
  hadExistingIds: boolean;
  /** 走査・重複排除後のユニーク件数。 */
  uniqueCount: number;
  /** 既存IDに無く新規追記しようとしている件数。 */
  freshCount: number;
}

export interface AppendSafetyVerdict {
  safe: boolean;
  /** freshCount / uniqueCount。ガード非対象時は 0。 */
  ratio: number;
  message: string;
}

export function assessAppendSafety(
  input: AppendSafetyInput,
): AppendSafetyVerdict {
  const { fullMode, hadExistingIds, uniqueCount, freshCount } = input;

  // フル初回・空シート・走査0件は「全件追記が正常」なのでガード対象外。
  if (fullMode || !hadExistingIds || uniqueCount === 0) {
    return { safe: true, ratio: 0, message: "guard 非対象（フル/初回/空）" };
  }

  const ratio = freshCount / uniqueCount;
  if (
    freshCount >= APPEND_GUARD_MIN_ABS &&
    ratio > APPEND_GUARD_MAX_FRESH_RATIO
  ) {
    return {
      safe: false,
      ratio,
      message:
        `増分同期なのに走査 ${uniqueCount} 件中 ${freshCount} 件 (${Math.round(
          ratio * 100,
        )}%) が新規です。ID 方式の不整合（旧式IDの残存・再計算移行の破綻）で` +
        `同一取引を新IDで二重追記しようとしている可能性が高い。` +
        `\`npm run doctor\` で保存ID vs 現行方式の一致率を確認し、` +
        `正当な大量差分なら \`--force\` で再実行、不整合なら再 sync 後に ` +
        `\`npm run dedupe-rows\` してください。`,
    };
  }

  return {
    safe: true,
    ratio,
    message: `OK（新規率 ${Math.round(ratio * 100)}%）`,
  };
}
