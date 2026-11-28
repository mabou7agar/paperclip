import { normalizeWhatsAppUsername } from "../../whatsapp/parse.js";

/**
 * Comment presentation rows for a WhatsApp inbound message. Values come from
 * the signed, closed-parsed sidecar event kept as the message's raw payload.
 */
export function whatsAppSenderMetadata(raw: unknown) {
  if (!raw || typeof raw !== "object") return [];
  const event = raw as { quotedId?: unknown; fromPhone?: unknown; fromLid?: unknown; fromUsername?: unknown; groupSubject?: unknown; chatType?: unknown };
  const rows: Array<{ type: "key_value"; label: string; value: string }> = [];
  if (typeof event.fromPhone === "string" && /^\d{6,20}$/.test(event.fromPhone))
    rows.push({ type: "key_value", label: "WhatsApp number", value: `+${event.fromPhone}` });
  else if (typeof event.fromLid === "string" && /^\d{3,32}$/.test(event.fromLid))
    rows.push({ type: "key_value", label: "WhatsApp number", value: "Hidden by WhatsApp" });
  const username = normalizeWhatsAppUsername(event.fromUsername);
  if (username) rows.push({ type: "key_value", label: "Username", value: `@${username}` });
  if (event.chatType === "group" && typeof event.groupSubject === "string" && event.groupSubject.trim())
    rows.push({ type: "key_value", label: "WhatsApp group", value: event.groupSubject.trim().slice(0, 200) });
  if (typeof event.quotedId === "string" && event.quotedId && event.quotedId.length <= 256)
    rows.push({ type: "key_value", label: "Reply to message", value: event.quotedId });
  return rows;
}
