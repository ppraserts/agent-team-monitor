import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../store";

interface Props {
  ptyId: string;
  onClose?: () => void;
}

export function TerminalPanel({ ptyId, onClose }: Props) {
  const snap = useStore((s) => s.ptys[ptyId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Xterm({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#0c0d12",
        foreground: "#d8d8e0",
        cursor: "#5ed3ff",
        cursorAccent: "#0c0d12",
        black: "#1b1c22",
        brightBlack: "#3a3b46",
        red: "#ff6b8a", green: "#7ee787", yellow: "#ffc170",
        blue: "#79b8ff", magenta: "#c792ea", cyan: "#5ed3ff", white: "#d8d8e0",
        brightRed: "#ff8aa3", brightGreen: "#9ef0a3", brightYellow: "#ffd28a",
        brightBlue: "#9bcdff", brightMagenta: "#dab2ff", brightCyan: "#8ee2ff", brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const sendInput = (data: string) => {
      const bytes = new TextEncoder().encode(data);
      api.writePty(ptyId, bytes).catch(console.error);
    };
    term.onData(sendInput);

    let ro: ResizeObserver | null = null;
    const doResize = () => {
      try {
        fit.fit();
        const { cols, rows } = term;
        api.resizePty(ptyId, cols, rows).catch(() => {});
      } catch {}
    };
    if (containerRef.current) {
      ro = new ResizeObserver(doResize);
      ro.observe(containerRef.current);
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ pty_id: string; data_b64: string }>("pty://output", (e) => {
      if (e.payload.pty_id !== ptyId) return;
      const bin = atob(e.payload.data_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    // initial sync resize after first paint
    requestAnimationFrame(doResize);

    return () => {
      cancelled = true;
      unlisten?.();
      ro?.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  if (!snap) return null;

  return (
    <div className="flex flex-col h-full bg-base-950 border border-(--color-accent-violet)/30 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-base-800 flex items-center gap-2 bg-base-900/80">
        <div className="w-2 h-2 rounded-full bg-(--color-accent-violet)" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{snap.title}</div>
          <div className="text-[10px] text-base-500 truncate font-mono">{snap.cwd}</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-base-500 hover:text-base-200">
            <X size={14} />
          </button>
        )}
      </div>
      <div ref={containerRef} className="flex-1 p-2" />
    </div>
  );
}
