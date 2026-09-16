import { DB_NAME, Store } from '../src/lib/db';
import { CHUNK_SIZE, type Manifest } from '../src/lib/manifest';
import { sha256Hex } from '../src/lib/sha256';

/** 删除数据库并打开全新实例（调用方需在 afterEach 关闭返回的 Store）。 */
export async function freshStore(): Promise<Store> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase 被阻塞：存在未关闭的连接'));
  });
  return Store.open();
}

/** 确定性伪随机载荷（LCG），便于构造可复现的测试数据。 */
export function makePayload(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

export interface TestPackage {
  manifest: Manifest;
  payload: Blob;
  bytes: Uint8Array;
}

/** 由载荷真实计算清单（分块散列 + 整包散列）。 */
export async function makePackage(version: string, bytes: Uint8Array): Promise<TestPackage> {
  const chunkHashes: string[] = [];
  for (let off = 0; off < bytes.length; off += CHUNK_SIZE) {
    chunkHashes.push(await sha256Hex(bytes.subarray(off, off + CHUNK_SIZE)));
  }
  const sha256 = await sha256Hex(bytes);
  return {
    manifest: { version, payloadSize: bytes.length, sha256, chunkHashes },
    payload: new Blob([bytes]),
    bytes,
  };
}

/** 数据库现场快照，用于断言“未改写现场”。 */
export interface DbSnapshot {
  active: string | null;
  staging: { version: string; payloadSize: number; sha256: string } | null;
  chunkCount: number;
  packageVersions: string[];
}

export async function snapshot(store: Store): Promise<DbSnapshot> {
  const [active, staging, chunkCount, packageVersions] = await Promise.all([
    store.getActiveVersion(),
    store.getStaging(),
    store.countChunks(),
    store.listPackageVersions(),
  ]);
  return {
    active,
    staging: staging
      ? {
          version: staging.manifest.version,
          payloadSize: staging.manifest.payloadSize,
          sha256: staging.manifest.sha256,
        }
      : null,
    chunkCount,
    packageVersions: [...packageVersions].sort(),
  };
}
