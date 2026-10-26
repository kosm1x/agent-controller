/**
 * Drive `files.list` query (`q=`) string literals: inside '...', a backslash is
 * written `\\` and a single quote `\'`. Every value interpolated into a Drive
 * query goes through this (folder/file names, parent ids). Kept dependency-free
 * so tools, scripts and drive-sync share it without pulling in the db layer.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
