import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { RoomClient, shouldReplace } from "./collab/RoomClient";
import type { SyncElement, PresenceUser, PointerMessage } from "./collab/RoomClient";
import type { Me } from "./App";

// Excalidraw's imperative API and element types vary slightly between versions; kept
// loose here on purpose. If a build error names a renamed export, check the installed
// @excalidraw/excalidraw version (see CLAUDE.md, Phase 6) before editing.
type ExcalidrawAPI = any;
type AiState = "idle" | "generating" | "ready" | "inserting";
const LIBRARIES_URL = "https://libraries.excalidraw.com/";
const LIBRARY_WINDOW_NAME = "excalidrawCfPlatform";

export function Editor({ roomId, me, shareCode }: { roomId: string; me: Me; shareCode?: string | null }) {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const clientRef = useRef<RoomClient | null>(null);
  // The version we last sent OR applied per element id — prevents rebroadcast loops.
  const lastVersions = useRef<Map<string, number>>(new Map());
  const collaborators = useRef<Map<string, any>>(new Map());
  const [status, setStatus] = useState("connecting…");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiState, setAiState] = useState<AiState>("idle");
  const [aiMermaid, setAiMermaid] = useState("");
  const [aiPreviewSvg, setAiPreviewSvg] = useState("");
  const [aiError, setAiError] = useState("");
  const [libraryReturnUrl, setLibraryReturnUrl] = useState(() => currentLibraryReturnUrl());

  useEffect(() => {
    if (!window.name) window.name = LIBRARY_WINDOW_NAME;
    setLibraryReturnUrl(currentLibraryReturnUrl());
  }, [roomId, shareCode]);

  // Apply a batch of remote elements: reconcile against the current scene, then
  // updateScene with the merged full set. Because we record the applied versions in
  // lastVersions, the resulting onChange won't echo these back out.
  const applyRemote = useCallback((incoming: SyncElement[]) => {
    const api = apiRef.current;
    if (!api) return;
    const current: SyncElement[] = api.getSceneElementsIncludingDeleted();
    const byId = new Map<string, SyncElement>();
    for (const el of current) byId.set(el.id, el);

    let changed = false;
    for (const el of incoming) {
      if (shouldReplace(byId.get(el.id), el)) {
        byId.set(el.id, el);
        lastVersions.current.set(el.id, el.version);
        changed = true;
      }
    }
    if (changed) api.updateScene({ elements: [...byId.values()] });
  }, []);

  useEffect(() => {
    const client = new RoomClient(
      roomId,
      me as PresenceUser,
      {
        onInit: (elements) => {
          for (const el of elements) lastVersions.current.set(el.id, el.version);
          apiRef.current?.updateScene({ elements });
          setStatus("connected");
        },
        onUpdate: (elements) => applyRemote(elements),
        onPointer: (msg: PointerMessage) => {
          collaborators.current.set(msg.user.id, {
            id: msg.user.id,
            username: msg.user.name,
            color: { background: msg.user.color, stroke: msg.user.color },
            pointer: { x: msg.x, y: msg.y },
            button: msg.button ?? "up",
            selectedElementIds: msg.selectedElementIds ?? [],
          });
          apiRef.current?.updateScene({ collaborators: new Map(collaborators.current) });
        },
        onPresence: (users: PresenceUser[]) => {
          const present = new Set(users.map((u) => u.id));
          for (const id of [...collaborators.current.keys()]) {
            if (!present.has(id)) collaborators.current.delete(id);
          }
          apiRef.current?.updateScene({ collaborators: new Map(collaborators.current) });
          setStatus(users.length > 1 ? `${users.length} online` : "connected");
        },
      },
      shareCode
    );
    clientRef.current = client;
    return () => client.close();
  }, [roomId, me, shareCode, applyRemote]);

  // Local edits -> compute the changed elements and broadcast them.
  const onChange = useCallback((_elements: readonly any[]) => {
    const api = apiRef.current;
    const client = clientRef.current;
    if (!api || !client) return;
    const all: SyncElement[] = api.getSceneElementsIncludingDeleted();
    const changed: SyncElement[] = [];
    for (const el of all) {
      if (lastVersions.current.get(el.id) !== el.version) {
        lastVersions.current.set(el.id, el.version);
        changed.push(el);
      }
    }
    if (changed.length) client.sendUpdate(changed);
  }, []);

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number }; button: "up" | "down" }) => {
      const selected = apiRef.current
        ? Object.keys(apiRef.current.getAppState().selectedElementIds ?? {})
        : [];
      clientRef.current?.sendPointer(payload.pointer.x, payload.pointer.y, payload.button, selected);
    },
    []
  );

  const generatePreview = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) return;
    setAiState("generating");
    setAiError("");
    setAiMermaid("");
    setAiPreviewSvg("");

    try {
      const res = await fetch("/api/ai/diagram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(await responseError(res));
      const { mermaid } = (await res.json()) as { mermaid?: string };
      if (!mermaid) throw new Error("The AI returned an empty diagram.");

      const previewSvg = await renderMermaidPreview(mermaid);
      setAiMermaid(mermaid);
      setAiPreviewSvg(previewSvg);
      setAiState("ready");
    } catch (err) {
      setAiState("idle");
      setAiError(errorMessage(err));
    }
  }, [aiPrompt]);

  const insertPreview = useCallback(async () => {
    if (!aiMermaid) return;
    const api = apiRef.current;
    if (!api) return;

    setAiState("inserting");
    setAiError("");
    try {
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const { elements: skeleton } = await parseMermaidToExcalidraw(aiMermaid);
      const newElements = convertToExcalidrawElements(skeleton);

      const merged = [...api.getSceneElementsIncludingDeleted(), ...newElements];
      api.updateScene({ elements: merged, commitToHistory: true });
      api.scrollToContent?.(newElements, {
        fitToViewport: true,
        viewportZoomFactor: 0.65,
        animate: true,
        duration: 300,
      });
      api.setToast?.({ message: "AI diagram inserted", duration: 2200 });
      setAiOpen(false);
      setAiState("idle");
      // onChange will pick up and broadcast the new elements.
    } catch (err) {
      setAiState("ready");
      setAiError(errorMessage(err));
    }
  }, [aiMermaid]);

  const openLibraries = useCallback(() => {
    if (!window.name) window.name = LIBRARY_WINDOW_NAME;
    const url = new URL(LIBRARIES_URL);
    url.searchParams.set("theme", "light");
    url.searchParams.set("sort", "default");
    url.searchParams.set("referrer", currentLibraryReturnUrl());
    url.searchParams.set("target", window.name);
    url.searchParams.set("useHash", "true");
    window.open(url.toString(), "_blank");
  }, []);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <style>{`
        @media (max-width: 700px) {
          .editor-ai-toolbar {
            top: 112px !important;
            right: auto !important;
            left: 12px !important;
          }
        }
      `}</style>
      <Toolbar status={status} onGenerate={() => setAiOpen(true)} onOpenLibraries={openLibraries} />
      <Excalidraw
        excalidrawAPI={(api: ExcalidrawAPI) => (apiRef.current = api)}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        libraryReturnUrl={libraryReturnUrl}
        isCollaborating
      />
      {aiOpen ? (
        <AiDiagramPanel
          prompt={aiPrompt}
          state={aiState}
          mermaid={aiMermaid}
          previewSvg={aiPreviewSvg}
          error={aiError}
          onPromptChange={(value) => {
            setAiPrompt(value);
            setAiError("");
          }}
          onGenerate={generatePreview}
          onInsert={insertPreview}
          onClose={() => setAiOpen(false)}
        />
      ) : null}
    </div>
  );
}

function Toolbar({
  status,
  onGenerate,
  onOpenLibraries,
}: {
  status: string;
  onGenerate: () => void;
  onOpenLibraries: () => void;
}) {
  return (
    <div
      className="editor-ai-toolbar"
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 10,
        display: "flex",
        gap: 8,
        alignItems: "center",
        background: "var(--island-bg-color, #fff)",
        border: "1px solid #d6d6d6",
        borderRadius: 8,
        padding: "6px 10px",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <span style={{ color: "#666" }}>{status}</span>
      <button
        onClick={onOpenLibraries}
        style={{
          border: "1px solid #d6d6d6",
          background: "#fff",
          color: "#34303f",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        Libraries
      </button>
      <button
        onClick={onGenerate}
        style={{
          border: "1px solid #4a47b1",
          background: "#4a47b1",
          color: "#fff",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        AI diagram
      </button>
    </div>
  );
}

function currentLibraryReturnUrl(): string {
  const url = new URL(window.location.href);
  url.hash = "";
  return url.toString();
}

function AiDiagramPanel({
  prompt,
  state,
  mermaid,
  previewSvg,
  error,
  onPromptChange,
  onGenerate,
  onInsert,
  onClose,
}: {
  prompt: string;
  state: AiState;
  mermaid: string;
  previewSvg: string;
  error: string;
  onPromptChange: (value: string) => void;
  onGenerate: () => void;
  onInsert: () => void;
  onClose: () => void;
}) {
  const isGenerating = state === "generating";
  const isInserting = state === "inserting";
  const canGenerate = prompt.trim().length > 0 && !isGenerating && !isInserting;
  const canInsert = Boolean(mermaid) && state === "ready";

  return (
    <div style={panelBackdropStyle} role="dialog" aria-modal="true" aria-label="AI diagram">
      <style>{`
        @keyframes ai-spin { to { transform: rotate(360deg); } }
        .ai-preview-svg svg { max-width: 100%; height: auto; }
      `}</style>
      <form
        style={panelStyle}
        onSubmit={(event) => {
          event.preventDefault();
          if (canGenerate) onGenerate();
        }}
      >
        <div style={panelHeaderStyle}>
          <div>
            <div style={panelTitleStyle}>AI diagram</div>
            <div style={panelSubtitleStyle}>Generate a preview, then insert it on the canvas.</div>
          </div>
          <button type="button" onClick={onClose} style={iconButtonStyle} aria-label="Close AI diagram panel">
            ×
          </button>
        </div>

        <label style={labelStyle} htmlFor="ai-diagram-prompt">
          Description
        </label>
        <textarea
          id="ai-diagram-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder="User signs up, receives an email, verifies their account, then opens the dashboard"
          rows={4}
          style={textareaStyle}
          autoFocus
        />

        {error ? <div style={errorStyle}>{error}</div> : null}

        <div style={previewShellStyle}>
          <div style={previewHeaderStyle}>
            <span>Preview</span>
            {isGenerating ? <span style={mutedStyle}>Generating...</span> : null}
          </div>
          {isGenerating ? (
            <div style={loadingPreviewStyle}>
              <span style={spinnerStyle} />
              <span>Building diagram preview</span>
            </div>
          ) : previewSvg ? (
            <div
              className="ai-preview-svg"
              style={previewSvgStyle}
              dangerouslySetInnerHTML={{ __html: previewSvg }}
            />
          ) : (
            <div style={emptyPreviewStyle}>Preview will appear here before anything is inserted.</div>
          )}
        </div>

        {mermaid ? (
          <details style={sourceDetailsStyle}>
            <summary style={summaryStyle}>Mermaid source</summary>
            <pre style={sourceStyle}>{mermaid}</pre>
          </details>
        ) : null}

        <div style={panelActionsStyle}>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button type="submit" disabled={!canGenerate} style={primaryButtonStyle(!canGenerate)}>
            {isGenerating ? "Generating..." : mermaid ? "Regenerate" : "Generate preview"}
          </button>
          <button type="button" onClick={onInsert} disabled={!canInsert} style={insertButtonStyle(!canInsert)}>
            {isInserting ? "Inserting..." : "Insert"}
          </button>
        </div>
      </form>
    </div>
  );
}

async function renderMermaidPreview(source: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      fontFamily: "system-ui, sans-serif",
      fontSize: "15px",
      primaryColor: "#f4f3ff",
      primaryBorderColor: "#4a47b1",
      primaryTextColor: "#19172b",
      lineColor: "#4a47b1",
    },
  });

  const id = `ai-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

async function responseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    return body.detail || body.error || `AI request failed: ${res.status}`;
  } catch {
    return `AI request failed: ${res.status}`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const panelBackdropStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 20,
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "stretch",
  pointerEvents: "none",
  fontFamily: "system-ui, sans-serif",
};

const panelStyle: React.CSSProperties = {
  width: "min(420px, calc(100vw - 24px))",
  margin: 12,
  padding: 16,
  borderRadius: 8,
  border: "1px solid #d8d7e6",
  background: "#ffffff",
  boxShadow: "0 18px 42px rgba(29, 27, 51, 0.18)",
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  alignSelf: "flex-start",
};

const panelHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
};

const panelTitleStyle: React.CSSProperties = {
  fontSize: 16,
  lineHeight: 1.25,
  fontWeight: 650,
  color: "#19172b",
};

const panelSubtitleStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  lineHeight: 1.35,
  color: "#6c6a7c",
};

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: "1px solid #deddeb",
  borderRadius: 6,
  background: "#fff",
  color: "#3c3a4c",
  cursor: "pointer",
  fontSize: 18,
  lineHeight: "24px",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1,
  fontWeight: 650,
  color: "#3c3a4c",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "vertical",
  minHeight: 96,
  border: "1px solid #d8d7e6",
  borderRadius: 8,
  padding: "10px 11px",
  font: "13px/1.45 system-ui, sans-serif",
  color: "#19172b",
  outlineColor: "#4a47b1",
};

const errorStyle: React.CSSProperties = {
  border: "1px solid #f0b7b7",
  background: "#fff4f4",
  color: "#9f1d1d",
  borderRadius: 8,
  padding: "9px 10px",
  fontSize: 12,
  lineHeight: 1.35,
};

const previewShellStyle: React.CSSProperties = {
  border: "1px solid #e0dfeb",
  borderRadius: 8,
  overflow: "hidden",
  background: "#fbfbfd",
};

const previewHeaderStyle: React.CSSProperties = {
  minHeight: 34,
  padding: "0 10px",
  borderBottom: "1px solid #e6e5ef",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 12,
  fontWeight: 650,
  color: "#3c3a4c",
};

const mutedStyle: React.CSSProperties = {
  fontWeight: 500,
  color: "#777486",
};

const loadingPreviewStyle: React.CSSProperties = {
  minHeight: 180,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  color: "#5b5870",
  fontSize: 13,
};

const spinnerStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: "2px solid #d8d7e6",
  borderTopColor: "#4a47b1",
  animation: "ai-spin 0.8s linear infinite",
};

const previewSvgStyle: React.CSSProperties = {
  minHeight: 180,
  maxHeight: 280,
  overflow: "auto",
  padding: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const emptyPreviewStyle: React.CSSProperties = {
  minHeight: 180,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  textAlign: "center",
  color: "#777486",
  fontSize: 13,
  lineHeight: 1.4,
};

const sourceDetailsStyle: React.CSSProperties = {
  border: "1px solid #e6e5ef",
  borderRadius: 8,
  padding: "8px 10px",
};

const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 650,
  color: "#3c3a4c",
};

const sourceStyle: React.CSSProperties = {
  margin: "8px 0 0",
  maxHeight: 120,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#2e2b42",
};

const panelActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  flexWrap: "wrap",
};

const secondaryButtonStyle: React.CSSProperties = {
  border: "1px solid #d8d7e6",
  background: "#fff",
  color: "#3c3a4c",
  borderRadius: 6,
  padding: "7px 11px",
  cursor: "pointer",
  font: "600 13px/1 system-ui, sans-serif",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid #4a47b1",
    background: disabled ? "#deddf5" : "#4a47b1",
    color: "#fff",
    borderRadius: 6,
    padding: "7px 11px",
    cursor: disabled ? "not-allowed" : "pointer",
    font: "600 13px/1 system-ui, sans-serif",
  };
}

function insertButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid #0f6e56",
    background: disabled ? "#d9ebe6" : "#0f6e56",
    color: "#fff",
    borderRadius: 6,
    padding: "7px 12px",
    cursor: disabled ? "not-allowed" : "pointer",
    font: "700 13px/1 system-ui, sans-serif",
  };
}
