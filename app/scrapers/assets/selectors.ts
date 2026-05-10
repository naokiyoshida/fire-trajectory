import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SelectorsSchema = z.object({
  total_box: z.array(z.string()).min(1),
  summary_table: z.array(z.string()).min(1),
  summary_row: z.string(),
  summary_label: z.string(),
  summary_amount: z.string(),
  asset_categories: z.record(z.string(), z.string()),
  liability_categories: z.record(z.string(), z.string()),
});

export type AssetsSelectors = z.infer<typeof SelectorsSchema>;

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = join(here, "selectors.yml");

let cached: AssetsSelectors | null = null;

export function loadAssetsSelectors(): AssetsSelectors {
  if (cached) return cached;
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  cached = SelectorsSchema.parse(parsed);
  return cached;
}
