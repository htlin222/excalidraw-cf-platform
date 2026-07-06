import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { RoomClient, shouldReplace } from "./collab/RoomClient";
import type { SyncElement, PresenceUser, PointerMessage } from "./collab/RoomClient";
import type { Me } from "./App";

// Excalidraw's imperative API and element types vary slightly between versions; kept
// loose here on purpose. If a build error names a renamed export, check the installed
// @excalidraw/excalidraw version (see CLAUDE.md, Phase 6) before editing.
type ExcalidrawAPI = any;

export function Editor({ roomId, me }: { roomId: string; me: Me }) {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const clientRef = useRef<RoomClient | null>(null);
  // The version we last sent OR applied per element id — prevents rebroadcast loops.
  const lastVersions = useRef<Map<string, number>>(new Map());
  const collaborators = useRef<Map<string, any>>(new Map());
  const [status, setStatus] = useState("connecting…");

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
    const client = new RoomClient(roomId, me as PresenceUser, {
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
    });
    clientRef.current = client;
    return () => client.close();
  }, [roomId, me, applyRemote]);

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

  const generateDiagram = useCallback(async () => {
    const prompt = window.prompt("Describe the diagram to generate:");
    if (!prompt) return;
    try {
      const res = await fetch("/api/ai/diagram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
      const { mermaid } = (await res.json()) as { mermaid: string };

      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const { elements: skeleton } = await parseMermaidToExcalidraw(mermaid);
      const newElements = convertToExcalidrawElements(skeleton);

      const api = apiRef.current;
      if (!api) return;
      const merged = [...api.getSceneElementsIncludingDeleted(), ...newElements];
      api.updateScene({ elements: merged });
      // onChange will pick up and broadcast the new elements.
    } catch (err) {
      alert(String(err));
    }
  }, []);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <Toolbar status={status} onGenerate={generateDiagram} />
      <Excalidraw
        excalidrawAPI={(api: ExcalidrawAPI) => (apiRef.current = api)}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating
      />
    </div>
  );
}

function Toolbar({ status, onGenerate }: { status: string; onGenerate: () => void }) {
  return (
    <div
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
