# To-Do List — Full Docker Web Stack (DevOps Task)

A complete containerized web system built with Docker Compose:
**Frontend + Backend + Database + Reverse Proxy + Monitoring**, with network isolation, healthchecks, resource limits, restart policies, log rotation, and full observability (cAdvisor + Prometheus + Grafana).

---

## 1. Architecture Overview

```
                        ┌──────────────────────────┐
   Browser  ── :8081 ──▶│         Proxy (Nginx)     │
                        │  /      → frontend:80     │
                        │  /api   → backend:3000    │
                        └───────────┬───────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                │                                        │
     ┌──────────▼─────────┐                  ┌───────────▼──────────┐
     │  Frontend (Nginx)   │                  │   Backend (Node.js)  │
     │  Static HTML/JS     │                  │   Express API        │
     └──────────────────────┘                 └───────────┬──────────┘
                                                             │
                                                  ┌──────────▼──────────┐
                                                  │   Database (MySQL)  │
                                                  │   Persistent Volume │
                                                  └──────────────────────┘

     Monitoring (separate concern, watches everything):
     cAdvisor → Prometheus → Grafana (dashboards on :3001)
```

### Networks (isolation)
| Network | Members | Purpose |
|---|---|---|
| `frontend-net` | frontend, proxy, cadvisor | Public-facing side only |
| `backend-net` | backend, database, proxy, cadvisor | Internal data side only |
| `monitoring-net` | cadvisor, prometheus, grafana | Observability stack |

The **Proxy** is the only container with a published port (`8081:80`) — it is the single entry point to the whole system. Frontend, Backend, and Database are never exposed directly to the host.

---

## 2. Services Summary

| Service | Image / Build | Role |
|---|---|---|
| `database` | `mysql:8.0` | Stores tasks in a persistent volume (`db-data`) |
| `backend` | custom (Node.js + Express) | REST API: `GET/POST/PUT/DELETE /api/tasks`, `/api/health`, `/metrics` |
| `frontend` | custom (Nginx + static HTML/JS) | Serves the To-Do List UI |
| `proxy` | custom (Nginx) | Routes `/` → frontend, `/api` → backend |
| `cadvisor` | `gcr.io/cadvisor/cadvisor` | Collects live resource metrics per container |
| `prometheus` | `prom/prometheus` | Scrapes & stores metrics over time (from cAdvisor + backend) |
| `grafana` | `grafana/grafana` | Visualizes metrics in dashboards (port `3001`) |

---

## 3. Design Decisions & Justifications

### 3.1 Why the Proxy (not the Backend) is the single entry point
Keeping only one container publicly exposed reduces attack surface, gives a single place to add TLS/rate-limiting/caching later, and keeps a clean separation of concerns: the backend's job is business logic + DB access, not traffic routing.

### 3.2 Healthchecks
Each service has a healthcheck so Docker knows the difference between "container started" and "service actually ready":

| Service | Check | Why |
|---|---|---|
| database | `mysqladmin ping` | Confirms MySQL accepts connections, not just that the process exists |
| backend | `GET /api/health` | Confirms the Express server responds |
| frontend | `GET /` (port 80) | Confirms Nginx serves content |
| proxy | `GET /` (port 80) | Confirms Nginx is routing |

`depends_on` uses `condition: service_healthy` (not the default), so:
- `backend` waits for `database` to be truly healthy before connecting.
- `proxy` waits for both `frontend` and `backend` to be healthy before starting.

This solved a real, reproduced bug: on a fresh start, the backend tried to connect to MySQL before it had finished initializing, causing `ECONNREFUSED`. After adding healthchecks + `condition: service_healthy`, a full `docker compose down && up` starts every service healthy with no manual restarts needed.

*(Note: healthcheck commands use `127.0.0.1` instead of `localhost` inside the Nginx-based containers — `localhost` resolution inside those containers caused `wget: can't connect to remote host`, while `127.0.0.1` worked reliably.)*

### 3.3 Resource Limits

| Service | CPU | RAM | Reasoning |
|---|---|---|---|
| database | 1.0 | 512M | Runs actual disk I/O + keeps an InnoDB buffer pool in memory — heaviest service |
| backend | 0.5 | 256M | Single-threaded API layer, moderate load |
| frontend | 0.25 | 128M | Serves static files only |
| proxy | 0.25 | 128M | Routes traffic only, no processing logic |

Verified with `docker stats --no-stream`: real usage stayed comfortably under each limit (e.g. database used ~370MB of its 512MB cap).

### 3.4 Restart Policies

| Service | Policy | Reasoning |
|---|---|---|
| database | `unless-stopped` | Critical, should self-heal from crashes, but respects a deliberate manual stop (e.g. for maintenance) |
| backend | `unless-stopped` | Same reasoning — core service, but manual stops are respected |
| frontend | `unless-stopped` | Same reasoning |
| proxy | `always` | The single public entry point — must come back under all circumstances, even after a host reboot or an unintended stop, since without it nothing is reachable |

#### Crash test performed
1. `docker kill backend` → container stayed **Exited**, did **not** restart.
   - Reason: Docker treats an externally-issued `kill`/`stop` as an intentional user action, and `unless-stopped` honors that.
2. `docker exec -it backend kill 1` (killing the Node.js process *from inside* the container) → container automatically restarted within seconds, reaching `healthy` state again.
   - Reason: this simulates a real application crash (not a user-issued stop), which `unless-stopped` *does* recover from automatically.

This distinction was an important, hands-on discovery about how Docker restart policies actually behave.

### 3.5 Log Drivers

All services use the `json-file` driver with rotation limits, to prevent unbounded log growth from filling disk space:

| Service | max-size | max-file | Reasoning |
|---|---|---|---|
| database | 10m | 3 | Important logs, but normally not high-volume |
| backend | 10m | 5 | Most important service to monitor (API errors); kept longer history |
| frontend | 5m | 2 | Minimal logging, mostly static file serving |
| proxy | 10m | 3 | Logs every request passing through the system |

Verified with:
```bash
docker inspect backend --format='{{json .HostConfig.LogConfig}}'
# {"Type":"json-file","Config":{"max-file":"5","max-size":"10m"}}
```

### 3.6 Monitoring Stack
- **cAdvisor** mounts read-only host paths (`/rootfs`, `/sys`, `/var/lib/docker`, etc.) to observe every container's live CPU/RAM/network usage.
- **Prometheus** scrapes two targets every 15s: `cadvisor:8080` (all container metrics) and `backend:3000/metrics` (custom app metrics via `prom-client`, including `http_requests_total` — request count and status codes).
- **Grafana** (imported community dashboard) visualizes CPU usage, memory usage/cache, network I/O, and container info for all 7 containers live.

---

## 4. How to Run

```bash
docker compose up -d --build
docker compose ps      # confirm all services are "healthy"
```

- App (via Proxy): `http://<host-ip>:8081`
- Prometheus: `http://<host-ip>:9090`
- Grafana: `http://<host-ip>:3001` (default login: admin/admin)
- cAdvisor (direct): `http://<host-ip>:8082`

## 5. Project Structure

```
project/
├── docker-compose.yml
├── frontend/
│   ├── index.html
│   └── Dockerfile
├── backend/
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
├── db/
│   └── init.sql
├── proxy/
│   ├── nginx.conf
│   └── Dockerfile
└── monitoring/
    └── prometheus/
        └── prometheus.yml
```
