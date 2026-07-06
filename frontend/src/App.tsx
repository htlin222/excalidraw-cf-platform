import { useEffect, useState } from "react";
import { Editor } from "./Editor";

export interface Me {
  id: string;
  name: string;
  color: string;
}

/**
 * Resolves the room from ?room=... (creating one if absent) and the current user from
 * /api/me, then mounts the collaborative editor. This is intentionally minimal — the
 * home screen / document list (PLAN.md Milestone 2) goes here later.
 */
export function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    let room = url.searchParams.get("room");
    if (!room) {
      room = crypto.randomUUID();
      url.searchParams.set("room", room);
      window.history.replaceState(null, "", url.toString());
    }
    setRoomId(room);

    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: Me) => setMe(data))
      .catch(() => {
        // Unauthenticated (no Access app / no dev bypass) — fall back to a local identity
        // so the editor still renders. Real deployments sit behind Cloudflare Access.
        setMe({ id: crypto.randomUUID(), name: "Guest", color: "#4a47b1" });
      });
  }, []);

  if (!roomId || !me) return null;
  return <Editor roomId={roomId} me={me} />;
}
