# Encrypted history recovery

Open **Settings → Recovery** on each device. Unlock the browser using its local encryption passphrase.

## Approve a new device

1. On the new device, choose **Request device approval**.
2. On a device that already reads your history, scan the QR or open/paste the approval link. Sign in to the same account.
3. Compare the verification codes shown on both devices. Approve only a request you created on a device you control.
4. Keep the new device's Recovery page open until it imports the keys. Reopen the conversation afterward.

Requests expire after ten minutes. Closing the requesting page discards its secret; create a new request if needed. Treat approval links as private. The secret is in the URL fragment, is removed from the trusted device's address bar, and is not sent to the server. Transfer payloads are encrypted and imports delete completed requests. Revocation of either participating device blocks delivery of queued payloads.

## Enable a backup

On a device that has your history, choose **Set up recovery key**, save the generated key in a password manager, confirm it is saved, then enable the backup. Your account password is not a recovery key. Naigi cannot replace a lost key or recover history when every device and recovery copy is lost.

An enabled, unlocked browser merges and uploads encrypted room keys every minute. **Back up now** performs an immediate sync. Revision checks prevent concurrent devices from silently overwriting each other's keys; conflicts retry on the next cycle. Approval also transfers access to the existing automatic backup, if enabled.

On a new device, enter the saved key under **Restore an existing backup**. This imports the available keys and enables backup updates on that browser. The recovery key itself is not remembered. A backup data key is stored locally only inside an encrypted IndexedDB envelope protected by the browser's local encryption passphrase. Clearing local data removes that envelope. Locking/closing stops background updates.

**Delete server backup** removes the account's current encrypted backup, not keys already held by devices. Other devices stop updating it when they next sync. A replacement backup needs a new recovery key. Manual passphrase-protected file export/import remains available in the expandable section.

## Limits and security

- Backups contain room keys, not message bodies. Message history still comes from PostgreSQL and must remain available there. Only keys known to participating devices can be recovered.
- Devices must be online and unlocked to upload newly learned keys. A device lost before its next upload may have keys absent from the backup.
- The server stores opaque ciphertext, backup metadata, device identifiers, and a hash of each transfer secret. It cannot decrypt room keys or recovery secrets.
- Revocation cannot erase keys a device already received. Account authentication alone does not prove possession of room keys; approval explicitly releases history to another browser.
- Recovery assumes trusted browser code. Compromised devices or malicious code served by the host can read secrets while the browser is unlocked. Server-side deletion or rollback can also make a backup unavailable or stale.

Run `bun run test:history-recovery` for the isolated PostgreSQL/Chromium recovery integration test; it builds the client and creates/removes temporary app/admin schemas.
