import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SelectorsSchema = z.object({
  table: z.array(z.string()).min(1),
  row: z.array(z.string()).min(1),
  cell: z.object({
    date: z.array(z.string()).min(1),
    content: z.array(z.string()).min(1),
    amount: z.array(z.string()).min(1),
    source: z.array(z.string()).min(1),
    category_large: z.array(z.string()).min(1),
    category_middle: z.array(z.string()).min(1),
  }),
  flags: z.object({
    is_transfer: z.object({
      classes: z.array(z.string()),
      text_marker: z.string(),
    }),
    is_excluded: z.object({
      classes: z.array(z.string()),
      children: z.array(z.string()),
    }),
  }),
  navigation: z.object({
    prev_month: z.array(z.string()).min(1),
    today: z.array(z.string()).min(1),
    header_title: z.array(z.string()).min(1),
  }),
});

export type TransactionsSelectors = z.infer<typeof SelectorsSchema>;

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = join(here, "selectors.yml");

let cached: TransactionsSelectors | null = null;

export function loadTransactionsSelectors(): TransactionsSelectors {
  if (cached) return cached;
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  cached = SelectorsSchema.parse(parsed);
  return cached;
}
