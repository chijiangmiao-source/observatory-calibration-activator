/**
 * 崩溃可恢复的安装引擎。
 *
 * 协议：
 *  1. 校验载荷文件大小与清单一致；故障注入编号必须指向真实存在的分块；
 *  2. 已有暂存时，若 version / payloadSize / sha256 任一不符则拒绝混用且不改写现场；
 *  3. 逐块处理（编号从 0 起）：已暂存块复验通过则跳过；缺失或损坏块从载荷
 *     重新切块、校验散列，通过后才以独立事务写入检查点；
 *  4. 全部块就绪后组包并校验整包 SHA-256；
 *  5. 仅在整包散列通过时，于一个事务内写入包记录、切换唯一 active 指针并清除暂存。
 *
 * 重复安装当前激活版本：不写入任何数据，但对所选载荷做完整复验——
 * 分块损坏按最小编号报告，整包散列不符同样拒绝；同版本不同内容拒绝覆盖。
 *
 * 故障注入：crashAfterChunk = N 时，第 N 块检查点完成后调用 onReload（页面刷新），
 * 模拟供电切换导致的浏览器关闭。
 */

import { CHUNK_SIZE, expectedChunkCount, type Manifest } from './manifest';
import { concatChunks, sha256Hex } from './sha256';
import type { Store } from './db';

export type InstallErrorCode =
  | 'SIZE_MISMATCH'
  | 'INVALID_CRASH_CHUNK'
  | 'VERSION_CONFLICT'
  | 'STAGING_CONFLICT'
  | 'CHUNK_CORRUPT'
  | 'PACKAGE_HASH_MISMATCH'
  | 'INCOMPLETE_STAGING';

export class InstallError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string,
    readonly chunkIndex?: number,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

export interface ChunkEvent {
  index: number;
  total: number;
  /** reused=暂存复验通过；written=新写；rewritten=损坏重写；verified=当前版本复验（不写入） */
  action: 'reused' | 'written' | 'rewritten' | 'verified';
}

export type InstallOutcome =
  | { status: 'installed'; version: string; reused: number; written: number; rewritten: number }
  | { status: 'already-active'; version: string }
  | { status: 'reloading'; afterChunk: number };

export interface InstallOptions {
  manifest: Manifest;
  payload: Blob;
  /** 第 N 块提交后刷新页面（故障注入）；null/undefined 表示不注入 */
  crashAfterChunk?: number | null;
  onReload?: () => void;
  onChunk?: (e: ChunkEvent) => void;
}

/** 从载荷切出第 index 块并计算 SHA-256。 */
async function hashPayloadChunk(
  payload: Blob,
  index: number,
  payloadSize: number,
): Promise<{ buf: ArrayBuffer; hash: string }> {
  const start = index * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, payloadSize);
  const buf = await payload.slice(start, end).arrayBuffer();
  return { buf, hash: await sha256Hex(buf) };
}

function corruptChunkError(index: number, expected: string, actual: string): InstallError {
  return new InstallError(
    'CHUNK_CORRUPT',
    `分块 ${index} 校验失败（最小损坏编号）：期望 ${expected}，实际 ${actual}`,
    index,
  );
}

export async function install(store: Store, opts: InstallOptions): Promise<InstallOutcome> {
  const { manifest, payload } = opts;

  if (payload.size !== manifest.payloadSize) {
    throw new InstallError(
      'SIZE_MISMATCH',
      `载荷大小不符：清单声明 ${manifest.payloadSize} 字节，实际文件 ${payload.size} 字节`,
    );
  }

  const total = expectedChunkCount(manifest.payloadSize);

  // 故障注入编号必须指向真实存在的分块，否则静默不刷新会掩盖测试意图
  const crash = opts.crashAfterChunk;
  if (crash != null && (!Number.isInteger(crash) || crash < 0 || crash >= total)) {
    throw new InstallError(
      'INVALID_CRASH_CHUNK',
      total === 0
        ? `故障注入编号无效：载荷共 0 块，不存在第 ${crash} 块`
        : `故障注入编号无效：第 ${crash} 块不存在（共 ${total} 块，有效编号 0–${total - 1}）`,
    );
  }

  // 当前激活版本的重复安装：不写入任何数据，但对所选载荷完整复验
  const active = await store.getActiveVersion();
  if (active === manifest.version) {
    const installed = await store.getPackage(manifest.version);
    if (installed) {
      if (installed.payloadSize !== manifest.payloadSize || installed.sha256 !== manifest.sha256) {
        throw new InstallError(
          'VERSION_CONFLICT',
          `版本 ${manifest.version} 已激活，但所选清单与已安装记录不符（payloadSize/sha256 不一致），拒绝覆盖`,
        );
      }
      for (let i = 0; i < total; i++) {
        const { hash } = await hashPayloadChunk(payload, i, manifest.payloadSize);
        if (hash !== manifest.chunkHashes[i]) {
          throw corruptChunkError(i, manifest.chunkHashes[i], hash);
        }
        opts.onChunk?.({ index: i, total, action: 'verified' });
      }
      const wholeHash = await sha256Hex(new Uint8Array(await payload.arrayBuffer()));
      if (wholeHash !== manifest.sha256) {
        throw new InstallError(
          'PACKAGE_HASH_MISMATCH',
          `整包散列不符：期望 ${manifest.sha256}，实际 ${wholeHash}。未改动任何现场。`,
        );
      }
      return { status: 'already-active', version: manifest.version };
    }
  }

  const staging = await store.getStaging();
  if (staging) {
    const m = staging.manifest;
    const mismatches: string[] = [];
    if (m.version !== manifest.version) {
      mismatches.push(`version（暂存 ${m.version} ≠ 所选 ${manifest.version}）`);
    }
    if (m.payloadSize !== manifest.payloadSize) {
      mismatches.push(`payloadSize（暂存 ${m.payloadSize} ≠ 所选 ${manifest.payloadSize}）`);
    }
    if (m.sha256 !== manifest.sha256) {
      mismatches.push('整包 sha256 不一致');
    }
    if (mismatches.length > 0) {
      throw new InstallError(
        'STAGING_CONFLICT',
        `拒绝混用：存在版本 ${m.version} 的未完成暂存，${mismatches.join('、')}。现场未改动；如确认放弃旧暂存，请使用“放弃暂存”。`,
      );
    }
  } else {
    await store.setStaging({ manifest, updatedAt: new Date().toISOString() });
  }

  let reused = 0;
  let written = 0;
  let rewritten = 0;

  for (let i = 0; i < total; i++) {
    // 复验已暂存块：通过则跳过，不重复写入
    const stored = await store.getChunk(i);
    if (stored) {
      const storedHash = await sha256Hex(new Uint8Array(stored.data));
      if (storedHash === manifest.chunkHashes[i]) {
        reused++;
        opts.onChunk?.({ index: i, total, action: 'reused' });
        if (crash === i) {
          opts.onReload?.();
          return { status: 'reloading', afterChunk: i };
        }
        continue;
      }
    }

    // 缺失或损坏块：从载荷切块并校验，按最小编号报告损坏
    const { buf, hash } = await hashPayloadChunk(payload, i, manifest.payloadSize);
    if (hash !== manifest.chunkHashes[i]) {
      throw corruptChunkError(i, manifest.chunkHashes[i], hash);
    }

    // 散列通过后才以独立事务写入检查点
    await store.putChunk({ index: i, hash, data: buf });
    if (stored) rewritten++;
    else written++;
    opts.onChunk?.({ index: i, total, action: stored ? 'rewritten' : 'written' });

    if (crash === i) {
      opts.onReload?.();
      return { status: 'reloading', afterChunk: i };
    }
  }

  // 组包并校验整包散列
  const chunks = await store.getAllChunks();
  if (chunks.length !== total || chunks.some((c, i) => c.index !== i)) {
    throw new InstallError(
      'INCOMPLETE_STAGING',
      `暂存分块不完整（${chunks.length}/${total}），无法组包`,
    );
  }
  const whole = concatChunks(chunks.map((c) => c.data));
  const wholeHash = await sha256Hex(whole);
  if (wholeHash !== manifest.sha256) {
    throw new InstallError(
      'PACKAGE_HASH_MISMATCH',
      `整包散列不符：期望 ${manifest.sha256}，实际 ${wholeHash}。未切换激活版本，暂存保留。`,
    );
  }

  // 单事务激活：写包记录 + 切换 active + 清除暂存
  await store.activate({
    version: manifest.version,
    payloadSize: manifest.payloadSize,
    sha256: manifest.sha256,
    chunkHashes: manifest.chunkHashes,
    data: whole.buffer,
    installedAt: new Date().toISOString(),
  });

  return { status: 'installed', version: manifest.version, reused, written, rewritten };
}
