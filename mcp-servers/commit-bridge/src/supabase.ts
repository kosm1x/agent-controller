import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    client = createClient(url, key);
  }
  return client;
}

export function getUserId(): string {
  const id = process.env.COMMIT_USER_ID;
  if (!id) throw new Error("Missing COMMIT_USER_ID");
  return id;
}

export function unwrap<T>(
  result: { data: T | null; error: unknown },
  context: string,
): T {
  if (result.error)
    throw new Error(`${context}: ${JSON.stringify(result.error)}`);
  if (result.data === null) throw new Error(`${context}: no data returned`);
  return result.data;
}
