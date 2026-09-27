export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type MessageGroupState = {
  senderKey: string;
  createdAtMs: number;
  dayKey: string;
  breaksGroup: boolean;
};

function localDayKey(createdAtMs: number) {
  const date = new Date(createdAtMs);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function messageGroupState(senderKey: string, createdAt: string | number | Date, breaksGroup = false): MessageGroupState {
  const createdAtMs = createdAt instanceof Date
    ? createdAt.getTime()
    : typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  return {
    senderKey,
    createdAtMs,
    dayKey: Number.isFinite(createdAtMs) ? localDayKey(createdAtMs) : "",
    breaksGroup,
  };
}

export function shouldGroupMessage(previous: MessageGroupState | undefined, current: MessageGroupState, windowMs = MESSAGE_GROUP_WINDOW_MS) {
  if (!previous || previous.breaksGroup || current.breaksGroup) return false;
  if (!previous.senderKey || previous.senderKey === "unknown" || !current.senderKey || current.senderKey === "unknown") return false;
  if (!Number.isFinite(previous.createdAtMs) || !Number.isFinite(current.createdAtMs)) return false;
  return previous.senderKey === current.senderKey
    && previous.dayKey === current.dayKey
    && current.createdAtMs >= previous.createdAtMs
    && current.createdAtMs - previous.createdAtMs <= windowMs;
}
