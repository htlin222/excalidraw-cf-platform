import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "./Editor";

export interface Me {
  id: string;
  name: string;
  color: string;
}

interface CanvasDoc {
  id: string;
  title: string;
}

interface ShareState {
  active: boolean;
  code: string | null;
  url: string | null;
}

interface ShareResolve {
  document: CanvasDoc;
  share: {
    code: string;
    active: boolean;
  };
}

const emptyShare: ShareState = { active: false, code: null, url: null };

/**
 * Loads the current user and their canvases, then mounts the collaborative
 * editor for the active room from ?room=... or the first available canvas.
 */
export function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [canvases, setCanvases] = useState<CanvasDoc[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [activeShareCode, setActiveShareCode] = useState<string | null>(null);
  const [shareState, setShareState] = useState<ShareState>(emptyShare);
  const [shareManageable, setShareManageable] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const initStarted = useRef(false);
  const skipNextRenameCommit = useRef(false);

  const activateRoom = useCallback((id: string, shareCode: string | null = null) => {
    setRoomId(id);
    setActiveShareCode(shareCode);
    setShareOpen(false);
    setShareError("");
    setCopyStatus("");

    const url = new URL(window.location.href);
    url.pathname = shareCode ? `/share/${shareCode}` : "/";
    url.search = "";
    url.hash = "";
    if (!shareCode) url.searchParams.set("room", id);
    window.history.replaceState(null, "", url.toString());
  }, []);

  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;

    let cancelled = false;
    const url = new URL(window.location.href);
    const requestedRoom = url.searchParams.get("room");
    const requestedShare = shareCodeFromPath(url.pathname);

    async function load() {
      try {
        setLoadError("");
        const meRes = await fetch("/api/me");
        if (!meRes.ok) throw new Error(`me failed: ${meRes.status}`);
        const meData = (await meRes.json()) as Me;

        const docsRes = await fetch("/api/documents");
        if (!docsRes.ok) throw new Error(`documents failed: ${docsRes.status}`);
        let docs = ((await docsRes.json()) as { documents?: CanvasDoc[] }).documents ?? [];

        if (docs.length === 0 && !requestedShare) {
          const created = await createRemoteCanvas("Canvas 1");
          docs = [created];
        }

        if (requestedShare) {
          const sharedRes = await fetch(`/api/share/${encodeURIComponent(requestedShare)}`);
          if (!sharedRes.ok) {
            if (cancelled) return;
            setMe(meData);
            setCanvases(docs);
            setLoadError("This share link is inactive.");
            return;
          }

          const shared = (await sharedRes.json()) as ShareResolve;
          docs = upsertCanvas(docs, shared.document);
          if (cancelled) return;
          setMe(meData);
          setCanvases(docs);
          setShareState({
            active: shared.share.active,
            code: shared.share.code,
            url: shareUrl(shared.share.code),
          });
          activateRoom(shared.document.id, shared.share.code);
          return;
        }

        const active = (requestedRoom && docs.find((doc) => doc.id === requestedRoom)?.id) || docs[0]!.id;
        if (cancelled) return;
        setMe(meData);
        setCanvases(docs);
        activateRoom(active);
      } catch {
        const fallbackRoom = requestedRoom || crypto.randomUUID();
        if (cancelled) return;
        setLoadError("");
        setMe({ id: "guest", name: "Guest", color: "#4a47b1" });
        setCanvases([{ id: fallbackRoom, title: "Canvas 1" }]);
        activateRoom(fallbackRoom);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activateRoom]);

  const addCanvas = useCallback(async () => {
    const title = `Canvas ${canvases.length + 1}`;
    try {
      const created = await createRemoteCanvas(title);
      setCanvases((current) => [created, ...current]);
      activateRoom(created.id);
    } catch {
      const local = { id: crypto.randomUUID(), title };
      setCanvases((current) => [local, ...current]);
      activateRoom(local.id);
    }
  }, [activateRoom, canvases.length]);

  const startRename = useCallback(
    (canvas: CanvasDoc) => {
      skipNextRenameCommit.current = false;
      setRenameError("");
      setRenamingId(canvas.id);
      setRenameDraft(canvas.title);
      activateRoom(canvas.id);
    },
    [activateRoom]
  );

  const cancelRename = useCallback(() => {
    skipNextRenameCommit.current = true;
    setRenamingId(null);
    setRenameDraft("");
  }, []);

  const commitRename = useCallback(async () => {
    if (skipNextRenameCommit.current) {
      skipNextRenameCommit.current = false;
      return;
    }
    if (!renamingId) return;
    const current = canvases.find((canvas) => canvas.id === renamingId);
    if (!current) {
      cancelRename();
      return;
    }

    const nextTitle = normalizeCanvasTitle(renameDraft);
    cancelRename();
    if (nextTitle === current.title) return;

    setRenameError("");
    setCanvases((items) =>
      items.map((canvas) => (canvas.id === renamingId ? { ...canvas, title: nextTitle } : canvas))
    );

    try {
      await renameRemoteCanvas(renamingId, nextTitle);
    } catch {
      setRenameError("Rename saved locally only");
    }
  }, [cancelRename, canvases, renameDraft, renamingId]);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    async function loadShare() {
      setShareBusy(false);
      setShareError("");
      setCopyStatus("");

      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(roomId)}/share`);
        if (!res.ok) throw new Error(`share failed: ${res.status}`);
        const body = (await res.json()) as { share?: ShareState };
        if (cancelled) return;
        setShareManageable(true);
        setShareState(normalizeShareState(body.share));
      } catch {
        if (cancelled) return;
        setShareManageable(false);
        setShareState(
          activeShareCode
            ? { active: true, code: activeShareCode, url: shareUrl(activeShareCode) }
            : emptyShare
        );
      }
    }

    loadShare();
    return () => {
      cancelled = true;
    };
  }, [activeShareCode, roomId]);

  const toggleShare = useCallback(
    async (active: boolean) => {
      if (!roomId) return;
      setShareBusy(true);
      setShareError("");
      setCopyStatus("");

      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(roomId)}/share`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ active }),
        });
        if (!res.ok) throw new Error(res.status === 403 ? "Only the owner can change this link." : "Share update failed.");
        const body = (await res.json()) as { share?: ShareState };
        setShareState(normalizeShareState(body.share));
        setShareManageable(true);
      } catch (err) {
        setShareError(err instanceof Error ? err.message : String(err));
      } finally {
        setShareBusy(false);
      }
    },
    [roomId]
  );

  const copyShareLink = useCallback(async () => {
    if (!shareState.url) return;
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(shareState.url);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
  }, [shareState.url]);

  if (loading) return null;
  if (loadError) return <ShareLoadError message={loadError} />;
  if (!roomId || !me) return null;
  return (
    <div style={appShellStyle}>
      <CanvasTabs
        canvases={canvases}
        activeId={roomId}
        renamingId={renamingId}
        renameDraft={renameDraft}
        renameError={renameError}
        shareState={shareState}
        shareManageable={shareManageable}
        shareOpen={shareOpen}
        shareBusy={shareBusy}
        shareError={shareError}
        copyStatus={copyStatus}
        canManageActiveCanvas={!activeShareCode || shareManageable}
        onSelect={activateRoom}
        onAdd={addCanvas}
        onStartRename={startRename}
        onRenameDraftChange={setRenameDraft}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onShareOpenChange={setShareOpen}
        onToggleShare={toggleShare}
        onCopyShareLink={copyShareLink}
      />
      <div style={editorRegionStyle}>
        <Editor key={`${roomId}:${activeShareCode || ""}`} roomId={roomId} me={me} shareCode={activeShareCode} />
      </div>
    </div>
  );
}

function CanvasTabs({
  canvases,
  activeId,
  renamingId,
  renameDraft,
  renameError,
  shareState,
  shareManageable,
  shareOpen,
  shareBusy,
  shareError,
  copyStatus,
  canManageActiveCanvas,
  onSelect,
  onAdd,
  onStartRename,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onShareOpenChange,
  onToggleShare,
  onCopyShareLink,
}: {
  canvases: CanvasDoc[];
  activeId: string;
  renamingId: string | null;
  renameDraft: string;
  renameError: string;
  shareState: ShareState;
  shareManageable: boolean;
  shareOpen: boolean;
  shareBusy: boolean;
  shareError: string;
  copyStatus: string;
  canManageActiveCanvas: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onStartRename: (canvas: CanvasDoc) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onShareOpenChange: (open: boolean) => void;
  onToggleShare: (active: boolean) => void;
  onCopyShareLink: () => void;
}) {
  const activeCanvas = canvases.find((canvas) => canvas.id === activeId);
  return (
    <div style={tabsBarStyle}>
      <div style={tabsListStyle} role="tablist" aria-label="Canvases">
        {canvases.map((canvas) => {
          const active = canvas.id === activeId;
          const editing = canvas.id === renamingId;
          if (editing) {
            return (
              <form
                key={canvas.id}
                style={renameFormStyle(active)}
                onSubmit={(event) => {
                  event.preventDefault();
                  onCommitRename();
                }}
              >
                <input
                  value={renameDraft}
                  aria-label="Canvas name"
                  onChange={(event) => onRenameDraftChange(event.currentTarget.value)}
                  onBlur={onCommitRename}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onCancelRename();
                    }
                  }}
                  style={renameInputStyle}
                  maxLength={200}
                  autoFocus
                />
              </form>
            );
          }

          return (
            <div key={canvas.id} style={tabGroupStyle(active)}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(canvas.id)}
                onDoubleClick={() => {
                  if (active && canManageActiveCanvas) onStartRename(canvas);
                }}
                style={tabStyle(active)}
                title={active && canManageActiveCanvas ? `${canvas.title} - double click to rename` : canvas.title}
              >
                {canvas.title}
              </button>
              {active && canManageActiveCanvas ? (
                <button
                  type="button"
                  aria-label={`Rename ${canvas.title}`}
                  title="Rename canvas"
                  onClick={() => onStartRename(canvas)}
                  style={renameButtonStyle}
                >
                  ✎
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {renameError ? <span style={renameErrorStyle}>{renameError}</span> : null}
      <div style={shareMenuStyle}>
        <button
          type="button"
          onClick={() => onShareOpenChange(!shareOpen)}
          style={shareButtonStyle(shareState.active)}
          aria-expanded={shareOpen}
          aria-label={`Share ${activeCanvas?.title || "canvas"}`}
        >
          Share
        </button>
        {shareOpen ? (
          <div style={sharePanelStyle}>
            <div style={sharePanelHeaderStyle}>
              <span style={sharePanelTitleStyle}>Live link</span>
              <span style={shareBadgeStyle(shareState.active)}>
                {shareState.active ? "Active" : "Inactive"}
              </span>
            </div>
            <label style={shareToggleStyle}>
              <input
                type="checkbox"
                checked={shareState.active}
                disabled={!shareManageable || shareBusy}
                onChange={(event) => onToggleShare(event.currentTarget.checked)}
              />
              <span>{shareState.active ? "Active" : "Inactive"}</span>
            </label>
            <div style={shareLinkRowStyle}>
              <input
                value={shareState.url ?? ""}
                placeholder="Turn on to create link"
                readOnly
                style={shareInputStyle}
                aria-label="Share link"
              />
              <button
                type="button"
                onClick={onCopyShareLink}
                disabled={!shareState.url}
                style={shareCopyButtonStyle(!shareState.url)}
              >
                Copy
              </button>
            </div>
            {shareError ? <div style={shareErrorStyle}>{shareError}</div> : null}
            {copyStatus ? <div style={shareStatusStyle}>{copyStatus}</div> : null}
            {!shareManageable ? <div style={shareErrorStyle}>Link settings unavailable</div> : null}
          </div>
        ) : null}
      </div>
      <button type="button" onClick={onAdd} style={addTabStyle}>
        New canvas
      </button>
    </div>
  );
}

async function createRemoteCanvas(title: string): Promise<CanvasDoc> {
  const res = await fetch("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`create canvas failed: ${res.status}`);
  return (await res.json()) as CanvasDoc;
}

async function renameRemoteCanvas(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`rename canvas failed: ${res.status}`);
}

function normalizeCanvasTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, " ");
  return title || "Untitled";
}

function shareCodeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/share\/([a-f0-9]{64})$/);
  return match?.[1] ?? null;
}

function shareUrl(code: string): string {
  return new URL(`/share/${code}`, window.location.origin).toString();
}

function upsertCanvas(items: CanvasDoc[], canvas: CanvasDoc): CanvasDoc[] {
  const exists = items.some((item) => item.id === canvas.id);
  if (!exists) return [canvas, ...items];
  return items.map((item) => (item.id === canvas.id ? { ...item, title: canvas.title } : item));
}

function normalizeShareState(share: ShareState | undefined): ShareState {
  if (!share) return emptyShare;
  return {
    active: share.active,
    code: share.code,
    url: share.code ? shareUrl(share.code) : null,
  };
}

function ShareLoadError({ message }: { message: string }) {
  return (
    <div style={loadErrorShellStyle}>
      <div style={loadErrorPanelStyle}>
        <div style={loadErrorTitleStyle}>Share link unavailable</div>
        <div style={loadErrorMessageStyle}>{message}</div>
        <a href="/" style={loadErrorLinkStyle}>
          Open canvases
        </a>
      </div>
    </div>
  );
}

const appShellStyle: React.CSSProperties = {
  height: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "#ffffff",
};

const editorRegionStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
};

const tabsBarStyle: React.CSSProperties = {
  height: 46,
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 12px",
  borderBottom: "1px solid #e4e3ec",
  background: "#fbfbfd",
  fontFamily: "system-ui, sans-serif",
  boxSizing: "border-box",
};

const tabsListStyle: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: 6,
  overflowX: "auto",
};

function tabGroupStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 0,
    maxWidth: 220,
    display: "flex",
    alignItems: "center",
    border: `1px solid ${active ? "#4a47b1" : "#deddeb"}`,
    background: active ? "#f2f1ff" : "#ffffff",
    borderRadius: 7,
    overflow: "hidden",
    flex: "0 0 auto",
  };
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 0,
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    border: 0,
    background: "transparent",
    color: active ? "#252071" : "#4b485b",
    padding: "7px 11px",
    cursor: "pointer",
    font: "650 13px/1 system-ui, sans-serif",
  };
}

const renameButtonStyle: React.CSSProperties = {
  width: 29,
  alignSelf: "stretch",
  display: "grid",
  placeItems: "center",
  border: 0,
  borderLeft: "1px solid rgba(74, 71, 177, 0.18)",
  background: "transparent",
  color: "#4a47b1",
  cursor: "pointer",
  font: "700 14px/1 system-ui, sans-serif",
};

function renameFormStyle(active: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    width: 220,
    maxWidth: "42vw",
    border: `1px solid ${active ? "#4a47b1" : "#deddeb"}`,
    background: "#ffffff",
    borderRadius: 7,
    padding: "2px 7px",
    boxSizing: "border-box",
  };
}

const renameInputStyle: React.CSSProperties = {
  width: "100%",
  height: 24,
  border: 0,
  outline: 0,
  background: "transparent",
  color: "#252071",
  font: "650 13px/1 system-ui, sans-serif",
};

const renameErrorStyle: React.CSSProperties = {
  flex: "0 0 auto",
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#9a3412",
  font: "650 12px/1 system-ui, sans-serif",
};

const shareMenuStyle: React.CSSProperties = {
  position: "relative",
  flex: "0 0 auto",
};

function shareButtonStyle(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? "#0f766e" : "#deddeb"}`,
    background: active ? "#ecfdf5" : "#ffffff",
    color: active ? "#0f5f59" : "#4b485b",
    borderRadius: 7,
    padding: "7px 11px",
    cursor: "pointer",
    font: "700 13px/1 system-ui, sans-serif",
  };
}

const sharePanelStyle: React.CSSProperties = {
  position: "absolute",
  top: 38,
  right: 0,
  zIndex: 40,
  width: 360,
  maxWidth: "calc(100vw - 24px)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  border: "1px solid #d9d7e8",
  borderRadius: 8,
  background: "#ffffff",
  boxShadow: "0 16px 40px rgba(30, 28, 51, 0.16)",
  boxSizing: "border-box",
};

const sharePanelHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
};

const sharePanelTitleStyle: React.CSSProperties = {
  color: "#242233",
  font: "750 13px/1 system-ui, sans-serif",
};

function shareBadgeStyle(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? "#99d5c9" : "#e2e0ea"}`,
    background: active ? "#ecfdf5" : "#f7f7fa",
    color: active ? "#0f6e56" : "#656173",
    borderRadius: 999,
    padding: "4px 8px",
    font: "700 12px/1 system-ui, sans-serif",
  };
}

const shareToggleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#38354a",
  font: "650 13px/1 system-ui, sans-serif",
};

const shareLinkRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 8,
};

const shareInputStyle: React.CSSProperties = {
  minWidth: 0,
  height: 32,
  border: "1px solid #deddeb",
  borderRadius: 7,
  padding: "0 9px",
  color: "#373348",
  background: "#fbfbfd",
  font: "500 12px/1 system-ui, sans-serif",
};

function shareCopyButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid #4a47b1",
    background: disabled ? "#f3f2f8" : "#4a47b1",
    color: disabled ? "#918da2" : "#ffffff",
    borderRadius: 7,
    padding: "0 10px",
    cursor: disabled ? "not-allowed" : "pointer",
    font: "700 12px/1 system-ui, sans-serif",
  };
}

const shareErrorStyle: React.CSSProperties = {
  color: "#9a3412",
  font: "650 12px/1.2 system-ui, sans-serif",
};

const shareStatusStyle: React.CSSProperties = {
  color: "#0f6e56",
  font: "650 12px/1.2 system-ui, sans-serif",
};

const addTabStyle: React.CSSProperties = {
  border: "1px solid #4a47b1",
  background: "#4a47b1",
  color: "#ffffff",
  borderRadius: 7,
  padding: "7px 11px",
  cursor: "pointer",
  font: "700 13px/1 system-ui, sans-serif",
};

const loadErrorShellStyle: React.CSSProperties = {
  minHeight: "100%",
  display: "grid",
  placeItems: "center",
  background: "#fbfbfd",
  fontFamily: "system-ui, sans-serif",
};

const loadErrorPanelStyle: React.CSSProperties = {
  width: 360,
  maxWidth: "calc(100vw - 32px)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 18,
  border: "1px solid #deddeb",
  borderRadius: 8,
  background: "#ffffff",
  boxSizing: "border-box",
};

const loadErrorTitleStyle: React.CSSProperties = {
  color: "#252071",
  font: "760 16px/1.2 system-ui, sans-serif",
};

const loadErrorMessageStyle: React.CSSProperties = {
  color: "#5f5a70",
  font: "500 13px/1.35 system-ui, sans-serif",
};

const loadErrorLinkStyle: React.CSSProperties = {
  color: "#4a47b1",
  font: "700 13px/1 system-ui, sans-serif",
  textDecoration: "none",
};
