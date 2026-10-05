/** Parses the comma-separated ADMIN_IDS setting. Entries that aren't Telegram user IDs go in `invalid`. */
export function parseAdminIds(raw: string | undefined): { ids: number[]; invalid: string[] } {
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) ids.push(Number(s));
    else invalid.push(s);
  }
  return { ids, invalid };
}
