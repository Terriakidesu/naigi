import { password } from "bun";
import { adminDb, closeAdminDatabase } from "../src/admin-db/client";
import { normalizeAdminUsername } from "../src/admin-auth/session";

const input = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };

function readSecret(label: string) {
  if (!input.isTTY || !input.setRawMode) {
    throw new Error("This shell has no interactive terminal; pipe two password lines with --password-stdin");
  }

  return new Promise<string>((resolve, reject) => {
    process.stdout.write(`${label}: `);
    input.setRawMode!(true);
    input.resume();
    let value = "";
    const decoder = new TextDecoder();

    const finish = (error?: Error) => {
      input.removeListener("data", onData);
      input.setRawMode!(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: Buffer) => {
      for (const character of decoder.decode(chunk, { stream: true })) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("Password entry cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (!/[\u0000-\u001f\u007f]/.test(character)) {
          value += character;
        }
      }
    };

    input.on("data", onData);
  });
}

async function readSecretsFromStdin() {
  if (input.isTTY) throw new Error("--password-stdin requires password lines piped to stdin");
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  const contents = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  const lines = contents.split(/\r?\n/);
  if (lines.length !== 2) throw new Error("Provide the password and confirmation as two newline-separated stdin lines");
  return lines;
}

async function newPassword(useStdin: boolean) {
  const [secret, confirmation] = useStdin
    ? await readSecretsFromStdin()
    : [await readSecret("New operator password"), await readSecret("Confirm operator password")];
  if (secret.length < 12 || secret.length > 1_024) throw new Error("Password must be between 12 and 1024 characters");
  if (secret !== confirmation) throw new Error("Passwords do not match");
  return secret;
}

async function run() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const useStdin = args.includes("--password-stdin");
  const [operation, rawUsername, ...extra] = args.filter((argument) => argument !== "--password-stdin");
  if (extra.length || !operation || !rawUsername) {
    throw new Error("Usage: bun run admin-users -- create|disable|enable|password <username> [--password-stdin]");
  }
  const username = normalizeAdminUsername(rawUsername);
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error("Username must contain 3-32 letters, numbers, underscores, periods, or hyphens");
  }

  if (operation === "create") {
    const secret = await newPassword(useStdin);
    const passwordHash = await password.hash(secret);
    const [created] = await adminDb<{ id: string }[]>`
      insert into admin_users (username, password_hash)
      values (${username}, ${passwordHash})
      returning id
    `;
    console.log(`Created host operator ${username} (${created.id}).`);
    return;
  }

  if (operation === "password") {
    const secret = await newPassword(useStdin);
    const passwordHash = await password.hash(secret);
    const [operator] = await adminDb<{ id: string }[]>`
      update admin_users set password_hash = ${passwordHash}, updated_at = now()
      where username = ${username}
      returning id
    `;
    if (!operator) throw new Error(`No host operator named ${username} exists`);
    await adminDb`delete from admin_sessions where admin_user_id = ${operator.id}`;
    console.log(`Changed the password and revoked active sessions for ${username}.`);
    return;
  }

  if (useStdin) throw new Error("--password-stdin is only valid with create or password");
  if (operation === "disable" || operation === "enable") {
    const [operator] = await adminDb<{ id: string }[]>`
      update admin_users
      set disabled_at = ${operation === "disable" ? new Date() : null}, updated_at = now()
      where username = ${username}
      returning id
    `;
    if (!operator) throw new Error(`No host operator named ${username} exists`);
    if (operation === "disable") await adminDb`delete from admin_sessions where admin_user_id = ${operator.id}`;
    console.log(`${operation === "disable" ? "Disabled" : "Enabled"} host operator ${username}.`);
    return;
  }

  throw new Error("Operation must be create, disable, enable, or password");
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to update host operators");
  process.exitCode = 1;
} finally {
  await closeAdminDatabase();
}
