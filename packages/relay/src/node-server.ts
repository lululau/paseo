#!/usr/bin/env node

/**
 * Standalone Node.js relay server.
 *
 * Implements the same v1/v2 relay protocol as `cloudflare-adapter.ts`,
 * deployable on any Linux server with nginx/caddy as TLS reverse proxy.
 *
 * Usage:
 *   npx tsx packages/relay/src/node-server.ts
 *   PORT=9090 HOST=0.0.0.0 npx tsx packages/relay/src/node-server.ts
 */

import { createServer } from "node:http";
import type { Socket } from "node:net";
import WebSocket from "ws";
import type { IncomingMessage } from "node:http";
import type { ConnectionRole, RelaySessionAttachment } from "./types.js";
import type { WebSocket as WS } from "ws";

// ── Config ──────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

// ── Types ───────────────────────────────────────────────────────────

type RelayProtocolVersion = "1" | "2";

const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

type RelaySession = {
  /** v2 daemon control channel — one per serverId */
  controlSocket: WebSocket | null;
  /** v2 daemon per-connection data sockets */
  dataSockets: Map<string, WebSocket>;
  /** client sockets — many per connectionId allowed */
  clientSockets: Map<string, Set<WebSocket>>;
  /** message buffer when server data socket not yet connected */
  pendingFrames: Map<string, Array<string | ArrayBuffer>>;
};

// ── State ───────────────────────────────────────────────────────────

const sessions = new Map<string, RelaySession>();
const attachments = new WeakMap<WebSocket, RelaySessionAttachment>();

// ── Helpers ─────────────────────────────────────────────────────────

function resolveRelayVersion(rawValue: string | null): RelayProtocolVersion | null {
  if (rawValue == null) return LEGACY_RELAY_VERSION;
  const value = rawValue.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) return value;
  return null;
}

function getOrCreateSession(serverId: string): RelaySession {
  let session = sessions.get(serverId);
  if (!session) {
    session = {
      controlSocket: null,
      dataSockets: new Map(),
      clientSockets: new Map(),
      pendingFrames: new Map(),
    };
    sessions.set(serverId, session);
  }
  return session;
}

function removeSessionIfEmpty(serverId: string): void {
  const session = sessions.get(serverId);
  if (!session) return;
  if (
    !session.controlSocket &&
    session.dataSockets.size === 0 &&
    session.clientSockets.size === 0
  ) {
    sessions.delete(serverId);
  }
}

// ── Control channel helpers ─────────────────────────────────────────

function notifyControls(session: RelaySession, message: unknown): void {
  if (!session.controlSocket) return;
  const text = JSON.stringify(message);
  try {
    session.controlSocket.send(text);
  } catch {
    try {
      session.controlSocket.close(1011, "Control send failed");
    } catch {
      // ignore
    }
    session.controlSocket = null;
  }
}

function listConnectedConnectionIds(session: RelaySession): string[] {
  const out = new Set<string>();
  for (const [connectionId, sockets] of session.clientSockets) {
    if (sockets.size > 0) out.add(connectionId);
  }
  return Array.from(out);
}

// ── Frame buffering ─────────────────────────────────────────────────

function bufferFrame(
  session: RelaySession,
  connectionId: string,
  message: string | ArrayBuffer,
): void {
  const existing = session.pendingFrames.get(connectionId) ?? [];
  existing.push(message);
  if (existing.length > 200) {
    existing.splice(0, existing.length - 200);
  }
  session.pendingFrames.set(connectionId, existing);
}

function flushFrames(session: RelaySession, connectionId: string, serverWs: WebSocket): void {
  const frames = session.pendingFrames.get(connectionId);
  if (!frames || frames.length === 0) return;
  session.pendingFrames.delete(connectionId);
  for (const frame of frames) {
    try {
      serverWs.send(frame);
    } catch {
      bufferFrame(session, connectionId, frame);
      break;
    }
  }
}

// ── Stale control detection ─────────────────────────────────────────

function nudgeOrResetControlForConnection(session: RelaySession, connectionId: string): void {
  const initialDelayMs = 10_000;
  const secondDelayMs = 5_000;

  setTimeout(() => {
    const clients = session.clientSockets.get(connectionId);
    if (!clients || clients.size === 0) return;
    if (session.dataSockets.has(connectionId)) return;

    notifyControls(session, { type: "sync", connectionIds: listConnectedConnectionIds(session) });

    setTimeout(() => {
      const clients = session.clientSockets.get(connectionId);
      if (!clients || clients.size === 0) return;
      if (session.dataSockets.has(connectionId)) return;

      if (session.controlSocket) {
        try {
          session.controlSocket.close(1011, "Control unresponsive");
        } catch {
          // ignore
        }
        session.controlSocket = null;
      }
    }, secondDelayMs);
  }, initialDelayMs);
}

// ── Message routing ─────────────────────────────────────────────────

function handleMessage(ws: WebSocket, message: string | ArrayBuffer): void {
  const attachment = attachments.get(ws);
  if (!attachment) return;

  const version = attachment.version ?? LEGACY_RELAY_VERSION;
  const session = sessions.get(attachment.serverId);
  if (!session) return;

  // v1: simple bidirectional forwarding
  if (version === LEGACY_RELAY_VERSION) {
    const targetRole = attachment.role === "server" ? "client" : "server";
    const targets =
      targetRole === "server"
        ? Array.from(session.dataSockets.values())
        : Array.from(session.clientSockets.values()).flatMap((s) => Array.from(s));
    for (const target of targets) {
      try {
        target.send(message);
      } catch (error) {
        console.error(`[Relay] Failed to forward to ${targetRole}:`, error);
      }
    }
    return;
  }

  // v2
  const { role, connectionId } = attachment;
  if (!connectionId) {
    // Control channel: handle ping/pong keepalive
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message) as { type?: unknown };
        if (parsed?.type === "ping") {
          try {
            ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore non-JSON
      }
    }
    return;
  }

  if (role === "client") {
    // client -> server data socket
    const serverWs = session.dataSockets.get(connectionId);
    if (!serverWs) {
      bufferFrame(session, connectionId, message);
      return;
    }
    try {
      serverWs.send(message);
    } catch (error) {
      console.error(`[Relay] Failed to forward client->server(${connectionId}):`, error);
    }
    return;
  }

  // server data socket -> all client sockets
  const clients = session.clientSockets.get(connectionId);
  if (!clients) return;
  for (const target of clients) {
    try {
      target.send(message);
    } catch (error) {
      console.error(`[Relay] Failed to forward server->client(${connectionId}):`, error);
    }
  }
}

// ── Close handling ──────────────────────────────────────────────────

function handleClose(ws: WebSocket, code: number, reason: string): void {
  const attachment = attachments.get(ws);
  if (!attachment) return;

  const version = attachment.version ?? LEGACY_RELAY_VERSION;
  const session = sessions.get(attachment.serverId);
  if (!session) return;

  console.log(
    `[Relay] v${version}:${attachment.role}${attachment.connectionId ? `(${attachment.connectionId})` : ""} disconnected from ${attachment.serverId} (${code}: ${reason})`,
  );

  if (version === LEGACY_RELAY_VERSION) {
    removeSessionIfEmpty(attachment.serverId);
    return;
  }

  const { connectionId } = attachment;

  if (attachment.role === "client" && connectionId) {
    const clients = session.clientSockets.get(connectionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        session.clientSockets.delete(connectionId);
        session.pendingFrames.delete(connectionId);
        // Close matching server data socket
        const serverWs = session.dataSockets.get(connectionId);
        if (serverWs) {
          try {
            serverWs.close(1001, "Client disconnected");
          } catch {
            // ignore
          }
          session.dataSockets.delete(connectionId);
        }
        notifyControls(session, { type: "disconnected", connectionId });
      }
    }
    removeSessionIfEmpty(attachment.serverId);
    return;
  }

  if (attachment.role === "server" && connectionId) {
    session.dataSockets.delete(connectionId);
    // Force client reconnection
    const clients = session.clientSockets.get(connectionId);
    if (clients) {
      for (const clientWs of clients) {
        try {
          clientWs.close(1012, "Server disconnected");
        } catch {
          // ignore
        }
      }
      session.clientSockets.delete(connectionId);
    }
    session.pendingFrames.delete(connectionId);
    removeSessionIfEmpty(attachment.serverId);
    return;
  }

  // Control socket close
  if (attachment.role === "server" && !connectionId) {
    session.controlSocket = null;
    removeSessionIfEmpty(attachment.serverId);
  }
}

// ── WebSocket upgrade handler ───────────────────────────────────────

function handleUpgrade(
  ws: WebSocket,
  serverId: string,
  role: ConnectionRole,
  version: RelayProtocolVersion,
  connectionIdRaw: string,
): void {
  const session = getOrCreateSession(serverId);

  if (version === LEGACY_RELAY_VERSION) {
    // v1: close existing same-role sockets, register new one
    if (role === "server") {
      for (const [, existing] of session.dataSockets) {
        try {
          existing.close(1008, "Replaced by new connection");
        } catch {
          /* */
        }
      }
      session.dataSockets.clear();
    } else {
      for (const [, sockets] of session.clientSockets) {
        for (const s of sockets) {
          try {
            s.close(1008, "Replaced by new connection");
          } catch {
            /* */
          }
        }
      }
      session.clientSockets.clear();
    }

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: LEGACY_RELAY_VERSION,
      connectionId: null,
      createdAt: Date.now(),
    };
    attachments.set(ws, attachment);

    // Store v1 sockets in dataSockets/clientSockets with a special key
    if (role === "server") {
      session.dataSockets.set("__v1__", ws);
    } else {
      const set = new Set<WebSocket>();
      set.add(ws);
      session.clientSockets.set("__v1__", set);
    }

    console.log(`[Relay] v1:${role} connected to session ${serverId}`);
    return;
  }

  // v2
  const resolvedConnectionId =
    role === "client" && !connectionIdRaw
      ? `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      : connectionIdRaw;

  const isServerControl = role === "server" && !resolvedConnectionId;
  const isServerData = role === "server" && !!resolvedConnectionId;

  // Replace existing same-identity sockets
  if (isServerControl && session.controlSocket) {
    try {
      session.controlSocket.close(1008, "Replaced by new connection");
    } catch {
      /* */
    }
    session.controlSocket = null;
  } else if (isServerData) {
    const existing = session.dataSockets.get(resolvedConnectionId);
    if (existing) {
      try {
        existing.close(1008, "Replaced by new connection");
      } catch {
        /* */
      }
      session.dataSockets.delete(resolvedConnectionId);
    }
  }

  const attachment: RelaySessionAttachment = {
    serverId,
    role,
    version: CURRENT_RELAY_VERSION,
    connectionId: resolvedConnectionId || null,
    createdAt: Date.now(),
  };
  attachments.set(ws, attachment);

  if (role === "client") {
    let clients = session.clientSockets.get(resolvedConnectionId);
    if (!clients) {
      clients = new Set();
      session.clientSockets.set(resolvedConnectionId, clients);
    }
    clients.add(ws);
    notifyControls(session, { type: "connected", connectionId: resolvedConnectionId });
    nudgeOrResetControlForConnection(session, resolvedConnectionId);
  } else if (isServerControl) {
    session.controlSocket = ws;
    // Send sync with current connections
    try {
      ws.send(JSON.stringify({ type: "sync", connectionIds: listConnectedConnectionIds(session) }));
    } catch {
      // ignore
    }
  } else if (isServerData) {
    session.dataSockets.set(resolvedConnectionId, ws);
    flushFrames(session, resolvedConnectionId, ws);
  }

  console.log(
    `[Relay] v2:${role}${isServerControl ? "(control)" : ""}${isServerData ? `(data:${resolvedConnectionId})` : role === "client" ? `(${resolvedConnectionId})` : ""} connected to session ${serverId}`,
  );
}

// ── HTTP + WebSocket server ─────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new (WebSocket as any).Server({ noServer: true }) as {
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, cb: (ws: WS) => void): void;
};

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const role = url.searchParams.get("role") as ConnectionRole | null;
  const serverId = url.searchParams.get("serverId");
  const connectionIdRaw = url.searchParams.get("connectionId");
  const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";
  const version = resolveRelayVersion(url.searchParams.get("v"));

  if (!role || (role !== "server" && role !== "client")) {
    socket.destroy();
    return;
  }
  if (!serverId) {
    socket.destroy();
    return;
  }
  if (!version) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WS) => {
    handleUpgrade(ws, serverId, role, version, connectionId);

    ws.on("message", (data: string | ArrayBuffer | Buffer) => {
      handleMessage(ws, typeof data === "string" ? data : (data as ArrayBuffer));
    });

    ws.on("close", (code: number, reason: Buffer) => {
      handleClose(ws, code, reason.toString());
    });

    ws.on("error", (error: Error) => {
      const attachment = attachments.get(ws);
      console.error(`[Relay] WebSocket error for ${attachment?.role ?? "unknown"}:`, error);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[Relay] Listening on ${HOST}:${PORT}`);
});
