/**
 * Structured logger — Pino-based, JSON output, log-level filtering.
 *
 * Usage:
 *   import { logger } from '../lib/logger.js';
 *   const log = logger.child({ module: 'inference' });
 *   log.info({ provider, latencyMs }, 'inference complete');
 *   log.error({ err }, 'inference failed');
 *
 * Environment:
 *   LOG_LEVEL=debug|info|warn|error (default: info)
 *   NODE_ENV=development → pretty-printed, otherwise JSON
 */

import pino from "pino";

const VALID_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
const configuredLevel = process.env.LOG_LEVEL ?? "info";
if (!VALID_LEVELS.includes(configuredLevel)) {
  console.warn(
    `[logger] Invalid LOG_LEVEL="${configuredLevel}", defaulting to "info"`,
  );
}

// Use TTY detection for pretty-printing (works without NODE_ENV setup)
const usePretty = process.stdout.isTTY === true;

export const logger = pino({
  level: VALID_LEVELS.includes(configuredLevel) ? configuredLevel : "info",
  transport: usePretty
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss" },
      }
    : undefined,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Create a child logger for a module. */
export function createLogger(module: string) {
  return logger.child({ module });
}
