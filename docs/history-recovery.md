# Encrypted history recovery

Open **Settings → Recovery** on each device. Unlock the browser using its local encryption passphrase.

## Approve a new device

1. On the new device, choose **Request device approval**.
2. On a device that already reads your history, scan the QR or open/paste the approval link. Sign in to the same account.
3. Compare the verification codes shown on both devices. Approve only a request you created on a device you control.
4. Keep the new device's Recovery page open until it processes the keys. Open chat afterward; already-open chat tabs reload their cached keys and retry locked messages automatically.

Matching codes verify the approval request, not the availability of old message keys. Approval must come from a browser that can actually read the specific messages you want to recover. An import reporting zero new or earlier keys means that every supplied key was already present at the same or a better history position. It does not confirm that all locked history is recoverable. If messages remain locked, try an original device or an older backup that can read those messages; do not clear that device's local data.

If approval still leaves messages locked even though the original device can read them, expand **Messages still locked? Check history keys** on both devices and paste the same affected room URL. The check fetches up to 50 encrypted envelopes and tests decryption locally, bypassing the chat display cache. It reports readable messages, missing keys, keys that start too late, other errors, and exported session coverage. Only aggregate counts are displayed; keys, passphrases, and plaintext messages are not sent to the server or included in the summary.

Separate desktop clients bundle their own frontend and have their own key storage. Request approval **inside the desktop client** to recover its keys, then approve in the original browser. Server upgrades and browser refreshes do not update the installed desktop frontend; rebuild/reinstall that client separately when applying recovery fixes, without clearing its existing profile data.

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

To check a separately built desktop frontend against the same backend, set `HISTORY_RECOVERY_FRONTEND_ASSETS` to its generated asset directory when running `scripts/test-history-recovery.ts`. The test serves those assets only to the requesting client and exercises approval from the regular browser client, including received message history and local key diagnostics.
