/**
 * 月次 sync の「最終結果」を logs/last-sync-status.json に1ファイルで永続化し、
 * health-check がそれを読んで健全性を判定する。無人実行（タスクスケジューラ）が
 * 「成功扱いだが実は何も取れていない／何ヶ月も止まっている」状態を検知するため。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SyncStatus {
  ok: boolean;
  ts: string; // ISO 8601
  command: string;
  appended?: number; // 取引追記件数（分かる場合）
  error?: string;
}

/** cwd 非依存。app/core/ から見たプロジェクト直下 logs/。 */
export const SYNC_STATUS_PATH = fileURLToPath(
  new URL("../../logs/last-sync-status.json", import.meta.url),
);

export function writeSyncStatus(status: SyncStatus): void {
  mkdirSync(dirname(SYNC_STATUS_PATH), { recursive: true });
  writeFileSync(
    SYNC_STATUS_PATH,
    JSON.stringify(status, null, 2) + "\n",
    "utf8",
  );
}

export function readSyncStatus(): SyncStatus | null {
  try {
    return JSON.parse(readFileSync(SYNC_STATUS_PATH, "utf8")) as SyncStatus;
  } catch {
    return null;
  }
}

export interface HealthVerdict {
  healthy: boolean;
  /** 0=正常。非0は呼び出し元（CLI/PowerShell）の終了コードに使う。 */
  code: number;
  message: string;
}

/**
 * 純粋関数: 最終 sync 状態と現在時刻から健全性を判定する。
 * 日付・しきい値ロジックを単体テストできるよう副作用なしに分離している。
 * maxAgeDays 既定 40 は「月次ジョブ + 数日の猶予」。
 */
export function evaluateHealth(
  status: SyncStatus | null,
  now: Date,
  maxAgeDays = 40,
): HealthVerdict {
  if (!status) {
    return {
      healthy: false,
      code: 3,
      message:
        "sync 実行記録 (logs/last-sync-status.json) がありません。一度も成功していない可能性があります。",
    };
  }
  if (!status.ok) {
    return {
      healthy: false,
      code: 3,
      message: `直近の ${status.command} が失敗しています（${status.ts}）: ${status.error ?? "(詳細なし)"}`,
    };
  }
  const ageDays =
    (now.getTime() - new Date(status.ts).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > maxAgeDays) {
    return {
      healthy: false,
      code: 3,
      message: `最終成功が古すぎます（${status.ts}、約${Math.round(ageDays)}日前 > ${maxAgeDays}日）。月次タスクが起動していない可能性があります。`,
    };
  }
  if (status.appended === 0) {
    return {
      healthy: false,
      code: 3,
      message: `直近 sync は成功扱いですが追記0件（${status.ts}）。セッション失効や画面変更でスクレイプ不全の可能性があります。`,
    };
  }
  return {
    healthy: true,
    code: 0,
    message: `OK: 最終成功 ${status.ts}（約${Math.round(ageDays)}日前、追記${status.appended ?? "?"}件）`,
  };
}
