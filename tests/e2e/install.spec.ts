import { expect, test } from '@playwright/test';
import {
  CHUNK_SIZE,
  idbSnapshot,
  makeManifest,
  makePayload,
  selectFiles,
} from './helpers';

const FOUR_CHUNKS = 3 * CHUNK_SIZE + 777; // 4 块，末块取余

test('完整安装：全部块与整包散列通过后激活并清除暂存', async ({ page }) => {
  const payload = makePayload(7, 2 * CHUNK_SIZE + 12345);
  const manifest = makeManifest(payload, 'v1.0.0');

  await page.goto('/');
  await expect(page.locator('#active-version')).toHaveText('无');

  await selectFiles(page, manifest, payload);
  await expect(page.locator('#manifest-summary')).toContainText('v1.0.0');
  await page.locator('#install-btn').click();

  await expect(page.locator('#active-version')).toHaveText('v1.0.0', { timeout: 30_000 });
  await expect(page.locator('#staging-status')).toHaveText('无暂存');
  await expect(page.locator('#log')).toContainText('active 指针已切换，暂存已清除');

  const snap = await idbSnapshot(page);
  expect(snap).toEqual({
    active: 'v1.0.0',
    stagingVersion: null,
    chunks: 0,
    packages: 1,
    packageVersions: ['v1.0.0'],
  });
});

test('故障注入：第 N 块提交后刷新，重开后保留旧激活版本并断点续作', async ({ page }) => {
  const payload = makePayload(11, FOUR_CHUNKS);
  const manifest = makeManifest(payload, 'v2.0.0');

  await page.goto('/');
  await selectFiles(page, manifest, payload);
  await page.locator('#crash-input').fill('1');
  await page.locator('#install-btn').click();

  // 页面在第 1 块提交后真实刷新；重开后显示未完成暂存，激活版本仍为“无”
  await expect(page.locator('#staging-status')).toContainText('v2.0.0', { timeout: 30_000 });
  await expect(page.locator('#staging-status')).toContainText('2/4 块');
  await expect(page.locator('#active-version')).toHaveText('无');

  let snap = await idbSnapshot(page);
  expect(snap.chunks).toBe(2);
  expect(snap.active).toBeNull();
  expect(snap.stagingVersion).toBe('v2.0.0');

  // 用户重选文件后续作：仅复验、补写缺失块
  await selectFiles(page, manifest, payload);
  await page.locator('#install-btn').click();

  await expect(page.locator('#active-version')).toHaveText('v2.0.0', { timeout: 30_000 });
  await expect(page.locator('#log')).toContainText('块 0 复验通过，跳过写入');
  await expect(page.locator('#log')).toContainText('块 1 复验通过，跳过写入');
  await expect(page.locator('#log')).toContainText('块 2 校验通过，写入检查点');

  snap = await idbSnapshot(page);
  expect(snap).toEqual({
    active: 'v2.0.0',
    stagingVersion: null,
    chunks: 0,
    packages: 1,
    packageVersions: ['v2.0.0'],
  });
});

test('续作清单 version/大小/整包散列不符时拒绝混用且不改写现场', async ({ page }) => {
  const payload = makePayload(21, FOUR_CHUNKS);
  const manifest = makeManifest(payload, 'v3.0.0');

  // 先暂存 v3.0.0 并在第 0 块后刷新
  await page.goto('/');
  await selectFiles(page, manifest, payload);
  await page.locator('#crash-input').fill('0');
  await page.locator('#install-btn').click();
  await expect(page.locator('#staging-status')).toContainText('1/4 块', { timeout: 30_000 });

  // 选择 version 不同的清单 → 拒绝混用
  await selectFiles(page, makeManifest(payload, 'v3.0.1'), payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#log')).toContainText('拒绝混用');
  let snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: null, stagingVersion: 'v3.0.0', chunks: 1, packages: 0 });

  // 选择 payloadSize 不同的清单 → 拒绝混用
  const bigger = makePayload(22, FOUR_CHUNKS + 1);
  await selectFiles(page, makeManifest(bigger, 'v3.0.0'), bigger);
  await page.locator('#install-btn').click();
  await expect(page.locator('#log').getByText('拒绝混用').nth(1)).toBeVisible();
  snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: null, stagingVersion: 'v3.0.0', chunks: 1, packages: 0 });

  // 整包散列不同（同 version、同大小）→ 拒绝混用
  const other = makePayload(99, FOUR_CHUNKS);
  await selectFiles(page, makeManifest(other, 'v3.0.0'), other);
  await page.locator('#install-btn').click();
  await expect(page.locator('#log').getByText('拒绝混用').nth(2)).toBeVisible();
  snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: null, stagingVersion: 'v3.0.0', chunks: 1, packages: 0 });

  // 同一清单续作成功
  await selectFiles(page, manifest, payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#active-version')).toHaveText('v3.0.0', { timeout: 30_000 });
  snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: 'v3.0.0', stagingVersion: null, chunks: 0, packages: 1 });
});

test('分块损坏按最小编号报告，旧激活版本继续可见', async ({ page }) => {
  // 先安装旧版本 v4.0.0
  const v1Payload = makePayload(31, CHUNK_SIZE);
  await page.goto('/');
  await selectFiles(page, makeManifest(v1Payload, 'v4.0.0'), v1Payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#active-version')).toHaveText('v4.0.0', { timeout: 30_000 });

  // 新版本载荷的第 1、2 块损坏
  const payload = makePayload(32, FOUR_CHUNKS);
  const manifest = makeManifest(payload, 'v4.1.0');
  payload[CHUNK_SIZE + 10] ^= 0xff;
  payload[2 * CHUNK_SIZE + 10] ^= 0xff;

  await selectFiles(page, manifest, payload);
  await page.locator('#install-btn').click();

  await expect(page.locator('#log')).toContainText('分块 1 校验失败', { timeout: 30_000 });
  await expect(page.locator('#active-version')).toHaveText('v4.0.0'); // 旧版本继续可见

  const snap = await idbSnapshot(page);
  expect(snap.active).toBe('v4.0.0');
  expect(snap.chunks).toBe(1); // 仅块 0 已提交
  expect(snap.packageVersions).toEqual(['v4.0.0']);
});

test('清单字段缺失、大小矛盾、散列格式错误均有明确反馈', async ({ page }) => {
  const payload = makePayload(41, CHUNK_SIZE);
  const good = makeManifest(payload, 'v5.0.0');

  await page.goto('/');

  // 缺少字段
  const missing = { ...good } as Record<string, unknown>;
  delete missing.sha256;
  await page.locator('#manifest-input').setInputFiles({
    name: 'm.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(missing)),
  });
  await expect(page.locator('#manifest-errors')).toContainText('缺少字段 sha256');

  // 散列格式错误（大写）
  await page.locator('#manifest-input').setInputFiles({
    name: 'm.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...good, sha256: good.sha256.toUpperCase() }),
    ),
  });
  await expect(page.locator('#manifest-errors')).toContainText(
    'sha256 必须是 64 位小写十六进制 SHA-256',
  );

  // 大小矛盾：分块散列数与 payloadSize 不匹配
  await page.locator('#manifest-input').setInputFiles({
    name: 'm.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...good, chunkHashes: [...good.chunkHashes, good.chunkHashes[0]] }),
    ),
  });
  await expect(page.locator('#manifest-errors')).toContainText('大小矛盾');

  // 载荷文件大小与清单声明不符
  await selectFiles(page, good, makePayload(42, CHUNK_SIZE - 1));
  await page.locator('#install-btn').click();
  await expect(page.locator('#log')).toContainText('载荷大小不符');

  const snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: null, stagingVersion: null, chunks: 0, packages: 0 });
});

test('重复安装同一版本不产生第二份记录', async ({ page }) => {
  const payload = makePayload(51, CHUNK_SIZE);
  const manifest = makeManifest(payload, 'v6.0.0');

  await page.goto('/');
  await selectFiles(page, manifest, payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#active-version')).toHaveText('v6.0.0', { timeout: 30_000 });

  // 再次选择同一清单与载荷安装：完整复验后提示已激活
  await selectFiles(page, manifest, payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#log')).toContainText('复验通过');
  await expect(page.locator('#log')).toContainText('未生成第二份记录');

  const snap = await idbSnapshot(page);
  expect(snap.packages).toBe(1);
  expect(snap.packageVersions).toEqual(['v6.0.0']);
});

test('整包散列不符时不切换激活版本，修复后可续作完成', async ({ page }) => {
  const payload = makePayload(61, 2 * CHUNK_SIZE + 5);
  const good = makeManifest(payload, 'v7.0.0');
  const bad = { ...good, sha256: '0'.repeat(64) };

  await page.goto('/');
  await selectFiles(page, bad, payload);
  await page.locator('#install-btn').click();

  await expect(page.locator('#log')).toContainText('整包散列不符', { timeout: 30_000 });
  await expect(page.locator('#active-version')).toHaveText('无');
  let snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: null, stagingVersion: 'v7.0.0', chunks: 3, packages: 0 });

  // 整包散列不符属于“拒绝混用”情形，需先放弃暂存再以正确清单安装
  await page.locator('#discard-staging-btn').click();
  await expect(page.locator('#staging-status')).toHaveText('无暂存');

  await selectFiles(page, good, payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#active-version')).toHaveText('v7.0.0', { timeout: 30_000 });
  snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: 'v7.0.0', stagingVersion: null, chunks: 0, packages: 1 });
});

test('故障注入编号不存在时明确提示，且不写入任何数据', async ({ page }) => {
  const payload = makePayload(71, CHUNK_SIZE); // 单块包：仅第 0 块存在
  const manifest = makeManifest(payload, 'v8.0.0');

  await page.goto('/');
  await selectFiles(page, manifest, payload);
  await page.locator('#crash-input').fill('1');
  await page.locator('#install-btn').click();

  await expect(page.locator('#log')).toContainText('故障注入编号无效：第 1 块不存在');
  await expect(page.locator('#active-version')).toHaveText('无');
  await expect(page.locator('#staging-status')).toHaveText('无暂存');
  const snap = await idbSnapshot(page);
  expect(snap).toMatchObject({ active: null, stagingVersion: null, chunks: 0, packages: 0 });

  // 清除故障注入后正常安装
  await page.locator('#crash-input').fill('');
  await page.locator('#install-btn').click();
  await expect(page.locator('#active-version')).toHaveText('v8.0.0', { timeout: 30_000 });
});

test('重复安装当前版本时载荷损坏：按最小编号报告而非显示已激活', async ({ page }) => {
  const payload = makePayload(81, FOUR_CHUNKS);
  const manifest = makeManifest(payload, 'v9.0.0');

  await page.goto('/');
  await selectFiles(page, manifest, payload);
  await page.locator('#install-btn').click();
  await expect(page.locator('#active-version')).toHaveText('v9.0.0', { timeout: 30_000 });

  // 再次安装同一版本，但所选载荷第 1、3 块已损坏
  const corrupt = Buffer.from(payload);
  corrupt[CHUNK_SIZE + 7] ^= 0xff;
  corrupt[3 * CHUNK_SIZE + 7] ^= 0xff;
  await selectFiles(page, manifest, corrupt);
  await page.locator('#install-btn').click();

  await expect(page.locator('#log')).toContainText('分块 1 校验失败', { timeout: 30_000 });
  await expect(page.locator('#log')).not.toContainText('未生成第二份记录');
  await expect(page.locator('#active-version')).toHaveText('v9.0.0');

  const snap = await idbSnapshot(page);
  expect(snap).toMatchObject({
    active: 'v9.0.0',
    stagingVersion: null,
    chunks: 0,
    packages: 1,
    packageVersions: ['v9.0.0'],
  });
});
