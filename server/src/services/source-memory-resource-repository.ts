import { lstat, readdir, statfs, mkdir, chmod } from "node:fs/promises";
import { freemem } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { capacityCheck, type CapacityResources } from "./source-memory-capacity.js";

/** Private index storage, not the application database. SQLite owns the lock
 * lifetime, including process death; it cannot leave a stale PID lease. */
export async function acquireIndexCapacityLease(state: string) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const root = await lstat(state);
  capacityCheck(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o077) === 0, "state_permissions");
  const file = path.join(state, "capacity-lock.sqlite");
  try { capacityCheck((await lstat(file)).isFile(), "state_path_denied"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const db = new DatabaseSync(file);
  try { await chmod(file, 0o600); db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
  catch { db.close(); throw new Error("source_memory_capacity_busy"); }
  return () => db.close();
}

export class SourceMemoryResourceRepository {
  private readonly state: string;
  private readonly scope: string;
  constructor(state: string, scope: string) { this.state = path.resolve(state); this.scope = path.resolve(scope); }
  acquire() { return acquireIndexCapacityLease(this.state); }
  async snapshot(): Promise<CapacityResources> {
    capacityCheck(this.scope.startsWith(this.state + path.sep), "scope_outside_state");
    const disk = await statfs(this.state);
    const availableMemoryBytes = Math.floor(Math.min(freemem(), process.availableMemory()));
    let entries = 0, stateBytes = 0, scopeBytes = 0;
    const visit = async (root: string) => {
      capacityCheck(++entries <= 20_000, "state_inventory_budget");
      let s;
      try { s = await lstat(root); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
      capacityCheck(!s.isSymbolicLink(), "state_path_denied");
      if (s.isDirectory()) {
        let names;
        try { names = await readdir(root); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
        for (const name of names) await visit(path.join(root, name));
      }
      else {
        capacityCheck(s.isFile(), "state_path_denied");
        stateBytes += s.size;
        if (root.startsWith(this.scope + path.sep)) scopeBytes += s.size;
      }
    };
    await visit(this.state);
    return { freeDiskBytes: Math.floor(disk.bavail * disk.bsize), totalDiskBytes: Math.floor(disk.blocks * disk.bsize), availableMemoryBytes, stateBytes, scopeBytes };
  }
}
