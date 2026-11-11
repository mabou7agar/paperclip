import { createHash } from "node:crypto";
import { verifyBlobBatch } from "./source-memory.js";

/** Read immutable objects only. No Memory instance, index, cache, ledger or HEAD mutation.
 * Production transport retains the manifest-pinned Git storage/configuration guard.
 */
export async function readSourceCitationFromGit(
  scope: { companyId: string; projectId: string; repositoryId: string },
  c: { revision: string; path: string; startLine: number; endLine: number },
  read: (args: string[], stdin: string | undefined, maxBytes: number) => Promise<Buffer>,
) {
  const require = (ok: unknown, code: string) => { if (!ok) throw new Error(`source_memory_${code}`); };
  require(c && /^[a-f0-9]{40}$/.test(c.revision) && typeof c.path === "string" && c.path.length <= 1024 &&
    !c.path.includes("\0") && !c.path.includes("\\") && !c.path.split("/").some(part => !part || part === "." || part === "..") &&
    Number.isSafeInteger(c.startLine) && Number.isSafeInteger(c.endLine) && c.startLine > 0 &&
    c.endLine >= c.startLine && c.endLine - c.startLine < 40, "citation_invalid");
  require((await read(["rev-parse", "--verify", `${c.revision}^{commit}`], undefined, 1024)).toString().trim() === c.revision, "revision_invalid");
  const tree = (await read(["ls-tree", "-r", "-z", c.revision], undefined, 16_000_000)).toString("utf8");
  const entry = tree.split("\0").find(row => row.slice(row.indexOf("\t") + 1) === c.path);
  const match = entry && /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry);
  require(match, "citation_path_denied");
  const blob = match![1];
  const header = (await read(["cat-file", "--batch-check"], blob + "\n", 1024)).toString("ascii");
  const size = new RegExp(`^${blob} blob (0|[1-9][0-9]*)\n$`).exec(header);
  require(size && Number(size[1]) <= 256_000, "citation_file_budget");
  const bytes = await read(["cat-file", "--batch"], blob + "\n", 256_256);
  verifyBlobBatch(bytes, [blob]);
  const content = bytes.subarray(bytes.indexOf(10) + 1, bytes.length - 1);
  require(c.endLine <= content.toString("utf8").split("\n").length, "citation_range_invalid");
  return { ...scope, ...c, sha256: createHash("sha256").update(content).digest("hex") };
}
