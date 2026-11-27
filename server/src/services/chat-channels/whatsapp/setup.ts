import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatEndpoints, toolConnections } from "@paperclipai/db";
import type { ChatEndpointStatus } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import type { WhatsAppSidecarClient, WhatsAppLinkStatus } from "../../whatsapp/sidecar-client.js";
import { notifyChatConnectionHealth } from "../connection-health-notifications.js";
import { notifyChatEndpointConfiguration } from "../configuration-work-notifications.js";
import type { EndpointRecord } from "../runtime-types.js";
import { whatsAppHttpError } from "./credentials.js";
import { CAPABILITIES } from "../provider-catalog.js";

export type WhatsAppLinkMode = "qr" | "code";

/** What the setup screen sees. Never carries the sidecar URL or secret. */
export interface WhatsAppLinkView {
  state: WhatsAppLinkStatus["state"];
  qrPngDataUrl?: string;
  qrIssuedAt?: string;
  code?: string;
  linkedAs?: string;
  lastError?: string;
  endpointStatus: ChatEndpointStatus;
}

type WhatsAppSetupOptions = {
  client: WhatsAppSidecarClient;
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
};

const CONFIGURABLE: ReadonlySet<ChatEndpointStatus> = new Set(["draft", "attention", "revoked"]);
const LIVE: ChatEndpointStatus[] = ["verifying", "active", "paused"];

export function normalizeWhatsAppLinkInput(input: { mode?: unknown; phone?: unknown }): { mode: WhatsAppLinkMode; phone?: string } {
  if (input.mode !== "qr" && input.mode !== "code") throw unprocessable("Choose QR code or pairing code");
  if (input.mode === "qr") return { mode: "qr" };
  const phone = typeof input.phone === "string" ? input.phone.replace(/\D+/g, "") : "";
  if (phone.length < 7 || phone.length > 15)
    throw unprocessable("Enter the WhatsApp number with its country code, for example +49 151 2345678");
  return { mode: "code", phone };
}

function view(status: WhatsAppLinkStatus, endpointStatus: ChatEndpointStatus): WhatsAppLinkView {
  return {
    state: status.state,
    ...(status.qrPngDataUrl ? { qrPngDataUrl: status.qrPngDataUrl } : {}),
    ...(status.qrIssuedAt ? { qrIssuedAt: status.qrIssuedAt } : {}),
    ...(status.code ? { code: status.code } : {}),
    ...(status.me ? { linkedAs: `+${status.me}` } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    endpointStatus,
  };
}

export function createWhatsAppSetup(db: Db, options: WhatsAppSetupOptions) {
  const { client, endpointRecord, invalidateRuntime } = options;

  async function whatsAppEndpoint(endpointId: string) {
    const record = await endpointRecord(endpointId);
    if (!record || record.endpoint.provider !== "whatsapp") throw notFound("WhatsApp channel not found");
    if (record.endpoint.status === "archived") throw conflict("This WhatsApp channel was removed", { code: "chat_endpoint_archived" });
    return record.endpoint;
  }

  /** Mark a live endpoint as needing a new link; idempotent. */
  async function markUnlinked(endpointId: string, message: string) {
    const changed = await db.transaction(async (tx) => {
      const [endpoint] = await tx
        .select()
        .from(chatEndpoints)
        .where(and(eq(chatEndpoints.id, endpointId), inArray(chatEndpoints.status, LIVE)))
        .for("update");
      if (!endpoint) return false;
      await notifyChatEndpointConfiguration(tx, endpoint);
      await tx
        .update(chatEndpoints)
        .set({ status: "attention", healthMessage: message, lastError: message, updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpointId));
      await notifyChatConnectionHealth(tx, endpoint);
      await tx
        .update(toolConnections)
        .set({ healthStatus: "degraded", healthMessage: message, lastError: message, healthCheckedAt: new Date(), updatedAt: new Date() })
        .where(eq(toolConnections.id, endpoint.connectionId));
      return true;
    });
    if (changed) await invalidateRuntime(endpointId).catch(() => undefined);
    return changed;
  }

  async function startLink(endpointId: string, input: { mode?: unknown; phone?: unknown }): Promise<WhatsAppLinkView> {
    const endpoint = await whatsAppEndpoint(endpointId);
    const normalized = normalizeWhatsAppLinkInput(input);
    const status = await client.link(endpoint.publicId, normalized).catch(whatsAppHttpError);
    return view(status, endpoint.status);
  }

  /**
   * Poll the sidecar. The first poll that sees a linked number runs the normal
   * setup path, which verifies that number again and claims it for this
   * endpoint; a logout seen on a live endpoint moves it to attention.
   */
  async function linkStatus(
    endpointId: string,
    /** The provider-neutral setup path, run as the polling user; it verifies the number again. */
    configureLinked: (endpointId: string, accountId: string) => Promise<unknown>,
  ): Promise<WhatsAppLinkView> {
    let endpoint = await whatsAppEndpoint(endpointId);
    const status = await client.status(endpoint.publicId).catch(whatsAppHttpError);
    if (status.state === "linked" && CONFIGURABLE.has(endpoint.status)) {
      await refreshCapabilities(endpointId);
      await configureLinked(endpointId, endpoint.publicId);
      endpoint = await whatsAppEndpoint(endpointId);
    } else if (status.state === "logged_out" && LIVE.includes(endpoint.status) && endpoint.botExternalId) {
      await markUnlinked(endpointId, "WhatsApp was logged out on the phone; link it again");
      await forgetNumber(endpointId);
      endpoint = await whatsAppEndpoint(endpointId);
    }
    return view(status, endpoint.status);
  }

  /**
   * Forget the number this channel was linked to, so the same channel can be
   * linked to a different number afterwards. Setup otherwise refuses a new
   * identity once one was claimed; for WhatsApp the operator unlinked (or the
   * phone logged out), so the old number no longer belongs to this channel.
   * Clearing bot_external_id also frees the number's unique index.
   */
  async function forgetNumber(endpointId: string) {
    await db.transaction(async (tx) => {
      const [endpoint] = await tx
        .select()
        .from(chatEndpoints)
        .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "whatsapp"), ne(chatEndpoints.status, "archived")))
        .for("update");
      if (!endpoint || endpoint.botExternalId === null) return;
      await notifyChatEndpointConfiguration(tx, endpoint);
      await tx
        .update(chatEndpoints)
        .set({
          ...(LIVE.includes(endpoint.status) ? { status: "attention" as const } : {}),
          providerAccountId: null,
          providerAccountLabel: null,
          botExternalId: null,
          botUsername: null,
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, endpointId));
    });
    await invalidateRuntime(endpointId).catch(() => undefined);
  }

  async function unlink(endpointId: string): Promise<WhatsAppLinkView> {
    const endpoint = await whatsAppEndpoint(endpointId);
    await client.unlink(endpoint.publicId).catch(whatsAppHttpError);
    await markUnlinked(endpointId, "WhatsApp was unlinked; link it again to receive messages");
    await forgetNumber(endpointId);
    const current = await whatsAppEndpoint(endpointId);
    return { state: "logged_out", endpointStatus: current.status };
  }

  /** Refresh the stored adapter capabilities (phase 3 added reactions). */
  async function refreshCapabilities(endpointId: string) {
    await db
      .update(chatEndpoints)
      .set({ capabilities: CAPABILITIES.whatsapp, updatedAt: new Date() })
      .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "whatsapp")));
  }

  return { startLink, linkStatus, unlink, markUnlinked, forgetNumber, refreshCapabilities };
}
