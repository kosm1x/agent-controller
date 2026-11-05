/**
 * Drive listing + KB-relative parent-path resolution shared by
 * scripts/list-drive-index-copies.ts (read-only lister) and
 * scripts/trash-drive-index-copies.ts. GET calls only; the fetch is injected so
 * the trash script's tests never reach Google.
 */

import { escapeDriveQueryValue } from "../../src/google/drive-query.js";

export const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
export const OUTSIDE = "OUTSIDE KB FOLDER";
/** Guard against a parent cycle or a very deep tree. */
const MAX_DEPTH = 50;

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
}

interface FolderNode {
  id: string;
  name: string;
  parents?: string[];
}

/** The googleFetch shape both scripts use (GET by default; PATCH with a JSON body). */
export type DriveFetch = <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;

export function driveLookup(fetchFn: DriveFetch, rootFolderId: string) {
  /** null = 404 (not visible to this account): the chain is outside the KB. */
  const folderCache = new Map<string, FolderNode | null>();

  /**
   * Look up one folder. A 404 resolves to null and is cached; any other error
   * (auth, quota, timeout) is returned as `{ error }` and NOT cached, so the
   * operator sees UNKNOWN instead of a misleading OUTSIDE.
   */
  async function getFolder(id: string): Promise<FolderNode | null | { error: string }> {
    if (folderCache.has(id)) return folderCache.get(id) ?? null;
    try {
      const node = await fetchFn<FolderNode>(`${DRIVE_FILES}/${id}?fields=id,name,parents`);
      folderCache.set(id, node);
      return node;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /Google API (\d{3})/.exec(msg)?.[1];
      if (status === "404") {
        folderCache.set(id, null);
        return null;
      }
      return { error: status ?? msg.slice(0, 80) };
    }
  }

  /**
   * Folder path relative to the KB root; OUTSIDE when the chain never reaches
   * it; UNKNOWN (<status or message>) when a lookup failed for another reason.
   */
  async function kbLocation(parents: string[] | undefined): Promise<string> {
    let id = parents?.[0];
    const names: string[] = [];
    for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
      if (id === rootFolderId) return names.length ? names.reverse().join("/") : ".";
      const node = await getFolder(id);
      if (!node) break;
      if ("error" in node) return `UNKNOWN (${node.error})`;
      names.push(node.name);
      id = node.parents?.[0];
    }
    return OUTSIDE;
  }

  /** Every non-trashed file named `name`; `incomplete` = Drive flagged any page `incompleteSearch`. */
  async function listByName(name: string): Promise<{ files: DriveFile[]; incomplete: boolean }> {
    const q = encodeURIComponent(`name = '${escapeDriveQueryValue(name)}' and trashed = false`);
    const fields = "nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,size,parents,trashed)";
    const out: DriveFile[] = [];
    let incomplete = false;
    let pageToken: string | undefined;
    do {
      const url =
        `${DRIVE_FILES}?q=${q}&fields=${encodeURIComponent(fields)}&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const page = await fetchFn<{ files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean }>(url);
      out.push(...(page.files ?? []));
      if (page.incompleteSearch) incomplete = true;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { files: out, incomplete };
  }

  return { kbLocation, listByName };
}
