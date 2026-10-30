// Loads the prebuilt db-cross-v4 addon for this platform/arch. The shared
// worker calls it to decrypt the chat-history backup sent from the phone
// (decompressAndDecryptDb, decompressAndDecryptDb_V2) and in parseBinNet; if
// this file is missing the whole DECRYPT_BACKUP handler fails to register and
// sync ends with "Task type is not supported".
const path = require('path');

const base = path.join(__dirname, '..', 'prebuilt', process.platform, 'electron');
const candidates = [
    path.join(base, process.arch, 'db-cross-v4-native.node'),
    path.join(base, 'db-cross-v4-native.node'),
];

let lastError;
for (const file of candidates) {
    try {
        module.exports = require(file);
        lastError = null;
        break;
    } catch (e) {
        lastError = e;
    }
}
if (lastError) throw lastError;
