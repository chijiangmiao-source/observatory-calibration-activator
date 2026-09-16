/**
 * 清单（manifest）解析与校验。
 * 清单固定包含：version、payloadSize、sha256、chunkHashes，
 * 其中所有散列均为小写十六进制 SHA-256（64 个 [0-9a-f] 字符）。
 */

export const CHUNK_SIZE = 1_048_576; // 1 MiB，载荷按此切块，末块取余
export const HASH_RE = /^[0-9a-f]{64}$/;

export interface Manifest {
  version: string;
  payloadSize: number;
  sha256: string;
  chunkHashes: string[];
}

/** 分块编号从 0 开始，末块取余；空载荷为 0 块。 */
export function expectedChunkCount(payloadSize: number): number {
  return Math.ceil(payloadSize / CHUNK_SIZE);
}

export type ManifestValidation =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] };

export function validateManifest(raw: unknown): ManifestValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['清单必须是 JSON 对象'] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!('version' in obj)) {
    errors.push('缺少字段 version');
  } else if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    errors.push('version 必须是非空字符串');
  }

  if (!('payloadSize' in obj)) {
    errors.push('缺少字段 payloadSize');
  } else if (
    typeof obj.payloadSize !== 'number' ||
    !Number.isInteger(obj.payloadSize) ||
    obj.payloadSize < 0
  ) {
    errors.push('payloadSize 必须是非负整数');
  }

  if (!('sha256' in obj)) {
    errors.push('缺少字段 sha256');
  } else if (typeof obj.sha256 !== 'string' || !HASH_RE.test(obj.sha256)) {
    errors.push('sha256 必须是 64 位小写十六进制 SHA-256');
  }

  if (!('chunkHashes' in obj)) {
    errors.push('缺少字段 chunkHashes');
  } else if (!Array.isArray(obj.chunkHashes)) {
    errors.push('chunkHashes 必须是数组');
  } else {
    obj.chunkHashes.forEach((h, i) => {
      if (typeof h !== 'string' || !HASH_RE.test(h)) {
        errors.push(`chunkHashes[${i}] 必须是 64 位小写十六进制 SHA-256`);
      }
    });
  }

  if (errors.length === 0) {
    const size = obj.payloadSize as number;
    const hashes = obj.chunkHashes as string[];
    const expected = expectedChunkCount(size);
    if (hashes.length !== expected) {
      errors.push(
        `大小矛盾：payloadSize=${size} 需要 ${expected} 个分块散列，但 chunkHashes 含 ${hashes.length} 项`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: obj as unknown as Manifest };
}

export function parseManifest(text: string): ManifestValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['清单不是合法 JSON'] };
  }
  return validateManifest(raw);
}
