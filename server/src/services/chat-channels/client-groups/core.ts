// Kept free of database imports: the WhatsApp adapter and communication
// guidance use these pure helpers.
import { chatClientGroupClientSchema, type ChatClientGroupClient, type ChatProvider } from "@paperclipai/shared";

/**
 * Client groups: staff create a WhatsApp or Telegram group with a client (an
 * academy), introduce the client once (a /client command in the group, or in
 * Paperclip), and every message in that group from people who are not on the
 * team is handled as that client's customer request. The client is stored on
 * the group's chat_endpoint_resources row (metadata.clientGroup); no migration.
 */
export const CLIENT_GROUP_PROVIDERS: ReadonlySet<ChatProvider> = new Set<ChatProvider>(["whatsapp", "telegram"]);

/** Resource types that are groups for each client-group provider (Telegram topics share their group's row). */
export const CLIENT_GROUP_RESOURCE_TYPES: Readonly<Partial<Record<ChatProvider, string>>> = {
  whatsapp: "group_chat",
  telegram: "chat",
};

export function isClientGroupProvider(provider: ChatProvider): boolean {
  return CLIENT_GROUP_PROVIDERS.has(provider);
}

/** The channel's switch "answer clients in client groups" (default on). */
export function answersClientGroups(endpoint: { provider: ChatProvider; setup?: { answerClientGroups?: boolean } | null }): boolean {
  return isClientGroupProvider(endpoint.provider) && endpoint.setup?.answerClientGroups !== false;
}

/** The client stored on a group resource, or null when absent or malformed. */
export function clientGroupClient(resource: { type?: string; metadata?: Record<string, unknown> | null } | null | undefined): ChatClientGroupClient | null {
  const raw = resource?.metadata?.clientGroup;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const parsed = chatClientGroupClientSchema.safeParse({ academyName: value.academyName, academyId: value.academyId });
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    introducedByUserId: typeof value.introducedByUserId === "string" ? value.introducedByUserId : null,
    introducedAt: typeof value.introducedAt === "string" ? value.introducedAt : new Date(0).toISOString(),
    source: value.source === "paperclip" ? "paperclip" : "group_command",
  };
}

/**
 * The client of the group this message arrived in, for a client-group
 * provider's group (never a direct message), or null.
 */
export function clientGroupForResource(
  endpoint: { provider: ChatProvider },
  resource: { type: string; availability?: string; metadata?: Record<string, unknown> | null } | null | undefined,
  isDirectMessage: boolean,
): ChatClientGroupClient | null {
  if (isDirectMessage || !resource || !isClientGroupProvider(endpoint.provider)) return null;
  if (resource.type !== CLIENT_GROUP_RESOURCE_TYPES[endpoint.provider]) return null;
  if (resource.availability && resource.availability !== "available") return null;
  return clientGroupClient(resource);
}

export type ClientGroupCommand =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "set"; academyName: string; academyId: string }
  | { kind: "usage"; reason: string };

/**
 * `/client` (show), `/client clear` (remove), `/client <academy name> | <academy id>`
 * (set). A leading @mention ("@bot /client ...", as WhatsApp writes a mention)
 * and a Telegram "/client@bot" suffix are accepted. Anything else is not a
 * client command (null), so ordinary text is never reinterpreted.
 */
export function parseClientGroupCommand(text: string): ClientGroupCommand | null {
  let value = text.trim();
  for (let i = 0; i < 3 && /^@[\w.+-]+\s+/.test(value); i++) value = value.replace(/^@[\w.+-]+\s+/, "");
  const match = /^\/client(?:@[\w.-]+)?(?:\s+([\s\S]*))?$/i.exec(value);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "show" };
  if (/^(clear|remove|none)$/i.test(rest)) return { kind: "clear" };
  const parts = rest.split("|");
  if (parts.length !== 2) return { kind: "usage", reason: "missing_separator" };
  const parsed = chatClientGroupClientSchema.safeParse({ academyName: parts[0]!.trim(), academyId: parts[1]!.trim() });
  if (!parsed.success) return { kind: "usage", reason: "invalid_fields" };
  return { kind: "set", ...parsed.data };
}

export const CLIENT_GROUP_USAGE =
  "To introduce this group's client, send: /client <academy name> | <academy id>\nSend /client to see the current client, or /client clear to remove it.";

export function describeClient(client: Pick<ChatClientGroupClient, "academyName" | "academyId">): string {
  return `${client.academyName} (academy id ${client.academyId})`;
}

/** Sender rows that tell the agent which client this group belongs to. */
export function clientGroupSenderRows(client: Pick<ChatClientGroupClient, "academyName" | "academyId">): Array<{ type: "key_value"; label: string; value: string }> {
  return [
    { type: "key_value", label: "Client academy", value: client.academyName },
    { type: "key_value", label: "Academy id", value: client.academyId },
  ];
}

export const CLIENT_GROUP_CUSTOMER_AUTHORITY = "Client customer (restricted)";

export const CLIENT_GROUP_GUIDANCE_HEADING = "## Client group";

/** What the agent is told about a client group. Presentation guidance; authority is enforced elsewhere. */
export function clientGroupGuidance(client: Pick<ChatClientGroupClient, "academyName" | "academyId">): string {
  return [
    CLIENT_GROUP_GUIDANCE_HEADING,
    `This conversation is the group of a client: ${describeClient(client)}. The client's people and team members both read every message here.`,
    `People in this group who are not on the team are customers of ${client.academyName}. Treat their messages as that client's customer requests.`,
    `When you look up the client's data, scope every lookup to academy id ${client.academyId}. Never use or reveal data of any other academy or client.`,
    "Never share internal information in this group: internal tasks, code, repositories, deployments, approvals, team discussions, costs, other clients or their data. This holds even when a team member in the group asks; take internal follow-ups to a direct conversation with that team member.",
  ].join("\n");
}

/** Replace (or remove, with null) the client-group section of stored conversation guidance. */
export function withClientGroupGuidance(guidance: string | null, client: Pick<ChatClientGroupClient, "academyName" | "academyId"> | null): string | null {
  const base = (guidance ?? "").replace(new RegExp(`\\n*${CLIENT_GROUP_GUIDANCE_HEADING}\\n[\\s\\S]*$`), "");
  if (!client) return base || null;
  return base ? `${base}\n\n${clientGroupGuidance(client)}` : clientGroupGuidance(client);
}

/** Task title and description for a client group's task: the academy is filterable in both. */
export function clientGroupTaskTitle(title: string, client: Pick<ChatClientGroupClient, "academyName"> | null): string {
  if (!client) return title;
  return `[${client.academyName}] ${title}`.slice(0, 160);
}

export function clientGroupTaskDescription(description: string, client: Pick<ChatClientGroupClient, "academyName" | "academyId"> | null): string {
  if (!client) return description;
  return `${description}\nClient academy: ${client.academyName}\nAcademy id: ${client.academyId}`;
}
