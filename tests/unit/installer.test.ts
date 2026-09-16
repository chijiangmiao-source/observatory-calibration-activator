import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/lib/db';
import { CHUNK_SIZE } from '../../src/lib/manifest';
import { sha256Hex } from '../../src/lib/sha256';
import { install, InstallError, type ChunkEvent } from '../../src/lib/installer';
import { freshStore, makePackage, makePayload, snapshot } from '../helpers';

let store: Store;

beforeEach(async () => {
  store = await freshStore();
});

afterEach(() => {
  store.close();
});

const FOUR_CHUNKS = 3 * CHUNK_SIZE + 123; // 4 块，末块取余

describe('安装引擎：完整安装', () => {
  it('全部块校验通过后单事务激活并清除暂存', async () => {
    const { manifest, payload, bytes } = await makePackage('v1.0.0', makePayload(7, FOUR_CHUNKS));
    const events: ChunkEvent[] = [];

    const outcome = await install(store, {
      manifest,
      payload,
      onChunk: (e) => events.push(e),
    });

    expect(outcome).toEqual({ status: 'installed', version: 'v1.0.0', reused: 0, written: 4, rewritten: 0 });
    expect(events.map((e) => e.action)).toEqual(['written', 'written', 'written', 'written']);
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3]);

    // 激活后的数据库状态
    expect(await store.getActiveVersion()).toBe('v1.0.0');
    expect(await store.getStaging()).toBeNull();
    expect(await store.countChunks()).toBe(0);
    expect(await store.listPackageVersions()).toEqual(['v1.0.0']);

    const pkg = await store.getPackage('v1.0.0');
    expect(pkg?.payloadSize).toBe(FOUR_CHUNKS);
    expect(pkg?.sha256).toBe(manifest.sha256);
    // 落库的整包字节与原始载荷一致
    expect(await sha256Hex(new Uint8Array(pkg!.data))).toBe(await sha256Hex(bytes));
  });

  it('载荷文件大小与清单不符时拒绝且不落任何数据', async () => {
    const { manifest } = await makePackage('v1', makePayload(1, CHUNK_SIZE));
    const wrongPayload = new Blob([makePayload(1, CHUNK_SIZE - 1)]);
    const err = await install(store, { manifest, payload: wrongPayload }).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('SIZE_MISMATCH');
    expect((err as InstallError).message).toContain('载荷大小不符');
    expect(await snapshot(store)).toEqual({
      active: null,
      staging: null,
      chunkCount: 0,
      packageVersions: [],
    });
  });
});

describe('安装引擎：故障注入与断点续作', () => {
  it('第 N 块提交后“断电”，重开后仅复验并补写缺失块', async () => {
    const { manifest, payload } = await makePackage('v2.0.0', makePayload(11, FOUR_CHUNKS));

    // 第一次运行：第 1 块提交后刷新
    let reloads = 0;
    const first = await install(store, {
      manifest,
      payload,
      crashAfterChunk: 1,
      onReload: () => reloads++,
    });
    expect(first).toEqual({ status: 'reloading', afterChunk: 1 });
    expect(reloads).toBe(1);

    // 崩溃现场：块 0、1 已提交，暂存清单在，active 未动
    expect(await store.countChunks()).toBe(2);
    expect((await store.getChunk(0))?.hash).toBe(manifest.chunkHashes[0]);
    expect((await store.getChunk(1))?.hash).toBe(manifest.chunkHashes[1]);
    expect((await store.getStaging())?.manifest.version).toBe('v2.0.0');
    expect(await store.getActiveVersion()).toBeNull();

    // 重开后用户重选同一文件：仅复验已有块、补写缺失块
    const events: ChunkEvent[] = [];
    const second = await install(store, { manifest, payload, onChunk: (e) => events.push(e) });
    expect(second).toEqual({ status: 'installed', version: 'v2.0.0', reused: 2, written: 2, rewritten: 0 });
    expect(events.map((e) => e.action)).toEqual(['reused', 'reused', 'written', 'written']);
    expect(await store.getActiveVersion()).toBe('v2.0.0');
    expect(await store.countChunks()).toBe(0);
  });

  it('续作时发现已暂存块损坏则重写该块', async () => {
    const { manifest, payload } = await makePackage('v3.0.0', makePayload(13, FOUR_CHUNKS));

    await install(store, { manifest, payload, crashAfterChunk: 1, onReload: () => {} });
    // 模拟已提交检查点在断电瞬间被写坏
    await store.putChunk({ index: 0, hash: 'corrupted', data: new Uint8Array([1, 2, 3]).buffer });

    const events: ChunkEvent[] = [];
    const outcome = await install(store, { manifest, payload, onChunk: (e) => events.push(e) });
    expect(outcome).toEqual({ status: 'installed', version: 'v3.0.0', reused: 1, written: 2, rewritten: 1 });
    expect(events.map((e) => e.action)).toEqual(['rewritten', 'reused', 'written', 'written']);
    expect(await store.getActiveVersion()).toBe('v3.0.0');
  });

  it('续作清单 version/payloadSize/sha256 任一不符即拒绝混用且不改写现场', async () => {
    const bytes = makePayload(17, FOUR_CHUNKS);
    const staged = await makePackage('v4.0.0', bytes);
    await install(store, {
      manifest: staged.manifest,
      payload: staged.payload,
      crashAfterChunk: 0,
      onReload: () => {},
    });
    const before = await snapshot(store);
    expect(before.staging?.version).toBe('v4.0.0');
    expect(before.chunkCount).toBe(1);

    // version 不符
    const otherVersion = await makePackage('v4.0.1', bytes);
    const err1 = await install(store, { manifest: otherVersion.manifest, payload: otherVersion.payload }).catch((e) => e);
    expect((err1 as InstallError).code).toBe('STAGING_CONFLICT');
    expect((err1 as InstallError).message).toContain('拒绝混用');
    expect(await snapshot(store)).toEqual(before);

    // payloadSize 不符
    const bigger = await makePackage('v4.0.0', makePayload(17, FOUR_CHUNKS + 1));
    const err2 = await install(store, { manifest: bigger.manifest, payload: bigger.payload }).catch((e) => e);
    expect((err2 as InstallError).code).toBe('STAGING_CONFLICT');
    expect(await snapshot(store)).toEqual(before);

    // 整包 sha256 不符
    const tampered = await makePackage('v4.0.0', makePayload(99, FOUR_CHUNKS));
    const err3 = await install(store, { manifest: tampered.manifest, payload: tampered.payload }).catch((e) => e);
    expect((err3 as InstallError).code).toBe('STAGING_CONFLICT');
    expect(await snapshot(store)).toEqual(before);

    // 同一清单仍可正常续作
    const done = await install(store, { manifest: staged.manifest, payload: staged.payload });
    expect(done.status).toBe('installed');
    expect(await store.getActiveVersion()).toBe('v4.0.0');
  });
});

describe('安装引擎：损坏报告与整包校验', () => {
  it('载荷分块损坏按最小编号报告，已提交检查点保留', async () => {
    const bytes = makePayload(23, FOUR_CHUNKS);
    const { manifest } = await makePackage('v5.0.0', bytes);
    // 损坏第 1 块与第 2 块的载荷字节
    bytes[CHUNK_SIZE + 5] ^= 0xff;
    bytes[2 * CHUNK_SIZE + 5] ^= 0xff;

    const err = await install(store, { manifest, payload: new Blob([bytes]) }).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('CHUNK_CORRUPT');
    expect((err as InstallError).chunkIndex).toBe(1);
    expect((err as InstallError).message).toContain('分块 1 校验失败');

    // 块 0 已提交，块 1 未写入；active 未动
    expect(await store.countChunks()).toBe(1);
    expect(await store.getChunk(0)).not.toBeNull();
    expect(await store.getChunk(1)).toBeNull();
    expect(await store.getActiveVersion()).toBeNull();
  });

  it('整包散列不符时不切换 active，暂存保留供修复后续作', async () => {
    const { manifest, payload } = await makePackage('v6.0.0', makePayload(29, FOUR_CHUNKS));
    const badManifest = { ...manifest, sha256: '0'.repeat(64) };

    const err = await install(store, { manifest: badManifest, payload }).catch((e) => e);
    expect((err as InstallError).code).toBe('PACKAGE_HASH_MISMATCH');
    expect((err as InstallError).message).toContain('整包散列不符');
    expect(await store.getActiveVersion()).toBeNull();
    expect(await store.countChunks()).toBe(4); // 暂存保留
    expect((await store.getStaging())?.manifest.sha256).toBe('0'.repeat(64));

    // 修复清单（sha256 不符会被拒绝混用），先放弃暂存再以正确清单重装
    await store.discardStaging();
    const done = await install(store, { manifest, payload });
    expect(done.status).toBe('installed');
    expect(await store.getActiveVersion()).toBe('v6.0.0');
  });
});

describe('安装引擎：重复安装与旧版本可见性', () => {
  it('重复安装同一激活版本直接短路，不产生第二份记录', async () => {
    const { manifest, payload } = await makePackage('v7.0.0', makePayload(31, CHUNK_SIZE));
    const first = await install(store, { manifest, payload });
    expect(first.status).toBe('installed');

    const again = await install(store, { manifest, payload });
    expect(again).toEqual({ status: 'already-active', version: 'v7.0.0' });
    expect(await store.listPackageVersions()).toEqual(['v7.0.0']);
    expect(await store.countChunks()).toBe(0);
    expect(await store.getStaging()).toBeNull();
  });

  it('新版本暂存/安装失败期间旧激活版本保持可见', async () => {
    const v1 = await makePackage('v8.0.0', makePayload(37, CHUNK_SIZE));
    await install(store, { manifest: v1.manifest, payload: v1.payload });
    expect(await store.getActiveVersion()).toBe('v8.0.0');

    // 暂存 v8.1.0 并在第 0 块后“断电”
    const v2 = await makePackage('v8.1.0', makePayload(41, FOUR_CHUNKS));
    await install(store, { manifest: v2.manifest, payload: v2.payload, crashAfterChunk: 0, onReload: () => {} });
    expect(await store.getActiveVersion()).toBe('v8.0.0'); // 旧版本仍是激活版本

    // 用损坏载荷续作失败，旧版本依然可见
    const badBytes = makePayload(41, FOUR_CHUNKS);
    badBytes[CHUNK_SIZE] ^= 0xff;
    const err = await install(store, { manifest: v2.manifest, payload: new Blob([badBytes]) }).catch((e) => e);
    expect((err as InstallError).code).toBe('CHUNK_CORRUPT');
    expect(await store.getActiveVersion()).toBe('v8.0.0');
    expect(await store.listPackageVersions()).toEqual(['v8.0.0']);

    // 正确载荷续作成功后切换
    const done = await install(store, { manifest: v2.manifest, payload: v2.payload });
    expect(done.status).toBe('installed');
    expect(await store.getActiveVersion()).toBe('v8.1.0');
    // 旧包记录仍保留（历史可见），active 唯一
    expect((await store.listPackageVersions()).sort()).toEqual(['v8.0.0', 'v8.1.0']);
  });
});
