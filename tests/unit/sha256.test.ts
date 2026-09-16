import { describe, expect, it } from 'vitest';
import { concatChunks, sha256Hex } from '../../src/lib/sha256';

describe('sha256Hex（Web Crypto 真实散列）', () => {
  it('空输入', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('已知矢量 "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('输出为小写十六进制', async () => {
    const h = await sha256Hex(new Uint8Array([1, 2, 3, 250]));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('concatChunks', () => {
  it('按序拼接且保持字节内容', async () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    const b = new Uint8Array([4, 5]).buffer;
    const c = new Uint8Array([6]).buffer;
    const whole = concatChunks([a, b, c]);
    expect(Array.from(whole)).toEqual([1, 2, 3, 4, 5, 6]);
    // 拼接结果的散列应等于直接散列
    expect(await sha256Hex(whole)).toBe(await sha256Hex(new Uint8Array([1, 2, 3, 4, 5, 6])));
  });

  it('空列表得到空结果', () => {
    expect(concatChunks([]).byteLength).toBe(0);
  });
});
