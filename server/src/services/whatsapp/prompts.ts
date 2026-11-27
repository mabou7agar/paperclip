import type { SafeChatPublicationPayload } from "@paperclipai/shared";

/**
 * Owner cards on WhatsApp. Baileys has no reliable buttons, so a card's
 * callback actions are sent as a numbered text prompt ("Reply 1 to approve,
 * 2 to reject"). The owner's reply (a number, the option's words, or a quote
 * of the prompt with either) is mapped back to the same opaque action id a
 * Telegram button would carry, and resolved through Paperclip's normal action
 * ledger, which requires a linked, active, non-viewer member. Like Photon
 * (cards: false, actions: true), the text is the card.
 */
export interface WhatsAppPromptChoice {
  actionId: string;
  label: string;
  decision?: "accept" | "reject";
}

export interface WhatsAppPromptRecord {
  version: 1;
  interactionId: string;
  /** The publication's provider message id; actions are bound to it. */
  messageId: string;
  /** Conversation thread the prompt was published in. */
  threadId: string;
  kind: "question" | "confirmation";
  choices: WhatsAppPromptChoice[];
  expiresAt: number;
}

export const WHATSAPP_PROMPT_TTL_MS = 7 * 24 * 3600 * 1000;

const ACCEPT_WORDS = new Set(["yes", "y", "ok", "okay", "approve", "approved", "accept", "accepted", "confirm", "go"]);
const REJECT_WORDS = new Set(["no", "n", "reject", "rejected", "decline", "declined", "deny", "denied", "cancel"]);

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[*_~`"'“”‘’.!?,;:()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text and choices for a card publication, or null when the card has no
 * callback actions (link-only cards are published as their plain text).
 */
export function whatsAppCardPrompt(payload: SafeChatPublicationPayload): {
  text: string;
  interactionId: string;
  kind: "question" | "confirmation";
  choices: WhatsAppPromptChoice[];
} | null {
  const card = payload.card;
  if (!card || !payload.interactionId || card.kind === "status") return null;
  const callbacks = (card.actions ?? []).filter(
    (action): action is Extract<NonNullable<typeof card.actions>[number], { type: "callback" }> => action.type === "callback",
  );
  if (!callbacks.length || callbacks.length > 20) return null;
  const confirmation = card.kind === "confirmation" && callbacks.length === 2;
  const choices: WhatsAppPromptChoice[] = callbacks.map((action, index) => ({
    actionId: action.actionId,
    label: action.label.trim() || `Option ${index + 1}`,
    ...(confirmation
      ? { decision: action.style === "danger" ? "reject" as const : action.style === "primary" ? "accept" as const : index === 0 ? "accept" as const : "reject" as const }
      : {}),
  }));
  const links = (card.actions ?? []).filter((action) => action.type === "link");
  const instruction = confirmation
    ? `Reply 1 to ${choices[0].label.toLowerCase()}, 2 to ${choices[1].label.toLowerCase()}.`
    : `Reply with the number of your answer (1–${choices.length}), or its words.`;
  const text = [
    `*${card.title.trim() || "Input needed"}*`,
    card.body?.trim() || "",
    choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n"),
    instruction,
    ...links.map((link) => (link.type === "link" ? `${link.label}: ${link.url}` : "")),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text, interactionId: payload.interactionId, kind: confirmation ? "confirmation" : "question", choices };
}

/**
 * The choice a reply selects, or null when the reply is ordinary text. Only a
 * whole reply counts: "1", "2.", "approve", the exact option words. A sentence
 * that merely contains a number stays a normal message.
 */
export function matchWhatsAppPromptReply(prompt: Pick<WhatsAppPromptRecord, "choices" | "kind">, text: string): WhatsAppPromptChoice | null {
  const value = normalized(text);
  if (!value || value.length > 120) return null;
  const number = /^#?(\d{1,2})$/.exec(value);
  if (number) {
    const index = Number(number[1]) - 1;
    return prompt.choices[index] ?? null;
  }
  const byLabel = prompt.choices.filter((choice) => normalized(choice.label) === value);
  if (byLabel.length === 1) return byLabel[0];
  if (prompt.kind === "confirmation") {
    const decision = ACCEPT_WORDS.has(value) ? "accept" : REJECT_WORDS.has(value) ? "reject" : null;
    if (decision) return prompt.choices.find((choice) => choice.decision === decision) ?? null;
  }
  return null;
}

/** Keys a prompt is filed under for its recipient: phone digits and/or "lid:<id>". */
export function whatsAppPromptRecipientKeys(input: { fromPhone?: string | null; fromLid?: string | null }): string[] {
  return [
    ...(input.fromPhone ? [`recipient:${input.fromPhone}`] : []),
    ...(input.fromLid ? [`recipient:lid:${input.fromLid}`] : []),
  ];
}

export function whatsAppPromptMessageKey(messageId: string): string {
  return `prompt-message:${messageId}`;
}
