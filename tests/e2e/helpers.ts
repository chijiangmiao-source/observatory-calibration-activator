import crypto from 'node:crypto';
import type { Page } from '@playwright/test';

export const CHUNK_SIZE = 1_048_576;

/** 确定性伪随机载荷（LCG）。 */
export function makePayload(seed: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

export interface ManifestJson {
  version: string;
  payloadSize: number;
  sha256: string;
  chunkHashes: string[];
}

/** 由载荷真实计算清单。 */
export function makeManifest(payload: Buffer, version: string): ManifestJson {
  const chunkHashes: string[] = [];
  for (let off = 0; off < payload.length; off += CHUNK_SIZE) {
    chunkHashes.push(
      crypto.createHash('sha256').update(payload.subarray(off, off + CHUNK_SIZE)).digest('hex'),
    );
  }
  return {
    version,
    payloadSize: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    chunkHashes,
  };
}

/** 通过真实文件输入选择清单与载荷。 */
export async function selectFiles(
  page: Page,
  manifest: unknown,
  payload: Buffer,
): Promise<void> {
  await page.locator('#manifest-input').setInputFiles({
    name: 'manifest.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await page.locator('#payload-input').setInputFiles({
    name: 'payload.bin',
    mimeType: 'application/octet-stream',
    buffer: payload,
  });
}

export interface IdbSnapshot {
  active: string | null;
  stagingVersion: string | null;
  chunks: number;
  packages: number;
  packageVersions: string[];
}

/** 直接读取浏览器内 IndexedDB 的真实持久化状态。 */
export async function idbSnapshot(page: Page): Promise<IdbSnapshot> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('calibration-package-store');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const count = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const rq = db.transaction(name, 'readonly').objectStore(name).count();
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    const metaGet = (key: string) =>
      new Promise<Record<string, unknown> | null>((resolve, reject) => {
        const rq = db.transaction('meta', 'readonly').objectStore('meta').get(key);
        rq.onsuccess = () => resolve((rq.result as Record<string, unknown>) ?? null);
        rq.onerror = () => reject(rq.error);
      });
    const versions = await new Promise<string[]>((resolve, reject) => {
      const rq = db.transaction('packages', 'readonly').objectStore('packages').getAllKeys();
      rq.onsuccess = () => resolve(rq.result.map(String));
      rq.onerror = () => reject(rq.error);
    });
    const active = await metaGet('active');
    const staging = await metaGet('staging');
    const snap: IdbSnapshot = {
      active: active ? (active.version as string) : null,
      stagingVersion: staging
        ? ((staging.manifest as { version: string }).version ?? null)
        : null,
      chunks: await count('chunks'),
      packages: await count('packages'),
      packageVersions: versions.sort(),
    };
    db.close();
    return snap;
  });
}
