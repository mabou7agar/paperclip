import { createHash } from "node:crypto";
import type { ChatSdkStatePersistence, ChatSdkStateScope } from "../chat-sdk-state.js";

/**
 * Small typed records for one WhatsApp endpoint (prompt receipts for owner
 * cards), kept in the existing company/endpoint scoped compare-and-set store.
 */
export class WhatsAppState {
  constructor(
    readonly scope: ChatSdkStateScope,
    private readonly persistence: ChatSdkStatePersistence,
  ) {}

  private key(key: string): string {
    return `whatsapp:${createHash("sha256").update(key).digest("hex")}`;
  }

  async read<T>(key: string): Promise<T | null> {
    const row = await this.persistence.read(this.scope, this.key(key));
    return row ? (row.value as T) : null;
  }

  async write<T>(key: string, value: T | null, expiresAt: Date | null = null): Promise<void> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const row = await this.persistence.read(this.scope, this.key(key));
      if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new Error("WhatsApp state record is too large");
      if (
        await this.persistence.compareAndSet({
          ...this.scope,
          key: this.key(key),
          expectedVersion: row?.version ?? null,
          expiresAt,
          value,
        })
      )
        return;
    }
    throw new Error("WhatsApp state changed concurrently; retry");
  }
}
