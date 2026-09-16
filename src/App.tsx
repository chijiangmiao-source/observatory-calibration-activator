import { useCallback, useEffect, useRef, useState } from 'react';
import { Store, type StagingState, type StoredPackage } from './lib/db';
import { expectedChunkCount, parseManifest, type Manifest } from './lib/manifest';
import { install, InstallError } from './lib/installer';

interface LogEntry {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

let logSeq = 0;

function shortHash(h: string): string {
  return `${h.slice(0, 16)}…`;
}

export default function App() {
  const [store, setStore] = useState<Store | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);
  const [activePkg, setActivePkg] = useState<StoredPackage | null>(null);
  const [packageVersions, setPackageVersions] = useState<string[]>([]);
  const [staging, setStaging] = useState<StagingState | null>(null);
  const [stagedChunks, setStagedChunks] = useState(0);
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [payloadFile, setPayloadFile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestErrors, setManifestErrors] = useState<string[]>([]);
  const [crashInput, setCrashInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const payloadInputRef = useRef<HTMLInputElement>(null);

  const appendLog = useCallback((kind: LogEntry['kind'], text: string) => {
    setLog((prev) => [...prev, { id: ++logSeq, kind, text }]);
  }, []);

  const refresh = useCallback(async (s: Store) => {
    const [av, versions, st, chunkCount] = await Promise.all([
      s.getActiveVersion(),
      s.listPackageVersions(),
      s.getStaging(),
      s.countChunks(),
    ]);
    setActiveVersion(av);
    setActivePkg(av ? await s.getPackage(av) : null);
    setPackageVersions(versions);
    setStaging(st);
    setStagedChunks(chunkCount);
  }, []);

  useEffect(() => {
    if (!globalThis.crypto?.subtle) {
      setInitError('当前环境缺少 Web Crypto（需通过 localhost 等安全上下文访问）');
      return;
    }
    Store.open()
      .then((s) => {
        setStore(s);
        return refresh(s);
      })
      .catch((e) => setInitError(`IndexedDB 不可用：${String(e)}`));
  }, [refresh]);

  async function onManifestSelected(file: File | null) {
    setManifestFile(file);
    setManifest(null);
    setManifestErrors([]);
    if (!file) return;
    const result = parseManifest(await file.text());
    if (result.ok) setManifest(result.manifest);
    else setManifestErrors(result.errors);
  }

  function resetFileInputs() {
    setManifestFile(null);
    setPayloadFile(null);
    setManifest(null);
    setManifestErrors([]);
    if (manifestInputRef.current) manifestInputRef.current.value = '';
    if (payloadInputRef.current) payloadInputRef.current.value = '';
  }

  async function onInstall() {
    if (!store || busy) return;
    if (!manifestFile) {
      setManifestErrors(['请先选择清单 JSON 文件']);
      return;
    }
    if (!payloadFile) {
      appendLog('error', '请先选择载荷文件');
      return;
    }
    // 安装时重新读取并校验清单，避免界面状态滞后
    const parsed = parseManifest(await manifestFile.text());
    if (!parsed.ok) {
      setManifestErrors(parsed.errors);
      return;
    }
    const m = parsed.manifest;

    let crashAfter: number | null = null;
    if (crashInput.trim() !== '') {
      const n = Number(crashInput.trim());
      if (!Number.isInteger(n) || n < 0) {
        appendLog('error', `故障注入参数无效：「${crashInput}」不是非负整数块编号`);
        return;
      }
      crashAfter = n;
    }

    setBusy(true);
    setProgress({ done: 0, total: expectedChunkCount(m.payloadSize) });
    try {
      const outcome = await install(store, {
        manifest: m,
        payload: payloadFile,
        crashAfterChunk: crashAfter,
        onReload: () => window.location.reload(),
        onChunk: (e) => {
          setProgress({ done: e.index + 1, total: e.total });
          if (e.action === 'reused') {
            appendLog('info', `块 ${e.index} 复验通过，跳过写入`);
          } else if (e.action === 'rewritten') {
            appendLog('info', `块 ${e.index} 已损坏，重新写入检查点`);
          } else {
            appendLog('info', `块 ${e.index} 校验通过，写入检查点`);
          }
        },
      });
      if (outcome.status === 'installed') {
        appendLog(
          'success',
          `版本 ${outcome.version} 安装完成：复用 ${outcome.reused} 块、新写 ${outcome.written} 块、重写 ${outcome.rewritten} 块；active 指针已切换，暂存已清除`,
        );
        resetFileInputs();
      } else if (outcome.status === 'already-active') {
        appendLog('info', `版本 ${outcome.version} 已是当前激活版本，未生成第二份记录`);
      } else {
        appendLog('info', `故障注入：块 ${outcome.afterChunk} 提交后刷新页面`);
      }
    } catch (e) {
      if (e instanceof InstallError) appendLog('error', e.message);
      else appendLog('error', `未预期错误：${String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
      await refresh(store);
    }
  }

  async function onDiscardStaging() {
    if (!store || busy) return;
    await store.discardStaging();
    appendLog('info', '已放弃暂存（激活版本与已安装包未受影响）');
    await refresh(store);
  }

  if (initError) {
    return (
      <main className="page">
        <h1>探测器标定包安装器</h1>
        <p className="banner error">{initError}</p>
      </main>
    );
  }
  if (!store) {
    return (
      <main className="page">
        <h1>探测器标定包安装器</h1>
        <p>正在打开本地数据库…</p>
      </main>
    );
  }

  const stagingTotal = staging ? expectedChunkCount(staging.manifest.payloadSize) : 0;

  return (
    <main className="page">
      <h1>探测器标定包安装器</h1>
      <p className="subtitle">山地天文台 · 隔离网络 · 纯前端离线安装</p>

      <section className="panel">
        <h2>当前激活版本</h2>
        <p>
          <strong id="active-version">{activeVersion ?? '无'}</strong>
        </p>
        {activePkg && (
          <dl className="details">
            <dt>载荷大小</dt>
            <dd>{activePkg.payloadSize.toLocaleString()} 字节</dd>
            <dt>整包 SHA-256</dt>
            <dd className="mono">{shortHash(activePkg.sha256)}</dd>
            <dt>安装时间</dt>
            <dd>{new Date(activePkg.installedAt).toLocaleString()}</dd>
          </dl>
        )}
        <p className="muted">
          已安装包记录：{packageVersions.length === 0 ? '无' : packageVersions.join('、')}
        </p>
      </section>

      <section className="panel">
        <h2>暂存状态</h2>
        {staging ? (
          <>
            <p id="staging-status" className="banner warning">
              检测到未完成的暂存：版本 {staging.manifest.version}，已写入检查点 {stagedChunks}/
              {stagingTotal} 块。请重新选择清单与载荷文件以继续（仅复验并补写缺失或损坏块）。
            </p>
            <button id="discard-staging-btn" type="button" onClick={onDiscardStaging} disabled={busy}>
              放弃暂存
            </button>
          </>
        ) : (
          <p id="staging-status" className="muted">
            无暂存
          </p>
        )}
      </section>

      <section className="panel">
        <h2>安装 / 续作</h2>
        <div className="field">
          <label htmlFor="manifest-input">清单 JSON（version / payloadSize / sha256 / chunkHashes）</label>
          <input
            id="manifest-input"
            ref={manifestInputRef}
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => void onManifestSelected(e.target.files?.[0] ?? null)}
          />
        </div>
        {manifestErrors.length > 0 && (
          <ul id="manifest-errors" className="errors">
            {manifestErrors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}
        {manifest && (
          <dl id="manifest-summary" className="details">
            <dt>版本</dt>
            <dd>{manifest.version}</dd>
            <dt>声明大小</dt>
            <dd>{manifest.payloadSize.toLocaleString()} 字节</dd>
            <dt>分块数</dt>
            <dd>{expectedChunkCount(manifest.payloadSize)}</dd>
            <dt>整包 SHA-256</dt>
            <dd className="mono">{shortHash(manifest.sha256)}</dd>
          </dl>
        )}
        <div className="field">
          <label htmlFor="payload-input">二进制载荷</label>
          <input
            id="payload-input"
            ref={payloadInputRef}
            type="file"
            disabled={busy}
            onChange={(e) => setPayloadFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="field">
          <label htmlFor="crash-input">故障注入：第 N 块提交后刷新页面（留空禁用）</label>
          <input
            id="crash-input"
            type="number"
            min={0}
            step={1}
            placeholder="例如 1"
            value={crashInput}
            disabled={busy}
            onChange={(e) => setCrashInput(e.target.value)}
          />
        </div>
        <button id="install-btn" type="button" onClick={() => void onInstall()} disabled={busy}>
          {busy ? '安装中…' : '开始安装'}
        </button>
        {progress && (
          <p id="progress" className="muted">
            已处理 {progress.done}/{progress.total} 块
            <progress value={progress.done} max={progress.total} />
          </p>
        )}
      </section>

      <section className="panel">
        <h2>日志</h2>
        {log.length === 0 ? (
          <p className="muted">暂无日志</p>
        ) : (
          <ul id="log">
            {log.map((entry) => (
              <li key={entry.id} data-kind={entry.kind}>
                {entry.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
