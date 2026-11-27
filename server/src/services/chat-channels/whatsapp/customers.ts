import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { chatDeliveries } from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  WhatsAppCustomerRateLimit,
  WhatsAppUnknownSenderPolicy,
} from "@paperclipai/shared";
import type { DbOrTransaction } from "../runtime-types.js";
export { WHATSAPP_CUSTOMER_GUIDANCE } from "./customer-guidance.js";

/**
 * WhatsApp unknown-sender policy. People who are not linked to a Paperclip
 * user are either ignored (the default) or answered as customers. "client" is
 * the existing sponsored-guest path (allowUnlinkedPeople) with three WhatsApp
 * additions: a customer sender row and guidance so the agent knows who it is
 * talking to, a per-sender message limit, and no owner cards in customer
 * conversations. Guests already run under low-trust task containment and can
 * never resolve governed actions, so a customer cannot approve, merge, deploy
 * or change anything on Paperclip.
 */
export const DEFAULT_WHATSAPP_CUSTOMER_RATE_LIMIT: WhatsAppCustomerRateLimit = { messages: 10, windowMinutes: 10 };

export const WHATSAPP_CUSTOMER_AUTHORITY = "WhatsApp customer (restricted)";

export function whatsAppUnknownSenderPolicy(endpoint: { provider: string; allowUnlinkedPeople: boolean }): WhatsAppUnknownSenderPolicy {
  return endpoint.provider === "whatsapp" && endpoint.allowUnlinkedPeople ? "client" : "ignore";
}

/** The configured limit, or the default when unset or out of range. */
export function whatsAppCustomerRateLimit(setup: ChatEndpointSetupState | null | undefined): WhatsAppCustomerRateLimit {
  const value = setup?.whatsAppCustomerRateLimit;
  if (
    value &&
    Number.isInteger(value.messages) && value.messages >= 1 && value.messages <= 200 &&
    Number.isInteger(value.windowMinutes) && value.windowMinutes >= 1 && value.windowMinutes <= 1440
  )
    return { messages: value.messages, windowMinutes: value.windowMinutes };
  return DEFAULT_WHATSAPP_CUSTOMER_RATE_LIMIT;
}

/** Pure decision: the current message is over the limit when the window already holds `messages` admitted ones. */
export function customerRateLimitReached(admittedInWindow: number, limit: WhatsAppCustomerRateLimit): boolean {
  return admittedInWindow >= limit.messages;
}

/**
 * Count the sender's earlier admitted messages inside the window. Filtered
 * deliveries carry no principal, so messages refused by this limit do not
 * extend it: a sender is answered again once the window has room.
 */
export async function whatsAppCustomerMessagesInWindow(
  db: DbOrTransaction,
  input: { endpointId: string; principalId: string; currentDeliveryId: string; limit: WhatsAppCustomerRateLimit; now?: Date },
): Promise<number> {
  const since = new Date((input.now ?? new Date()).getTime() - input.limit.windowMinutes * 60_000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatDeliveries)
    .where(
      and(
        eq(chatDeliveries.endpointId, input.endpointId),
        eq(chatDeliveries.principalId, input.principalId),
        inArray(chatDeliveries.eventKind, ["direct_message", "message", "mention"]),
        ne(chatDeliveries.id, input.currentDeliveryId),
        ne(chatDeliveries.state, "filtered"),
        gte(chatDeliveries.receivedAt, since),
      ),
    );
  return Number(row?.count ?? 0);
}

/** Rows added to the inbound comment's sender section for a customer. */
export function whatsAppCustomerSenderRows(): Array<{ type: "key_value"; label: string; value: string }> {
  return [
    { type: "key_value", label: "Sender role", value: "Customer" },
    { type: "key_value", label: "Customer scope", value: "Products, services and their own account, orders and support only" },
  ];
}
