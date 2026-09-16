import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// Node ≥ 19 自带全局 crypto；此处兜底以保证 Web Crypto 在所有运行环境可用
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
