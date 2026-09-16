import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type StoredPackage } from '../../src/lib/db';
import { freshStore, makePackage, makePayload } from '../helpers';

let store: Store;

beforeEach(async () => {
  store = await freshStore();
});

afterEach(() => {
  store.close();
});

describe('IndexedDB 持久层', () => {
  it('初始状态：无激活、无暂存、无分块', async () => {
    expect(await store.getActiveVersion()).toBeNull();
    expect(await store.getStaging()).toBeNull();
    expect(await store.countChunks()).toBe(0);
    expect(await store.listPackageVersions()).toEqual([]);
  });

  it('分块写入与读取（独立事务检查点）', async () => {
    const data = new Uint8Array([9, 8, 7]).buffer;
    await store.putChunk({ index: 3, hash: 'h3', data });
    const got = await store.getChunk(3);
    expect(got?.hash).toBe('h3');
    expect(Array.from(new Uint8Array(got!.data))).toEqual([9, 8, 7]);
    expect(await store.getChunk(4)).toBeNull();
    expect(await store.countChunks()).toBe(1);
  });

  it('getAllChunks 按编号升序返回', async () => {
    await store.putChunk({ index: 2, hash: 'h2', data: new ArrayBuffer(1) });
    await store.putChunk({ index: 0, hash: 'h0', data: new ArrayBuffer(1) });
    await store.putChunk({ index: 1, hash: 'h1', data: new ArrayBuffer(1) });
    const all = await store.getAllChunks();
    expect(all.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('activate 单事务完成：写包记录 + 切换 active + 清除暂存', async () => {
    const { manifest } = await makePackage('v1', makePayload(1, 100));
    await store.setStaging({ manifest, updatedAt: new Date().toISOString() });
    await store.putChunk({ index: 0, hash: manifest.chunkHashes[0], data: new ArrayBuffer(4) });

    const pkg: StoredPackage = {
      version: manifest.version,
      payloadSize: manifest.payloadSize,
      sha256: manifest.sha256,
      chunkHashes: manifest.chunkHashes,
      data: new Uint8Array([1, 2, 3]).buffer,
      installedAt: new Date().toISOString(),
    };
    await store.activate(pkg);

    expect(await store.getActiveVersion()).toBe('v1');
    expect(await store.getStaging()).toBeNull();
    expect(await store.countChunks()).toBe(0);
    expect(await store.listPackageVersions()).toEqual(['v1']);
    const saved = await store.getPackage('v1');
    expect(saved?.sha256).toBe(manifest.sha256);
  });

  it('同一版本重复 activate 不产生第二份记录', async () => {
    const pkg: StoredPackage = {
      version: 'v1',
      payloadSize: 3,
      sha256: 'a'.repeat(64),
      chunkHashes: ['b'.repeat(64)],
      data: new Uint8Array([1, 2, 3]).buffer,
      installedAt: new Date().toISOString(),
    };
    await store.activate(pkg);
    await store.activate({ ...pkg, installedAt: new Date().toISOString() });
    expect(await store.listPackageVersions()).toEqual(['v1']);
  });

  it('discardStaging 只清暂存，不动激活版本与包记录', async () => {
    const { manifest } = await makePackage('v1', makePayload(1, 10));
    const pkg: StoredPackage = {
      version: 'v1',
      payloadSize: 10,
      sha256: manifest.sha256,
      chunkHashes: manifest.chunkHashes,
      data: new ArrayBuffer(10),
      installedAt: new Date().toISOString(),
    };
    await store.activate(pkg);

    const { manifest: m2 } = await makePackage('v2', makePayload(2, 20));
    await store.setStaging({ manifest: m2, updatedAt: new Date().toISOString() });
    await store.putChunk({ index: 0, hash: m2.chunkHashes[0], data: new ArrayBuffer(4) });

    await store.discardStaging();
    expect(await store.getStaging()).toBeNull();
    expect(await store.countChunks()).toBe(0);
    expect(await store.getActiveVersion()).toBe('v1');
    expect(await store.listPackageVersions()).toEqual(['v1']);
  });
});
