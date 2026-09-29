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
    const created = await adminDb.begin(async (transaction) => {
      const [row] = await transaction<{ id: string }[]>`
        insert into admin_users (username, password_hash, role)
        values (${username}, ${passwordHash}, 'admin')
        returning id
      `;
      if (!row) throw new Error("Operator creation returned no row");
      await transaction`
        insert into admin_user_audit_logs (
          actor_username, target_admin_user_id, target_username, action, details
        ) values ('CLI', ${row.id}, ${username}, 'operator.created', '{"role":"admin","source":"cli"}'::jsonb)
      `;
      return row;
    });
    console.log(`Created host operator ${username} (${created.id}).`);
    return;
  }

  if (operation === "password") {
    const secret = await newPassword(useStdin);
    const passwordHash = await password.hash(secret);
    const operator = await adminDb.begin(async (transaction) => {
      const [row] = await transaction<{ id: string; username: string }[]>`
        update admin_users set password_hash = ${passwordHash}, updated_at = now()
        where username = ${username}
        returning id, username
      `;
      if (!row) return undefined;
      await transaction`delete from admin_sessions where admin_user_id = ${row.id}`;
      await transaction`
        insert into admin_user_audit_logs (
          actor_username, target_admin_user_id, target_username, action, details
        ) values ('CLI', ${row.id}, ${row.username}, 'operator.password_changed', '{"source":"cli"}'::jsonb)
      `;
      return row;
    });
    if (!operator) throw new Error(`No host operator named ${username} exists`);
    console.log(`Changed the password and revoked active sessions for ${username}.`);
    return;
  }

  if (useStdin) throw new Error("--password-stdin is only valid with create or password");
  if (operation === "disable" || operation === "enable") {
    const operator = await adminDb.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('admin-operator-management', 0))`;
      const [current] = await transaction<{
        id: string;
        username: string;
        role: "admin" | "moderator";
        disabled_at: Date | null;
      }[]>`
        select id, username, role, disabled_at from admin_users where username = ${username} for update
      `;
      if (!current) return undefined;
      const disable = operation === "disable";
      const wasDisabled = current.disabled_at !== null;
      if (disable === wasDisabled) return current;
      if (disable && current.role === "admin") {
        const [activeAdmins] = await transaction<{ count: string }[]>`
          select count(*)::text as count from admin_users where role = 'admin' and disabled_at is null
        `;
        if (Number(activeAdmins?.count ?? 0) <= 1) {
          throw new Error("Cannot disable the last active Admin operator");
        }
      }
      await transaction`
        update admin_users
        set disabled_at = ${disable ? new Date() : null}, updated_at = now()
        where id = ${current.id}
      `;
      if (disable) await transaction`delete from admin_sessions where admin_user_id = ${current.id}`;
      await transaction`
        insert into admin_user_audit_logs (
          actor_username, target_admin_user_id, target_username, action, details
        ) values (
          'CLI', ${current.id}, ${current.username}, ${disable ? "operator.disabled" : "operator.enabled"},
          '{"source":"cli"}'::jsonb
        )
      `;
      return current;
    });
    if (!operator) throw new Error(`No host operator named ${username} exists`);
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
