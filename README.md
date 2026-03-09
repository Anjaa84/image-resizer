# Image Resizer — Backend API

A production-grade Image Resizer SaaS backend built with Node.js, TypeScript, Fastify, MongoDB, Redis, and BullMQ.

---

## Tech Stack

| Layer       | Technology              |
|-------------|-------------------------|
| Runtime     | Node.js 20              |
| Language    | TypeScript 5            |
| HTTP        | Fastify 4               |
| Database    | MongoDB 7 + Mongoose 8  |
| Cache/Queue | Redis 7 + BullMQ 5      |
| Image proc. | Sharp                   |
| Validation  | Zod                     |
| Logging     | Pino                    |
| Container   | Docker + Compose        |

---

## Getting Started

### 1. Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local dev without Docker)

### 2. Environment

```bash
cp .env.example .env
# edit .env as needed
```

### 3. Run with Docker (recommended)

```bash
docker compose up --build
```

This starts:
- `api`    — Fastify HTTP server on port 3000
- `worker` — BullMQ image resize worker
- `mongo`  — MongoDB on port 27017
- `redis`  — Redis on port 6379

### 4. Run locally

```bash
npm install
npm run dev          # API server
npm run worker       # Worker (separate terminal)
```

---

## API Endpoints

| Method | Path                       | Description                    |
|--------|----------------------------|--------------------------------|
| GET    | `/health`                  | Liveness + dependency check    |
| POST   | `/api/v1/images`           | Upload image + enqueue resize  |
| GET    | `/api/v1/images`           | List images (paginated)        |
| GET    | `/api/v1/images/:id`       | Get image status + result URL  |

### POST /api/v1/images — query params

| Param   | Type   | Default | Description           |
|---------|--------|---------|-----------------------|
| width   | number | —       | Target width (px)     |
| height  | number | —       | Target height (px)    |
| format  | string | webp    | jpeg / png / webp / avif |
| quality | number | 80      | 1–100                 |

---

## Project Structure

See [architecture.md](./architecture.md) for a full breakdown.

---

## Scripts

```bash
npm run dev        # Start API in watch mode
npm run worker     # Start worker in watch mode
npm run build      # Compile TypeScript
npm run start      # Run compiled output
npm run typecheck  # Type-check without emit
```
