/**
 * Invite tokens.
 *
 * Only a SHA-256 hash of the token is stored, so a database read does not yield a usable invite
 * link. Comparison happens on the hash and the single-use redemption is serialised with a row lock.
 */

export function newInviteToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export async function hashInviteToken(token: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}
