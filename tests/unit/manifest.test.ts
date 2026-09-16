import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  expectedChunkCount,
  parseManifest,
  validateManifest,
} from '../../src/lib/manifest';

const H = (ch: string) => ch.repeat(64); // 合法的小写十六进制散列样本

function validRaw() {
  return {
    version: 'v1.0.0',
    payloadSize: CHUNK_SIZE,
    sha256: H('a'),
    chunkHashes: [H('b')],
  };
}

describe('expectedChunkCount（1 MiB 切块，末块取余）', () => {
  it.each([
    [0, 0],
    [1, 1],
    [CHUNK_SIZE - 1, 1],
    [CHUNK_SIZE, 1],
    [CHUNK_SIZE + 1, 2],
    [3 * CHUNK_SIZE + 123, 4],
  ])('payloadSize=%i → %i 块', (size, count) => {
    expect(expectedChunkCount(size)).toBe(count);
  });
});

describe('清单校验', () => {
  it('合法清单通过', () => {
    const res = validateManifest(validRaw());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.version).toBe('v1.0.0');
      expect(res.manifest.chunkHashes).toHaveLength(1);
    }
  });

  it('空载荷（0 字节、0 块）合法', () => {
    const res = validateManifest({
      version: 'v0',
      payloadSize: 0,
      sha256: H('e'),
      chunkHashes: [],
    });
    expect(res.ok).toBe(true);
  });

  it('非法 JSON 文本给出明确反馈', () => {
    const res = parseManifest('{not json');
    expect(res).toEqual({ ok: false, errors: ['清单不是合法 JSON'] });
  });

  it('非对象清单给出明确反馈', () => {
    expect(parseManifest('[1,2,3]')).toEqual({ ok: false, errors: ['清单必须是 JSON 对象'] });
    expect(parseManifest('"str"')).toEqual({ ok: false, errors: ['清单必须是 JSON 对象'] });
  });

  it.each(['version', 'payloadSize', 'sha256', 'chunkHashes'])('缺少字段 %s', (field) => {
    const raw = validRaw() as Record<string, unknown>;
    delete raw[field];
    const res = validateManifest(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain(`缺少字段 ${field}`);
  });

  it('version 为空字符串', () => {
    const res = validateManifest({ ...validRaw(), version: '  ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('version 必须是非空字符串');
  });

  it.each([-1, 1.5, '1024', null])('payloadSize 非法：%s', (v) => {
    const res = validateManifest({ ...validRaw(), payloadSize: v });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('payloadSize 必须是非负整数');
  });

  it.each([
    ['大写', 'A'.repeat(64)],
    ['长度不足', 'abc123'],
    ['含非十六进制字符', 'g'.repeat(64)],
  ])('sha256 格式错误：%s', (_label, bad) => {
    const res = validateManifest({ ...validRaw(), sha256: bad });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('sha256 必须是 64 位小写十六进制 SHA-256');
  });

  it('chunkHashes 非数组', () => {
    const res = validateManifest({ ...validRaw(), chunkHashes: H('b') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('chunkHashes 必须是数组');
  });

  it('chunkHashes 元素格式错误时指出下标', () => {
    const res = validateManifest({
      ...validRaw(),
      payloadSize: 2 * CHUNK_SIZE,
      chunkHashes: [H('a'), 'XYZ'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('chunkHashes[1] 必须是 64 位小写十六进制 SHA-256');
    }
  });

  it('大小矛盾：分块散列数与 payloadSize 不匹配', () => {
    const res = validateManifest({ ...validRaw(), chunkHashes: [H('a'), H('b')] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]).toContain('大小矛盾');
      expect(res.errors[0]).toContain('需要 1 个分块散列');
      expect(res.errors[0]).toContain('含 2 项');
    }
  });
});
