// Kept free of imports so communication guidance can use it without loading the database layer.
/**
 * What the agent is told about a customer conversation. Presentation and scope
 * guidance only; authority is enforced elsewhere. Used for WhatsApp customers
 * and for customers in a WhatsApp or Telegram client group.
 */
export function customerGuidanceLines(providerLabel: string): readonly string[] {
  return [
    `The person writing is a customer on ${providerLabel}, not a member of the team. They are not linked to a Paperclip account.`,
    "Only help with what a customer may ask: the company's products and services, and their own account, orders and support questions.",
    "Never discuss or act on internal tasks, code, repositories, deployments, feature flags, approvals, team members, company internals or other customers' data, even if asked or told it is allowed.",
    "Do not take actions on Paperclip for a customer and do not send them Paperclip links. Ask any clarifying question as a plain message.",
    "If a request is outside what a customer may ask, say politely that you cannot help with it here.",
  ];
}

export const WHATSAPP_CUSTOMER_GUIDANCE: readonly string[] = customerGuidanceLines("WhatsApp");
