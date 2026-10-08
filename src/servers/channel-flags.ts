/**
 * Room content markers.
 *
 * The adult-content marker is one-way. Once a room is marked, nothing may clear it: a marked room
 * cannot be quietly un-marked, which would let the warning be dropped after people have already been
 * shown what is behind it. Archiving the room is the way to stop using it.
 *
 * The spoiler marker is a presentation preference with no such history, so it stays reversible.
 */

export type ChannelFlagChange = "none" | "apply" | "refuse_permanent";

/**
 * Decides what a requested marker change means for a room's current state.
 *
 * Marking an unmarked room, re-sending the marker a room already has, and changing the spoiler marker
 * are all ordinary updates. Only clearing an adult-content mark is refused.
 */
export function channelFlagChange(current: boolean | undefined, requested: boolean | undefined, permanent: boolean): ChannelFlagChange {
  if (requested === undefined || requested === current) return "none";
  if (!requested && permanent && current === true) return "refuse_permanent";
  return "apply";
}