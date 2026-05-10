import { z } from "zod";

export const RawTransactionSchema = z.object({
  date: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/, "date must be YYYY/MM/DD"),
  content: z.string().min(1),
  amount: z.string(),
  source: z.string(),
  category: z.string(),
});

export const TransactionSchema = RawTransactionSchema.extend({
  id: z.string().length(64, "id must be SHA256 hex (64 chars)"),
});

export type RawTransaction = z.infer<typeof RawTransactionSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
