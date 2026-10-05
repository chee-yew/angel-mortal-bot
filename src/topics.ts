import type { Participant, Role } from "./db";

/**
 * Each participant has two tabs (topics) in their chat with the bot, one per partner. The name is
 * the header shown while chatting, so it spells out who's who; the Mortal tab names its person.
 */
export function tabName(role: Role, mortalHandle: string | null): string {
  if (role === "angel") return "😇 Angel: secret (cares for you)";
  return mortalHandle ? `🙂 Mortal: @${mortalHandle} (you care for them)` : "🙂 Mortal: none assigned";
}

/** How messages refer to each tab. */
export const TAB_LABEL: Record<Role, string> = {
  angel: "😇 Angel tab",
  mortal: "🙂 Mortal tab",
};

/** Topic icon colours; Telegram only accepts a fixed set. */
export const TAB_COLOR = {
  angel: 0xffd67e, // yellow
  mortal: 0x6fb9f0, // blue
} as const satisfies Record<Role, number>;

export const ROLES: readonly Role[] = ["angel", "mortal"];

type Tabs = Pick<Participant, "angel_thread_id" | "mortal_thread_id">;

/** The thread id of `p`'s tab for talking to their `role`, or null if it hasn't been created. */
export function threadIdFor(p: Tabs, role: Role): number | null {
  return role === "angel" ? p.angel_thread_id : p.mortal_thread_id;
}

/** Which partner a message sent in thread `threadId` is for, or null if it's not one of `p`'s tabs. */
export function roleForThread(p: Tabs, threadId: number | undefined): Role | null {
  if (threadId === undefined) return null;
  if (threadId === p.angel_thread_id) return "angel";
  if (threadId === p.mortal_thread_id) return "mortal";
  return null;
}
