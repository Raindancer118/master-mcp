# master-mcp

Ein einziger MCP-Server (stdio, TypeScript) für die Admin-Verwaltung von:

- **Cloudflare** (Zonen, DNS, Cache, Firewall/WAF, Custom Hostnames, Zone-Settings, Analytics)
- **Porkbun** (Domains, DNS, URL-Forwarding, Nameserver, SSL-Bundle, Pricing)
- **Docker** (Container, Images, Volumes, Netzwerke, Stats, Logs - lokaler Socket oder Remote-TCP)
- **Proxmox VE** (Nodes, VMs/LXCs, Snapshots, Backups, Storage, Cluster, Tasks)
- **Nginx Proxy Manager / NPMPlus** (Proxy-Hosts, Redirects, Streams, Access-Lists, Zertifikate, Users)
- **Uptime Kuma** (Monitore, Heartbeats, Wartungsfenster, Status-Pages, Notifications)
- **Authentik** (Users, Gruppen, Applications, Providers, Outposts, Flows, Events, Invitations)
- **Coolify** (Applications, Deployments, Datenbanken, Services, Server, Projekte, Teams)

## Alle Aktionen im Detail

Der Server exponiert selbst nur drei MCP-Tools (`list_services`, `list_actions`,
`execute_action` - siehe [Architektur](#architektur)). Die eigentlichen ~150 Aktionen
sind serverseitig in einem Katalog organisiert; hier die vollständige Liste je Dienst.
Jede Aktion wird über `execute_action` mit `service`, `action`, optional `instance` und
den unten genannten Parametern aufgerufen. **⚠️** markiert destruktive Aktionen
(Löschen/Stop/Prune/... - irreversibel oder zustandsändernd mit Risiko).

### Cloudflare (21 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_zones` | Zonen (Domains) im Account auflisten, optional nach Name gefiltert |
| `get_zone` | Details einer einzelnen Zone per ID |
| `list_dns_records` | DNS-Records einer Zone auflisten, optional nach Typ/Name gefiltert |
| `create_dns_record` | Neuen DNS-Record (A, AAAA, CNAME, TXT, MX, ...) anlegen |
| `update_dns_record` ⚠️ | Felder eines bestehenden DNS-Records ändern |
| `delete_dns_record` ⚠️ | DNS-Record löschen |
| `purge_cache` ⚠️ | Edge-Cache einer Zone leeren (bestimmte Dateien oder alles) |
| `list_firewall_rules` | (Legacy) Firewall-Regeln einer Zone auflisten |
| `get_zone_settings` | Alle Zone-Settings lesen (SSL-Modus, Always-Online, Minify, ...) |
| `update_zone_setting` ⚠️ | Ein Zone-Setting ändern (z.B. `ssl`, `security_level`, `min_tls_version`) |
| `list_page_rules` | Page Rules einer Zone auflisten |
| `create_page_rule` | Page Rule mit Ziel-URL-Muster und Aktionen anlegen |
| `delete_page_rule` ⚠️ | Page Rule löschen |
| `list_ip_access_rules` | IP/Land/ASN-Zugriffsregeln (Block/Challenge/Whitelist) auflisten |
| `create_ip_access_rule` | IP/IP-Range/Land/ASN-Zugriffsregel anlegen |
| `delete_ip_access_rule` ⚠️ | IP-Zugriffsregel löschen |
| `list_certificate_packs` | SSL/TLS-Zertifikatspakete einer Zone auflisten |
| `list_custom_hostnames` | Custom Hostnames (SSL for SaaS) auflisten |
| `create_custom_hostname` | Custom Hostname anlegen |
| `delete_custom_hostname` ⚠️ | Custom Hostname löschen |
| `list_zone_analytics` | Analytics-Dashboard-Summen (Requests, Bandbreite, Threats) für einen Zeitraum |

### Porkbun (13 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `ping` | API-Erreichbarkeit prüfen, liefert die öffentliche IP zurück - guter Smoke-Test |
| `list_domains` | Alle Domains im Account auflisten (paginiert, optional mit Labels) |
| `get_dns_records` | DNS-Records einer Domain abrufen (per ID, per Typ+Subdomain, oder alle) |
| `create_dns_record` | Neuen DNS-Record anlegen |
| `edit_dns_record` ⚠️ | Bestehenden DNS-Record ändern |
| `delete_dns_record` ⚠️ | DNS-Record löschen |
| `update_nameservers` ⚠️ | Autoritative Nameserver einer Domain ändern (wirkt global auf die Auflösung) |
| `get_ssl_bundle` | Kostenloses SSL-Zertifikatsbündel (Chain, Private Key, Public Key) abrufen |
| `get_url_forwarding` | Bestehende URL-Weiterleitungen einer Domain auflisten |
| `add_url_forwarding` | URL-Weiterleitung für Domain/Subdomain anlegen |
| `delete_url_forwarding` ⚠️ | URL-Weiterleitung löschen |
| `get_nameservers` | Aktuelle Nameserver einer Domain abrufen |
| `check_domain_pricing` | Porkbuns TLD-Preisliste abrufen (Registrierung, Verlängerung, Transfer) |

### Docker (25 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_containers` | Container auflisten (per Default nur laufende, `all=true` inkl. gestoppter) |
| `inspect_container` | Vollständige Inspect-Details (Config, State, Mounts, Netzwerk) eines Containers |
| `start_container` | Gestoppten Container starten |
| `stop_container` ⚠️ | Laufenden Container stoppen, optional mit Grace-Timeout |
| `restart_container` ⚠️ | Container neu starten, optional mit Grace-Timeout |
| `remove_container` ⚠️ | Container entfernen, optional forciert + inkl. Volumes |
| `container_logs` | Aktuelle stdout/stderr-Logs (mit Zeitstempeln) abrufen |
| `list_images` | Vorhandene Images auf dem Host auflisten |
| `pull_image` | Image (optional bestimmter Tag) aus der Registry ziehen |
| `list_volumes` | Volumes auf dem Host auflisten |
| `list_networks` | Netzwerke auf dem Host auflisten |
| `docker_info` | Kompakte Host-Zusammenfassung (Container-/Image-Zahlen, Version, OS, CPU, RAM) |
| `rename_container` ⚠️ | Container umbenennen |
| `container_stats` | Momentaufnahme der Ressourcennutzung (CPU %, Speicher, Netzwerk-I/O) |
| `container_processes` | Laufende Prozesse in einem Container auflisten (wie `docker top`) |
| `create_container` | Neuen Container aus einem Image anlegen, optional sofort starten |
| `prune_containers` ⚠️ | Alle gestoppten Container entfernen |
| `remove_image` ⚠️ | Image entfernen, optional forciert |
| `tag_image` | Neues repo:tag auf ein bestehendes Image anwenden |
| `prune_images` ⚠️ | Ungenutzte Images entfernen (per Default nur dangling) |
| `create_network` | Netzwerk anlegen (Default-Driver: bridge) |
| `remove_network` ⚠️ | Netzwerk entfernen |
| `create_volume` | Volume anlegen (Default-Driver: local) |
| `remove_volume` ⚠️ | Volume entfernen, optional forciert |
| `prune_volumes` ⚠️ | Alle ungenutzten Volumes entfernen |

### Proxmox VE (19 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_nodes` | Cluster-Nodes mit Status, CPU, Memory, Uptime auflisten |
| `list_guests` | VMs (qemu) und/oder LXC-Container auflisten, pro Node oder Cluster-weit |
| `get_guest_status` | Aktuellen Status (running/stopped, CPU, Mem, Uptime) einer VM/eines LXC abrufen |
| `start_guest` | Gestoppte VM/LXC starten |
| `stop_guest` ⚠️ | VM/LXC hart stoppen (wie Stromstecker ziehen) - Datenverlust bei ungesichertem Zustand möglich |
| `shutdown_guest` ⚠️ | VM/LXC per ACPI/Agent-Signal sauber herunterfahren |
| `reboot_guest` ⚠️ | VM/LXC sauber neu starten |
| `list_storage` | Storage-Pools auflisten (pro Node oder Cluster-Konfiguration) |
| `cluster_status` | Cluster-Status: Member-Nodes, Quorum, Cluster-Info |
| `get_guest_config` | Konfiguration (Cores, Memory, Disks, Netzwerk, ...) einer VM/eines LXC abrufen |
| `update_guest_config` ⚠️ | Konfiguration (Cores, Memory, Beschreibung) einer VM/eines LXC ändern |
| `list_snapshots` | Snapshots einer VM/eines LXC auflisten |
| `create_snapshot` | Neuen Snapshot anlegen |
| `delete_snapshot` ⚠️ | Snapshot löschen |
| `rollback_snapshot` ⚠️ | VM/LXC auf einen Snapshot zurücksetzen, verwirft den aktuellen Zustand |
| `list_backups` | Backup-Archive auf einem Node auflisten (bestimmter Storage oder alle) |
| `get_node_status` | Detaillierten Node-Status abrufen (Uptime, Load, Memory, CPU) |
| `list_users` | Proxmox-Zugriffskontroll-Benutzer auflisten |
| `get_task_status` | Status eines Background-Tasks per UPID abfragen (z.B. laufenden Start/Stop/Snapshot-Task pollen) |

### Nginx Proxy Manager / NPMPlus (19 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_proxy_hosts` | Alle Proxy-Hosts auflisten, inkl. Owner/Access-List/Zertifikat-Details wenn unterstützt |
| `create_proxy_host` | Neuen Reverse-Proxy-Host anlegen (Domain(s) → Forward-Ziel, SSL/Caching/Security-Optionen) |
| `update_proxy_host` ⚠️ | Forward-Ziel, Domains, SSL oder Security-Einstellungen eines Hosts ändern |
| `delete_proxy_host` ⚠️ | Proxy-Host löschen |
| `enable_proxy_host` | Deaktivierten Proxy-Host aktivieren |
| `disable_proxy_host` ⚠️ | Proxy-Host deaktivieren - nimmt die dahinterliegende Seite offline |
| `list_redirection_hosts` | Konfigurierte Redirection-Hosts (Domain-Weiterleitungen) auflisten |
| `list_streams` | Konfigurierte TCP/UDP-Streams auflisten |
| `list_access_lists` | Konfigurierte Access-Lists (Basic-Auth/Allow-Deny-Regeln) auflisten |
| `list_certificates` | Bekannte SSL-Zertifikate auflisten |
| `list_users` | NPM/NPMPlus-Benutzer auflisten |
| `create_user` | Neuen NPM-Benutzer anlegen und Passwort setzen (zweistufig: User anlegen, dann Auth setzen) |
| `update_user` ⚠️ | Name/Nickname/E-Mail/Admin-Rolle/Disabled-Status eines Benutzers ändern |
| `delete_user` ⚠️ | NPM-Benutzer löschen |
| `list_dead_hosts` | Konfigurierte 404/Catch-all-("Dead")-Hosts auflisten |
| `list_settings` | Alle NPM/NPMPlus-Anwendungseinstellungen auflisten |
| `update_setting` ⚠️ | Eine Anwendungseinstellung per ID ändern (z.B. `default-site`) |
| `request_letsencrypt_certificate` | Neues Let's-Encrypt-Zertifikat für eine oder mehrere Domains anfordern |
| `delete_certificate` ⚠️ | SSL-Zertifikat löschen |

### Uptime Kuma (11 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_monitors` | Alle Monitore (ID, Name, Typ, URL/Hostname, Aktiv-Status, Check-Intervall) auflisten |
| `get_monitor_beats` | Historische Heartbeats (Up/Down über die Zeit) für einen Monitor, über einen Zeitraum in Stunden |
| `pause_monitor` ⚠️ | Monitor pausieren - stoppt Checks und Alerting bis zur Wiederaufnahme |
| `resume_monitor` | Pausierten Monitor wieder aktivieren |
| `delete_monitor` ⚠️ | Monitor und dessen Historie dauerhaft löschen |
| `add_http_monitor` | Neuen HTTP(s)-Monitor anlegen, der eine URL periodisch auf Erreichbarkeit prüft |
| `edit_monitor` ⚠️ | Name/URL/Check-Intervall/Retry-Intervall/Resend-Intervall/Aktiv-Status eines Monitors ändern |
| `list_notifications` | Konfigurierte Notification-Provider (E-Mail, Discord, Telegram, ...) auflisten |
| `list_maintenance` | Konfigurierte Wartungsfenster auflisten |
| `add_maintenance` | Wartungsfenster anlegen, optional auf bestimmte Monitore beschränkt, unterdrückt Alerts währenddessen |
| `list_status_pages` | Öffentliche Status-Pages auflisten, keyed nach Slug |

**Hinweis:** Accounts mit 2FA werden nicht unterstützt (Login schlägt mit klarer Fehlermeldung fehl,
statt hängenzubleiben).

### Authentik (16 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_users` | Authentik-Benutzer auflisten, optional nach Suchtext/Aktiv-Status gefiltert |
| `get_user` | Details eines einzelnen Benutzers per ID |
| `create_user` | Neuen Benutzer anlegen (Username, Name, E-Mail, optionale Gruppenmitgliedschaften) |
| `update_user` ⚠️ | Name/E-Mail/Aktiv-Status eines bestehenden Benutzers ändern |
| `delete_user` ⚠️ | Benutzer löschen |
| `set_user_password` ⚠️ | Passwort eines Benutzers setzen/zurücksetzen |
| `list_groups` | Gruppen auflisten, optional nach Suchtext gefiltert |
| `create_group` | Neue Gruppe anlegen, optional mit Superuser-Rechten |
| `add_user_to_group` ⚠️ | Benutzer einer Gruppe hinzufügen |
| `remove_user_from_group` ⚠️ | Benutzer aus einer Gruppe entfernen |
| `list_applications` | Applications auflisten, optional nach Suchtext gefiltert |
| `list_providers` | Alle Provider auflisten (OAuth2, SAML, Proxy, LDAP, ... - alle Typen kombiniert) |
| `list_outposts` | Outpost-Instanzen (Proxy/LDAP/RADIUS-Deployments) und deren Health auflisten |
| `list_flows` | Flows (Login, Enrollment, Recovery, ...) auflisten, optional nach Suchtext gefiltert |
| `list_events` | Audit-Log-Events auflisten, standardmäßig neueste zuerst |
| `create_invitation` | Enrollment-Einladung anlegen, optional mit vorausgefüllten Daten und Ablaufdatum |

### Coolify (27 Aktionen)

| Aktion | Beschreibung |
| --- | --- |
| `list_applications` | Alle Applications über alle Projekte/Server auflisten |
| `get_application` | Vollständige Details einer Application per UUID |
| `start_application` | Gestoppte Application starten |
| `stop_application` ⚠️ | Laufende Application stoppen |
| `restart_application` ⚠️ | Application neu starten |
| `deploy` | Deployment anstoßen (per Application/Resource-UUID oder Tag), optional erzwungener No-Cache-Rebuild |
| `get_application_logs` | Aktuelle Logs einer Application abrufen |
| `list_application_envs` | Umgebungsvariablen einer Application auflisten |
| `create_application_env` ⚠️ | Umgebungsvariable einer Application anlegen/überschreiben |
| `delete_application_env` ⚠️ | Umgebungsvariable einer Application per Key löschen |
| `list_deployments` | Aktuell laufende/wartende Deployments auflisten |
| `get_deployment` | Details/Status eines Deployments per UUID |
| `list_databases` | Alle Coolify-verwalteten Datenbanken auflisten |
| `get_database` | Vollständige Details einer Datenbank per UUID |
| `start_database` | Gestoppte Datenbank starten |
| `stop_database` ⚠️ | Laufende Datenbank stoppen |
| `restart_database` ⚠️ | Datenbank neu starten |
| `list_services` | Alle Services auflisten (One-Click-App-Stacks wie Plausible, Ghost, ...) |
| `get_service` | Vollständige Details eines Service per UUID |
| `start_service` | Gestoppten Service starten |
| `stop_service` ⚠️ | Laufenden Service stoppen |
| `restart_service` ⚠️ | Service neu starten |
| `list_servers` | Alle mit dieser Coolify-Instanz verbundenen Server auflisten |
| `get_server` | Vollständige Details eines Servers per UUID, inkl. Erreichbarkeits-/Nutzbarkeits-Status |
| `list_projects` | Alle Projekte auflisten |
| `get_project` | Vollständige Details eines Projekts per UUID, inkl. Environments/Ressourcen |
| `list_teams` | Alle Teams auflisten, auf die dieser API-Token Zugriff hat |

## Architektur

Token-effizientes **Search+Execute**-Pattern statt eines Tools pro Aktion: der Server
exponiert nur drei MCP-Tools (`list_services`, `list_actions`, `execute_action`); die
eigentlichen 151 Aktionen (siehe [Alle Aktionen im Detail](#alle-aktionen-im-detail))
liegen serverseitig in einem Katalog und werden erst bei Bedarf per Freitextsuche
gefunden.

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
    cloudflare.ts, porkbun.ts, docker.ts, proxmox.ts, npm.ts, uptimeKuma.ts, authentik.ts, coolify.ts
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
npm test           # vitest, 146 Tests über alle 8 Module
npm run build
```

## Sicherheit

- Alle Credentials kommen ausschließlich aus Umgebungsvariablen (`.env`, nie committen).
- `execute_action` markiert jede Aktion als `readOnly`/`destructive` - destruktive
  Aktionen (Löschen, Stop/Reboot, Prune, ...) sind klar gekennzeichnet.
- `insecureTls`-Felder (Proxmox, NPM, Authentik, Docker-TLS) sind Opt-in und
  standardmäßig `false` - nur für selbstsignierte LAN-Zertifikate gedacht.
