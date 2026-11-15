import { useEffect, useState } from 'react';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';
import type { GeneratedPackageFile, SolanaCluster } from '../types';
import type { DraftProtocolState } from './ProtocolBuilder';

interface PackageStudioProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  draft: DraftProtocolState;
}

export function PackageStudio({ cluster, customRpcUrl, draft }: PackageStudioProps) {
  const [files, setFiles] = useState<GeneratedPackageFile[]>([]);
  const [activePath, setActivePath] = useState<string>('src/index.ts');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/package/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...draft,
            cluster,
            rpcUrl: customRpcUrl,
          }),
        });
        if (res.ok && active) {
          const json = await res.json();
          setFiles(json.files || []);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [cluster, customRpcUrl, draft]);

  const activeFile = files.find((f) => f.path === activePath) || files[0];

  const handleCopy = async () => {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownloadZip = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/api/package/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          cluster,
          rpcUrl: customRpcUrl,
        }),
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${draft.packageName || 'solpool-staking-roi-protocol'}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Node.js TypeScript SDK + Anchor Rust On-Chain Program · Connected to {cluster}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Standalone Staking ROI npm Package
          </h1>
          <p className="text-sm text-slate-400">
            Production-ready npm package (<span className="font-mono text-slate-200">{draft.packageName}</span>)
            pre-wired to <span className="font-mono text-slate-200">{cluster}</span> for creating
            your own isolated SPL Stake Pool, calculating Native PoS APR/APY, and running the
            standalone Anchor ROI vault program.
          </p>
        </div>

        <button
          type="button"
          onClick={handleDownloadZip}
          disabled={downloading}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="w-4 h-4" />
          {downloading ? 'Packaging Archive...' : 'Download Node.js + Anchor Package (.zip)'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden min-h-[560px]">
        {/* File Tree */}
        <div className="lg:col-span-3 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0B101B] p-3 space-y-1">
          <div className="px-2 py-1.5 text-[11px] font-medium text-slate-500">
            Package Contents ({files.length} files)
          </div>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setActivePath(file.path)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs font-mono rounded text-left transition-colors ${
                activeFile?.path === file.path
                  ? 'bg-slate-800 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <FileCode2 className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{file.path}</span>
            </button>
          ))}
        </div>

        {/* Code Viewer */}
        <div className="lg:col-span-9 flex flex-col min-w-0">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between bg-[#0F1623]">
            <span className="text-xs font-mono text-slate-300">
              {activeFile?.path || 'Loading...'}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!activeFile}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100 border border-slate-700 rounded bg-[#090D16] transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy File
                </>
              )}
            </button>
          </div>

          <div className="flex-1 overflow-auto p-4 bg-[#090D16]">
            {loading && files.length === 0 ? (
              <div className="text-xs font-mono text-slate-500">Generating package files...</div>
            ) : (
              <pre className="text-xs font-mono leading-relaxed text-slate-200 whitespace-pre">
                <code>{activeFile?.content || ''}</code>
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
