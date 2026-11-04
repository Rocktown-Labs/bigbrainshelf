// Portable incremental SHA-256: the factory has no Node compatibility flag.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export const createSha256 = () => sha256.create();
export const digestHex = bytesToHex;
export const sha256Hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
