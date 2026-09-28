import type { MessageEnvelope } from "./api";

function sameEnvelope(left: MessageEnvelope, right: MessageEnvelope) {
  return left.id === right.id
    && left.conversationId === right.conversationId
    && left.senderDeviceId === right.senderDeviceId
    && left.senderUserId === right.senderUserId
    && left.clientMessageId === right.clientMessageId
    && left.serverSequence === right.serverSequence
    && left.protocol === right.protocol
    && left.ciphertext === right.ciphertext
    && left.protocolMetadata === right.protocolMetadata
    && left.createdAt === right.createdAt;
}

/**
 * Checks whether a server's newest page agrees with the already-rendered
 * history and only contains matching cached messages plus any new tail.
 */
export function canReconcileLatestMessagePage(current: MessageEnvelope[], latestPage: MessageEnvelope[]) {
  if (current.length === 0 || latestPage.length === 0) return false;

  const currentById = new Map(current.map((message, index) => [message.id, { message, index }]));
  const currentLastSequence = BigInt(current[current.length - 1].serverSequence);
  if (BigInt(latestPage[latestPage.length - 1].serverSequence) < currentLastSequence) return false;

  let overlapCount = 0;
  let previousCurrentIndex = -1;
  for (const message of latestPage) {
    const cached = currentById.get(message.id);
    if (cached) {
      if (!sameEnvelope(cached.message, message) || cached.index <= previousCurrentIndex) return false;
      previousCurrentIndex = cached.index;
      overlapCount += 1;
    } else if (BigInt(message.serverSequence) <= currentLastSequence) {
      return false;
    }
  }

  return overlapCount > 0;
}
