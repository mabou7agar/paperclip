import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatConversations, chatEndpointResources } from "@paperclipai/db";
import type { ChatClientGroup, ChatClientGroupClient } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { notifyChatCompanyAuthorityChange } from "../../chat-run-milestone-notifications.js";
import type { DbOrTransaction, EndpointRecord, EndpointRow } from "../runtime-types.js";
import {
  CLIENT_GROUP_RESOURCE_TYPES,
  CLIENT_GROUP_USAGE,
  answersClientGroups,
  clientGroupClient,
  describeClient,
  isClientGroupProvider,
  withClientGroupGuidance,
  type ClientGroupCommand,
} from "./core.js";

type ResourceRow = typeof chatEndpointResources.$inferSelect;

/** Keep a WhatsApp group's resource label in step with the subject the sidecar reported. */
export async function rememberWhatsAppGroupSubject(db: DbOrTransaction, resource: ResourceRow, raw: unknown): Promise<ResourceRow> {
  const subject = raw && typeof raw === "object" ? (raw as { groupSubject?: unknown }).groupSubject : undefined;
  if (typeof subject !== "string" || !subject.trim() || resource.type !== "group_chat") return resource;
  const label = subject.trim().slice(0, 200);
  if (resource.label === label || resource.availability !== "available") return resource;
  const [updated] = await db
    .update(chatEndpointResources)
    .set({ label, updatedAt: new Date() })
    .where(eq(chatEndpointResources.id, resource.id))
    .returning();
  return updated ?? resource;
}

function groupView(resource: ResourceRow): ChatClientGroup {
  return {
    resourceId: resource.id,
    providerResourceId: resource.providerResourceId,
    label: resource.label,
    availability: resource.availability,
    client: clientGroupClient(resource),
  };
}

/**
 * Store (or clear, with null) a group's client on its resource row, enable the
 * group, refresh the guidance of its open conversations and record who did it.
 * One function for both the in-group /client command and the Paperclip API.
 */
export async function setClientGroupClient(
  db: Db,
  endpoint: EndpointRow,
  resourceId: string,
  client: { academyName: string; academyId: string } | null,
  actor: { userId: string | null; source: ChatClientGroupClient["source"] },
): Promise<ChatClientGroup> {
  const updated = await db.transaction(async (tx) => {
    const [resource] = await tx
      .select()
      .from(chatEndpointResources)
      .where(and(eq(chatEndpointResources.id, resourceId), eq(chatEndpointResources.endpointId, endpoint.id)))
      .for("update");
    if (!resource || resource.type !== CLIENT_GROUP_RESOURCE_TYPES[endpoint.provider]) throw notFound("Group not found");
    const stored: ChatClientGroupClient | null = client
      ? { academyName: client.academyName, academyId: client.academyId, introducedByUserId: actor.userId, introducedAt: new Date().toISOString(), source: actor.source }
      : null;
    const metadata = { ...(resource.metadata ?? {}) } as Record<string, unknown>;
    if (stored) metadata.clientGroup = stored;
    else delete metadata.clientGroup;
    const [row] = await tx
      .update(chatEndpointResources)
      .set({ metadata, ...(stored ? { enabled: true } : {}), updatedAt: new Date() })
      .where(eq(chatEndpointResources.id, resource.id))
      .returning();
    // The agent's standing guidance for open conversations in this group.
    const open = await tx
      .select({ id: chatConversations.id, communicationGuidance: chatConversations.communicationGuidance })
      .from(chatConversations)
      .where(and(eq(chatConversations.endpointId, endpoint.id), eq(chatConversations.resourceId, resource.id), inArray(chatConversations.state, ["active", "waiting"])));
    for (const conversation of open)
      await tx
        .update(chatConversations)
        .set({ communicationGuidance: withClientGroupGuidance(conversation.communicationGuidance, stored), updatedAt: new Date() })
        .where(eq(chatConversations.id, conversation.id));
    // Who may speak in the group changed (customers admitted or not).
    await notifyChatCompanyAuthorityChange(tx, { companyId: endpoint.companyId });
    return row!;
  });
  await logActivity(db, {
    companyId: endpoint.companyId,
    actorType: actor.userId ? "user" : "system",
    actorId: actor.userId ?? "chat_client_group",
    action: client ? "chat_client_group.set" : "chat_client_group.cleared",
    entityType: "tool_connection",
    entityId: endpoint.connectionId,
    details: {
      endpointId: endpoint.id,
      resourceId,
      source: actor.source,
      ...(client ? { academyName: client.academyName, academyId: client.academyId } : {}),
    },
  }).catch(() => undefined);
  return groupView(updated);
}

/**
 * Handle a /client command from a linked, active, non-viewer team member (the
 * caller has checked that) and return the confirmation for the group.
 */
export async function applyClientGroupCommand(
  db: Db,
  endpoint: EndpointRow,
  resource: ResourceRow,
  command: ClientGroupCommand,
  actorUserId: string,
  options: { senderIsGroupAdmin?: boolean } = {},
): Promise<string> {
  const current = clientGroupClient(resource);
  if (command.kind === "usage") return CLIENT_GROUP_USAGE;
  if (command.kind === "show")
    return current
      ? `This group's client is ${describeClient(current)}.${answersClientGroups(endpoint) ? " Requests from people here who are not on the team are handled as this client's customer requests." : " Answering client groups is turned off for this channel."}`
      : `No client is set for this group.\n${CLIENT_GROUP_USAGE}`;
  if (command.kind === "clear") {
    if (!current) return "No client is set for this group.";
    await setClientGroupClient(db, endpoint, resource.id, null, { userId: actorUserId, source: "group_command" });
    return `Client removed. Messages from people here who are not on the team are no longer answered.`;
  }
  await setClientGroupClient(db, endpoint, resource.id, { academyName: command.academyName, academyId: command.academyId }, { userId: actorUserId, source: "group_command" });
  const admin = options.senderIsGroupAdmin === false ? " (introduced by a team member who is not a group admin)" : "";
  return answersClientGroups(endpoint)
    ? `Client set: ${describeClient(command)}${admin}. Requests from people here who are not on the team are now handled as this client's customer requests.`
    : `Client set: ${describeClient(command)}${admin}. Answering client groups is turned off for this channel, so only team members are answered here.`;
}

/** Paperclip side: list a channel's groups and set or clear their client. People only (the route checks). */
export function createChatClientGroups(db: Db, options: { endpointRecord: (endpointId: string) => Promise<EndpointRecord | null> }) {
  async function groupEndpoint(endpointId: string) {
    const record = await options.endpointRecord(endpointId);
    if (!record || !isClientGroupProvider(record.endpoint.provider)) throw notFound("Chat channel not found");
    if (record.endpoint.status === "archived") throw conflict("This channel was removed", { code: "chat_endpoint_archived" });
    return record.endpoint;
  }

  async function list(endpointId: string): Promise<{ groups: ChatClientGroup[] }> {
    const endpoint = await groupEndpoint(endpointId);
    const rows = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, endpoint.id),
          eq(chatEndpointResources.type, CLIENT_GROUP_RESOURCE_TYPES[endpoint.provider]!),
          ne(chatEndpointResources.availability, "removed"),
        ),
      )
      .orderBy(sql`lower(${chatEndpointResources.label})`);
    return { groups: rows.map(groupView) };
  }

  async function set(
    endpointId: string,
    resourceId: string,
    input: { client: { academyName: string; academyId: string } | null },
    actorUserId: string | null,
  ): Promise<ChatClientGroup> {
    const endpoint = await groupEndpoint(endpointId);
    if (!/^[0-9a-f-]{36}$/i.test(resourceId)) throw unprocessable("Invalid group id");
    return setClientGroupClient(db, endpoint, resourceId, input.client, { userId: actorUserId, source: "paperclip" });
  }

  return { list, set };
}
