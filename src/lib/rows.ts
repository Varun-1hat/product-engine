/**
 * Small shared row-getters used across src/stages/{image,clip,trim,outro,music,assembly}
 * so each stage doesn't re-derive the same simple queries.
 */
import type { ServiceClient } from "./supabase/service";
import type { ReelConfigRow, SceneRow, Reel, ClientConfigRow } from "./db/types";

export async function getReelConfig(supa: ServiceClient, reelId: string): Promise<ReelConfigRow> {
  const { data, error } = await supa.from("reel_config").select("*").eq("reel_id", reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  return data as ReelConfigRow;
}

export async function getReel(supa: ServiceClient, reelId: string): Promise<Reel> {
  const { data, error } = await supa.from("reels").select("*").eq("id", reelId).single();
  if (error) throw new Error(`reels lookup failed: ${error.message}`);
  return data as Reel;
}

export async function getScenesForReel(supa: ServiceClient, reelId: string): Promise<SceneRow[]> {
  const { data, error } = await supa
    .from("scenes")
    .select("*")
    .eq("reel_id", reelId)
    .order("position", { ascending: true });
  if (error) throw new Error(`scenes lookup failed: ${error.message}`);
  return (data ?? []) as SceneRow[];
}

export async function getScene(supa: ServiceClient, sceneId: string): Promise<SceneRow> {
  const { data, error } = await supa.from("scenes").select("*").eq("id", sceneId).single();
  if (error) throw new Error(`scenes lookup failed: ${error.message}`);
  return data as SceneRow;
}

export async function getClientConfigRow(supa: ServiceClient, clientId: string): Promise<ClientConfigRow | null> {
  const { data, error } = await supa.from("client_config").select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw new Error(`client_config lookup failed: ${error.message}`);
  return (data as ClientConfigRow) ?? null;
}
