/**
 * Central page-route builders (spec §1.3). Every page/link this redesign touches imports
 * from here instead of hand-writing template-string paths, so route shapes stay in one place.
 */
import type { StageId } from "@/src/lib/db/enums";

export const routes = {
  clients: () => "/clients",
  client: (clientId: string) => `/clients/${clientId}`,
  clientConfig: (clientId: string) => `/clients/${clientId}/config`,
  newReel: (clientId: string) => `/clients/${clientId}/reels/new`,
  reelStage: (reelId: string, stage: StageId) => `/reels/${reelId}/${stage}`,
  login: (next?: string) => (next ? `/login?next=${encodeURIComponent(next)}` : "/login"),
};
