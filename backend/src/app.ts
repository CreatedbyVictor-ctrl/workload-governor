/**
 * app.ts — WorkloadGovernor backend service entry point
 *
 * Mounts:
 *   GET /api/health  — health check (#309)
 *   GET /readyz      — readiness probe; returns 503 during shutdown
 *
 * Starts:
 *   - Scheduler for TTL extension + GitHub sync (#311, #312)
 *
 * Tracing:
 *   - AWS X-Ray segment opened per request via xrayMiddleware (#634)
 *
 * Graceful shutdown:
 *   - Readiness gate turns false before shutdown begins (SIGTERM/SIGINT)
 *   - In-flight requests are allowed to complete within DRAIN_TIMEOUT_MS
 *   - Forced termination (drain timeout exceeded) is logged with a reason
 */

import http from "http";
import express from "express";
import { healthHandler } from "./health.js";
import { startScheduler } from "./scheduler.js";
import { xrayMiddleware } from "./tracing.js";
import logger from "./logger.js";

// ─── Readiness gate ───────────────────────────────────────────────────────────

/**
 * Set to true once SIGTERM/SIGINT is received.
 * `/readyz` immediately returns 503 and Kubernetes stops routing new traffic here.
 */
let isShuttingDown = false;

/** Used by /readyz and exported for testing. */
export function isReady(): boolean {
  return !isShuttingDown;
}

// ─── Active connection tracking ───────────────────────────────────────────────

/**
 * Count of in-flight HTTP requests currently being processed.
 * Incremented when a request arrives, decremented on `finish`.
 * The drain loop waits for this to reach zero (or for the timeout to fire).
 */
let activeRequests = 0;

/** Configurable drain window — default 30 s, overridable via DRAIN_TIMEOUT_MS. */
const DRAIN_TIMEOUT_MS = parseInt(process.env["DRAIN_TIMEOUT_MS"] ?? "30000", 10);

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

// X-Ray segment middleware — must be first so all downstream handlers inherit
// the active segment context. No-op when XRAY_ENABLED=false.
app.use(xrayMiddleware());

app.use(express.json());

// Request logger middleware
app.use((req, _res, next) => {
  logger.debug({ method: req.method, path: req.path }, "Incoming request");
  next();
});

// ── In-flight request counter ─────────────────────────────────────────────────
// Track every request so the drain loop knows when it is safe to exit.
app.use((_req, res, next) => {
  activeRequests++;
  res.on("finish", () => {
    activeRequests--;
  });
  next();
});

// ── Readiness probe ───────────────────────────────────────────────────────────

/**
 * GET /readyz
 *
 * Returns 200 {"ready": true} while the process is healthy.
 * Returns 503 {"ready": false, "reason": "shutting_down"} once a shutdown
 * signal has been received.  Kubernetes removes this pod from the load balancer
 * after it sees the 503, so no new traffic arrives during the drain window.
 */
app.get("/readyz", (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ ready: false, reason: "shutting_down" });
  }
  return res.status(200).json({ ready: true });
});

// Health check
app.get("/api/health", healthHandler);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── HTTP server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

const server = http.createServer(app);

// ─── Graceful shutdown ───────────────────────────────────────────────────────

/**
 * Shut down the process in response to a termination signal.
 *
 * Steps:
 *  1. Flip the readiness gate so /readyz returns 503 immediately.
 *  2. Stop the cron scheduler (no new jobs start).
 *  3. Stop accepting new HTTP connections.
 *  4. Wait up to DRAIN_TIMEOUT_MS for in-flight requests to complete.
 *  5. If the drain window expires, log a structured warning with the reason
 *     before exiting — satisfying the "forced termination is logged with a
 *     reason" acceptance criterion.
 *  6. Exit 0 on clean shutdown, 1 if forced.
 */
export async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;

  // ── 1. Drop readiness immediately ─────────────────────────────────────────
  isShuttingDown = true;
  logger.info({ signal, activeRequests }, "Shutdown signal received – readiness gate closed");

  // ── 2. Stop cron scheduler ────────────────────────────────────────────────
  scheduler.stop();

  // ── 3. Stop accepting new connections ─────────────────────────────────────
  server.close(() => {
    logger.info("HTTP server closed – no new connections accepted");
  });

  // ── 4. Drain in-flight requests ───────────────────────────────────────────
  let forcedExit = false;

  await new Promise<void>((resolve) => {
    if (activeRequests <= 0) {
      resolve();
      return;
    }

    logger.info(
      { activeRequests, drainTimeoutMs: DRAIN_TIMEOUT_MS },
      "Draining in-flight requests",
    );

    const timer = setTimeout(() => {
      // ── 5. Forced-exit path: log with reason ──────────────────────────────
      forcedExit = true;
      logger.warn(
        {
          reason:        "drain_timeout_exceeded",
          drainTimeoutMs: DRAIN_TIMEOUT_MS,
          activeRequests,
          signal,
        },
        "Forced shutdown: drain timeout exceeded before all in-flight requests completed",
      );
      resolve();
    }, DRAIN_TIMEOUT_MS);

    const poll = setInterval(() => {
      if (activeRequests <= 0) {
        clearInterval(poll);
        clearTimeout(timer);
        logger.info("All in-flight requests completed");
        resolve();
      }
    }, 50);
  });

  // ── 6. Exit ───────────────────────────────────────────────────────────────
  logger.info({ forced: forcedExit }, "Graceful shutdown complete");
  process.exit(forcedExit ? 1 : 0);
}

// ─── Start ───────────────────────────────────────────────────────────────────

// Start scheduled jobs (must be declared before shutdown() references it)
const scheduler = startScheduler();

server.listen(PORT, () => {
  logger.info({ port: PORT }, "WorkloadGovernor backend listening");
});

// Wire termination signals
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

export default app;
