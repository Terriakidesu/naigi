import { ApiClient } from "../../client/api";
import { CryptoClient } from "../../client/crypto";
import { randomRecoverySecret, recoveryKeyText } from "../../client/history-recovery-crypto";

const api = new ApiClient();
let client: CryptoClient;
Object.assign(window, { historyTest: {
  async initialize(syncToDevice = true) {
    if (client) return client.deviceId;
    const { user } = await api.me();
    client = new CryptoClient(api, user.id, "history-test-local-passphrase");
    await client.initialize({ syncToDevice });
    return client.deviceId;
  },
  async seed() {
    const { server, channel } = await api.createServer();
    const { members } = await api.conversationMembers(channel.conversationId);
    const encrypted = await client.encryptMetadata(channel.conversationId, members, {
      name: "private history fixture", description: "Saved private description",
      welcome: { enabled: true, heading: "Welcome, team", description: "Start in general", rules: "Be respectful", acknowledgement: true },
    });
    await api.updateServer(server.id, encrypted);
    const sent = await client.sendText(channel.conversationId, members, "recover this older message", []);
    if (sent.delivery !== "sent") throw new Error("fixture_message_not_sent");
    return { serverId: server.id, channelId: channel.id, conversationId: channel.conversationId, encrypted, message: sent.message };
  },
  decrypt: (id: string, encrypted: string) => client.decryptMetadata(id, encrypted),
  async sendBatch(conversationId: string) {
    const { members } = await api.conversationMembers(conversationId);
    const messages = [];
    for (let index = 0; index < 50; index += 1) {
      const result = await client.sendText(conversationId, members, `received older message ${index}`, []);
      if (result.delivery !== "sent") throw new Error("fixture_message_not_sent");
      messages.push(result.message);
    }
    return messages;
  },
  sync: () => client.syncToDevice(),
  decryptMessage: (message: Parameters<CryptoClient["decryptMessage"]>[1]) => client.decryptMessage(message.conversationId, message),
  enable: async () => {
    const key = recoveryKeyText(randomRecoverySecret());
    await client.enableHistoryBackup(key);
    return key;
  },
  restore: (key: string) => client.restoreHistoryBackup(key),
  backup: () => client.backupHistoryNow(),
  hasBackup: () => client.hasHistoryBackupKey,
  request: () => client.requestHistoryDeviceTransfer(),
  approve: (pairing: Parameters<CryptoClient["approveHistoryDeviceTransfer"]>[0]) => client.approveHistoryDeviceTransfer(pairing),
  finish: (pairing: Parameters<CryptoClient["finishHistoryDeviceTransfer"]>[0]) => client.finishHistoryDeviceTransfer(pairing),
  stop: () => client.close(),
} });
