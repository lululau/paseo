# Standalone Node.js Relay Server

## Summary

Add a standalone Node.js WebSocket relay server (`packages/relay/src/node-server.ts`) that implements the same v1/v2 relay protocol as the existing Cloudflare Durable Objects adapter, deployable on any Linux server with nginx/caddy as TLS reverse proxy.

## Motivation

The current relay implementation (`cloudflare-adapter.ts`) is tightly coupled to Cloudflare Workers + Durable Objects. Users who want to self-host need a Cloudflare paid plan. A standalone Node.js server allows deployment on any Linux VPS with no external dependencies.

## Architecture

```
[Daemon] --ws--> [nginx :443 wss] --ws://127.0.0.1:8080--> [relay-server]
[Client] --wss-> [nginx :443 wss] --ws://127.0.0.1:8080--> [relay-server]
```

### Components

**`packages/relay/src/node-server.ts`** (~400 lines)

Single-file Node.js HTTP + WebSocket server using `ws` (already a dependency). Reuses `RelaySessionAttachment` type from `types.ts`.

**Session state** (`Map<serverId, RelaySession>`):

```
RelaySession = {
  controlSocket: WS | null          // v2 daemon control channel (one per serverId)
  dataSockets: Map<connId, WS>      // v2 daemon per-connection data sockets
  clientSockets: Map<connId, Set<WS>>  // client sockets (many per connId)
  pendingFrames: Map<connId, Array>    // message buffer (max 200 per connId)
}
```

**Attachment storage**: `WeakMap<WebSocket, RelaySessionAttachment>` replaces Cloudflare's `serializeAttachment/deserializeAttachment`.

**Tag-based lookup**: Direct field access on `RelaySession` replaces Cloudflare's `getWebSockets(tag)`.

### HTTP Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/health` | GET | `{ status: "ok" }` |
| `/ws?serverId=...&role=...&v=...&connectionId=...` | GET (upgrade) | WebSocket upgrade |

### Protocol

Identical to `cloudflare-adapter.ts`:

- **v1**: Simple server<->client bidirectional forwarding
- **v2**: Control + per-connection data sockets
  - Control messages: `sync`, `connected`, `disconnected`, `ping`, `pong`
  - Message buffering (up to 200 frames per connectionId) when server data socket not yet connected
  - Stale detection: nudge at 10s, force-close control at 15s if no response
  - Ping/pong keepalive on control channel

### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` | Listen host (bind localhost for reverse proxy) |

Command-line: `npx tsx packages/relay/src/node-server.ts` or `node dist/node-server.js` after build.

### package.json Changes

Add new export entry:

```json
{
  "exports": {
    "./node-server": {
      "import": "./src/node-server.ts",
      "default": "./src/node-server.ts"
    }
  }
}
```

Add bin entry for CLI usage:

```json
{
  "bin": {
    "paseo-relay": "./dist/node-server.js"
  }
}
```

## Deployment

### systemd unit (`/etc/systemd/system/paseo-relay.service`)

```ini
[Unit]
Description=Paseo Relay Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/paseo-relay/dist/node-server.js
Environment=PORT=8080
Environment=HOST=127.0.0.1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### nginx config

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate /etc/ssl/relay.example.com.pem;
    ssl_certificate_key /etc/ssl/relay.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Daemon configuration

```bash
export PASEO_RELAY_ENDPOINT="relay.example.com:443"
```

Port 443 triggers `wss://` automatically via `buildRelayWebSocketUrl`.

## What's NOT included

- No TLS termination (handled by nginx/caddy)
- No persistence (in-memory only, same as Cloudflare DO)
- No authentication/authorization (relay is zero-trust by design, E2EE handles security)
- No metrics/monitoring beyond health check
- No clustering/HA (single process, adequate for personal/small-team use)

## Files to create/modify

| File | Action |
|------|--------|
| `packages/relay/src/node-server.ts` | **Create** - standalone relay server |
| `packages/relay/package.json` | **Modify** - add bin entry and export |
