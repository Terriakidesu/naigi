import { ApiClient } from "../../client/api";
import { CryptoClient } from "../../client/crypto";
import { randomRecoverySecret, recoveryKeyText } from "../../client/history-recovery-crypto";

const api = new ApiClient();
let client: CryptoClient;
Object.assign(window, { historyTest: {
  async initialize() {
    if (client) return client.deviceId;
    const { user } = await api.me();
    client = new CryptoClient(api, user.id, "history-test-local-passphrase");
    await client.initialize();
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
    return { serverId: server.id, conversationId: channel.conversationId, encrypted };
  },
  decrypt: (id: string, encrypted: string) => client.decryptMetadata(id, encrypted),
  enable: async () => {
    const key = recoveryKeyText(randomRecoverySecret());
    await client.enableHistoryBackup(key);
    return key;
  },
  restore: (key: string) => client.restoreHistoryBackup(key),
  backup: () => client.backupHistoryNow(),
  request: () => client.requestHistoryDeviceTransfer(),
  approve: (pairing: Parameters<CryptoClient["approveHistoryDeviceTransfer"]>[0]) => client.approveHistoryDeviceTransfer(pairing),
  finish: (pairing: Parameters<CryptoClient["finishHistoryDeviceTransfer"]>[0]) => client.finishHistoryDeviceTransfer(pairing),
  stop: () => client.close(),
} });
