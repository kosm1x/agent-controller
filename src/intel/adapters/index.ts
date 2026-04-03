/**
 * Adapter registry — all collector adapters for the Intelligence Depot.
 */

import type { CollectorAdapter } from "../types.js";
import { usgsAdapter } from "./usgs.js";
import { nwsAdapter } from "./nws.js";
import { gdeltAdapter } from "./gdelt.js";
import { frankfurterAdapter } from "./frankfurter.js";
import { cisaKevAdapter } from "./cisa-kev.js";

/** All registered collector adapters. */
export function getAllAdapters(): CollectorAdapter[] {
  return [
    usgsAdapter,
    nwsAdapter,
    gdeltAdapter,
    frankfurterAdapter,
    cisaKevAdapter,
  ];
}
