import fs from "node:fs/promises";
import path from "node:path";

/** Link a private transcript directory without replacing existing data or foreign links. */
export async function linkManagedSessionDirectory(target: string, link: string): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink() || path.resolve(path.dirname(link), await fs.readlink(link)) !== target) {
      throw new Error("Managed transcript storage conflicts with an existing path");
    }
  }
}
