# master-mcp

Ein einziger MCP-Server (stdio, TypeScript) für die Admin-Verwaltung von:

- **Cloudflare** (Zonen, DNS, Cache, Firewall/WAF, Custom Hostnames, Zone-Settings, Analytics)
- **Porkbun** (Domains, DNS, URL-Forwarding, Nameserver, SSL-Bundle, Pricing)
- **Docker** (Container, Images, Volumes, Netzwerke, Stats, Logs - lokaler Socket oder Remote-TCP)
- **Proxmox VE** (Nodes, VMs/LXCs, Snapshots, Backups, Storage, Cluster, Tasks)
- **Nginx Proxy Manager / NPMPlus** (Proxy-Hosts, Redirects, Streams, Access-Lists, Zertifikate, Users)
- **Uptime Kuma** (Monitore, Heartbeats, Wartungsfenster, Status-Pages, Notifications)
- **Authentik** (Users, Gruppen, Applications, Providers, Outposts, Flows, Events, Invitations)

## Architektur

Token-effizientes **Search+Execute**-Pattern statt eines Tools pro Aktion: der Server
exponiert nur drei MCP-Tools (`list_services`, `list_actions`, `execute_action`); die
eigentlichen ~120 Aktionen liegen serverseitig in einem Katalog und werden erst bei
Bedarf per Freitextsuche gefunden.

Jeder Dienst kann **mehrere benannte Instanzen** mit eigenen Zugangsdaten/Zielen haben
(z.B. zwei Docker-Hosts oder zwei Proxmox-Nodes) - siehe `.env.example`.

```
src/
  core/
    types.ts       - ActionDef/ServiceModule/InstanceConfig Interfaces
    instances.ts    - Multi-Instanz-Discovery aus ENV-Variablen
    registry.ts     - Katalog, Suche, Instanz-Auflösung
    http.ts         - axios-Client-Helper
  services/
    cloudflare.ts, porkbun.ts, docker.ts, proxmox.ts, npm.ts, uptimeKuma.ts, authentik.ts
    index.ts        - Aggregiert alle ServiceModules
  index.ts           - MCP-Server-Wiring (stdio)
```

## Setup

```bash
npm install
cp .env.example .env   # eintragen, welche Dienste genutzt werden
npm run build
```

## In Claude Code registrieren

```bash
claude mcp add master-mcp -- node /pfad/zu/masterMCP/dist/index.js
```

(oder die passende Konfiguration in `claude_desktop_config.json` / MCP-Client
deiner Wahl - stdio-Transport, Env-Variablen aus `.env` werden beim Start via
`dotenv` geladen.)

## Entwicklung

```bash
npm run dev        # tsx, ohne Build
npm run typecheck
npm test           # vitest, 133 Tests über alle 7 Module
npm run build
```

## Sicherheit

- Alle Credentials kommen ausschließlich aus Umgebungsvariablen (`.env`, nie committen).
- `execute_action` markiert jede Aktion als `readOnly`/`destructive` - destruktive
  Aktionen (Löschen, Stop/Reboot, Prune, ...) sind klar gekennzeichnet.
- `insecureTls`-Felder (Proxmox, NPM, Authentik, Docker-TLS) sind Opt-in und
  standardmäßig `false` - nur für selbstsignierte LAN-Zertifikate gedacht.
