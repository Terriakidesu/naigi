/**
 * Password screening for newly chosen passwords.
 *
 * Length is enforced by the route schema; this module rejects the passwords that credential
 * stuffing lists reach first and the ones trivially derived from the account being registered.
 * It runs on registration and password change only, so existing credentials are never affected.
 */

// A deliberately small, offline list of the passwords that appear at the top of public
// credential-stuffing corpora. Keeping it inline avoids a network fetch on the auth path.
const commonPasswords = new Set([
  "000000000000", "111111111111", "121212121212", "123123123123", "123456123456",
  "123456789012", "123456789123", "1234567890ab", "1q2w3e4r5t6y", "1qaz2wsx3edc",
  "abcd1234abcd", "adminadmin12", "administrator", "asdfghjkl123", "baseball1234",
  "changeme1234", "dragon123456", "football1234", "hunter200000", "iloveyou1234",
  "jennifer1234", "letmein12345", "monkey123456", "mypassword123", "naigi1234567",
  "naigipassword", "p@ssw0rd1234", "passw0rd1234", "password1234", "password123!",
  "princess1234", "qazwsxedcrfv", "qwerty123456", "qwertyuiop12", "secretsecret12",
  "starwars1234", "sunshine1234", "sunshine2000", "superman1234", "testtest1234",
  "trustno12345", "welcome12345", "zxcvbnm12345",
]);

export type PasswordRejection = "password_too_common" | "password_too_similar";

function collapse(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

/**
 * Returns a rejection reason, or `undefined` when the password is acceptable.
 * `username` and `displayName` are optional; when supplied, a password built from them is
 * rejected even if it clears the length rule.
 */
export function screenPassword(candidate: string, identity?: { username?: string; displayName?: string }) {
  const normalized = collapse(candidate);

  if (commonPasswords.has(normalized)) return "password_too_common" as const;

  // Reject a password that embeds the identity and is not substantially longer than it, such as
  // "naigi2024" or a username followed by a short run of digits. A password that carries the
  // identity plus a genuinely long independent secret is left alone.
  for (const value of [identity?.username, identity?.displayName]) {
    if (!value) continue;
    const normalizedIdentity = collapse(value).replace(/[^a-z0-9]/g, "");
    if (normalizedIdentity.length < 3) continue;

    const stripped = normalized.replace(/[^a-z0-9]/g, "");
    if (stripped.includes(normalizedIdentity) && stripped.length < normalizedIdentity.length * 2) {
      return "password_too_similar" as const;
    }
  }

  return undefined;
}
