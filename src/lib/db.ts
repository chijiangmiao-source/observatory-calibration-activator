/**
 * IndexedDB 持久层。
 *
 * 三个对象仓库：
 *  - chunks   （keyPath 'index'）    暂存分块检查点，每块以独立事务写入
 *  - packages （keyPath 'version'）  已安装的整包记录，按版本去重
 *  - meta     （keyPath 'key'）      'staging' 暂存清单 与 'active' 唯一激活指针
 */

import type { Manifest } from './manifest';

export const DB_NAME = 'calibration-package-store';
export const DB_VERSION = 1;

export interface StoredChunk {
  index: number;
  hash: string;
  data: ArrayBuffer;
}

export interface StoredPackage {
  version: string;
  payloadSize: number;
  sha256: string;
  chunkHashes: string[];
  data: ArrayBuffer;
  installedAt: string;
}

export interface StagingState {
  manifest: Manifest;
  updatedAt: string;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
  });
}

interface MetaRow {
  key: string;
  [k: string]: unknown;
}

export class Store {
  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<Store> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('chunks')) {
          db.createObjectStore('chunks', { keyPath: 'index' });
        }
        if (!db.objectStoreNames.contains('packages')) {
          db.createObjectStore('packages', { keyPath: 'version' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(new Store(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  close(): void {
    this.db.close();
  }

  private tx(stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
    return this.db.transaction(stores, mode);
  }

  private metaGet(key: string): Promise<MetaRow | undefined> {
    return reqToPromise(this.tx('meta', 'readonly').objectStore('meta').get(key));
  }

  async getStaging(): Promise<StagingState | null> {
    const row = await this.metaGet('staging');
    return row ? { manifest: row.manifest as Manifest, updatedAt: row.updatedAt as string } : null;
  }

  /** 暂存清单独立落库，先于任何分块写入。 */
  async setStaging(state: StagingState): Promise<void> {
    const tx = this.tx('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'staging', ...state });
    await txDone(tx);
  }

  async getActiveVersion(): Promise<string | null> {
    const row = await this.metaGet('active');
    return row ? (row.version as string) : null;
  }

  async getPackage(version: string): Promise<StoredPackage | null> {
    const row = await reqToPromise(
      this.tx('packages', 'readonly').objectStore('packages').get(version),
    );
    return (row as StoredPackage | undefined) ?? null;
  }

  async listPackageVersions(): Promise<string[]> {
    const keys = await reqToPromise(this.tx('packages', 'readonly').objectStore('packages').getAllKeys());
    return keys.map(String);
  }

  async getChunk(index: number): Promise<StoredChunk | null> {
    const row = await reqToPromise(this.tx('chunks', 'readonly').objectStore('chunks').get(index));
    return (row as StoredChunk | undefined) ?? null;
  }

  async getAllChunks(): Promise<StoredChunk[]> {
    const all = (await reqToPromise(
      this.tx('chunks', 'readonly').objectStore('chunks').getAll(),
    )) as StoredChunk[];
    return all.sort((a, b) => a.index - b.index);
  }

  countChunks(): Promise<number> {
    return reqToPromise(this.tx('chunks', 'readonly').objectStore('chunks').count());
  }

  /** 单块检查点：散列通过后，以独立事务写入。 */
  async putChunk(chunk: StoredChunk): Promise<void> {
    const tx = this.tx('chunks', 'readwrite');
    tx.objectStore('chunks').put(chunk);
    await txDone(tx);
  }

  /** 放弃暂存：清空分块与暂存清单，不触碰激活指针与已安装包。 */
  async discardStaging(): Promise<void> {
    const tx = this.tx(['chunks', 'meta'], 'readwrite');
    tx.objectStore('chunks').clear();
    tx.objectStore('meta').delete('staging');
    await txDone(tx);
  }

  /**
   * 单事务激活：写入整包记录 + 切换唯一 active 指针 + 清除暂存。
   * 任一步失败整个事务回滚，现场保持旧状态。
   */
  async activate(pkg: StoredPackage): Promise<void> {
    const tx = this.tx(['packages', 'meta', 'chunks'], 'readwrite');
    tx.objectStore('packages').put(pkg);
    tx.objectStore('meta').put({ key: 'active', version: pkg.version });
    tx.objectStore('meta').delete('staging');
    tx.objectStore('chunks').clear();
    await txDone(tx);
  }
}
