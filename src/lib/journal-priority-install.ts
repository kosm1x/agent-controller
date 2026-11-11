/**
 * Side-effect import: install the journal priority before any other module
 * is evaluated, so a line logged during another module's import is already
 * stored at its real priority. Import it FIRST in the entry point.
 */
import { installJournalPriority } from "./journal-priority.js";

installJournalPriority();
