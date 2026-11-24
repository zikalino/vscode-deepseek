// The saved-conversation list behind the chat's History surface.
//
// The harness draws the list but has no disk, so the host owns the file. The desktop shell keeps the
// same file-shaped rules in Rust; these are the rules, once: the host names a fresh conversation and
// stamps the time, keeps a title the user typed, and keeps the list newest first and bounded.

import type { Conversation } from "./protocol";

/** How many conversations the history keeps. Older ones fall off the end. */
export const HISTORY_LIMIT = 50;

/**
 * Fold a conversation the chat handed over into the list.
 *
 * `active` is the conversation the chat is in; an absent one means this snapshot starts a new
 * conversation, which the host names. A title already in the list wins over the suggested one, so a
 * rename survives the conversation moving on.
 */
export function mergeSnapshot(
  history: Conversation[],
  active: string | undefined,
  conversation: Conversation,
  now: number,
): { history: Conversation[]; active: string } {
  const id =
    active !== undefined && active.length > 0
      ? active
      : conversation.id.length > 0
        ? conversation.id
        : `conversation-${now}`;
  const existing = history.find((item) => item.id === id);
  const merged: Conversation = {
    ...conversation,
    id,
    updated: now,
    title: existing !== undefined && existing.title.length > 0 ? existing.title : conversation.title,
  };
  const rest = history.filter((item) => item.id !== id);
  rest.push(merged);
  rest.sort((a, b) => b.updated - a.updated);
  return { history: rest.slice(0, HISTORY_LIMIT), active: id };
}
