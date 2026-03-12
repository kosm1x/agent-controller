/**
 * Event bus glue module.
 *
 * Provides lazy access to the PersistentEventBus singleton.
 * The bus is initialized in index.ts after the database is ready.
 * Adapter code imports getEventBus() to access it.
 */

import { PersistentEventBus } from "./events/bus.js";
import type Database from "better-sqlite3";

let _bus: PersistentEventBus | null = null;

/** Initialize the event bus with a database instance. Call once at startup. */
export function initEventBus(db: Database.Database): PersistentEventBus {
  if (_bus) return _bus;
  _bus = new PersistentEventBus({ db });
  return _bus;
}

/** Get the event bus singleton. */
export function getEventBus(): PersistentEventBus {
  if (!_bus)
    throw new Error("Event bus not initialized. Call initEventBus() first.");
  return _bus;
}

/**
 * Adapter-compatible facade.
 *
 * The adapter base class calls eventBus.broadcast() and eventBus.emit().
 * This proxy lazily delegates to the real PersistentEventBus.
 */
export const eventBus = {
  broadcast(event: string, data: unknown): void {
    getEventBus().emit(event, data);
  },
  emit(event: string, ...args: unknown[]): boolean {
    return getEventBus().emit(event, ...args);
  },
  on(event: string, handler: (...args: unknown[]) => void): void {
    getEventBus().on(event, handler);
  },
};
