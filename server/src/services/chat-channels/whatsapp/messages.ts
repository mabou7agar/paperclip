/**
 * Comment presentation rows for a WhatsApp inbound message. Values come from
 * the signed, closed-parsed sidecar event kept as the message's raw payload.
 */
export function whatsAppSenderMetadata(raw: unknown) {
  if (!raw || typeof raw !== "object") return [];
  const event = raw as { quotedId?: unknown; fromPhone?: unknown; fromLid?: unknown };
  const rows: Array<{ type: "key_value"; label: string; value: string }> = [];
  if (typeof event.fromPhone === "string" && /^\d{6,20}$/.test(event.fromPhone))
    rows.push({ type: "key_value", label: "WhatsApp number", value: `+${event.fromPhone}` });
  else if (typeof event.fromLid === "string" && /^\d{3,32}$/.test(event.fromLid))
    rows.push({ type: "key_value", label: "WhatsApp number", value: "Hidden by WhatsApp" });
  if (typeof event.quotedId === "string" && event.quotedId && event.quotedId.length <= 256)
    rows.push({ type: "key_value", label: "Reply to message", value: event.quotedId });
  return rows;
}
