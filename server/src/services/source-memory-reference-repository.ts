import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { referenceCheck, referenceTerms, SOURCE_REFERENCE_LIMITS as limits, type SourceReferenceScope, type SourceReferenceBundle, type SourceReferenceHit } from "./source-memory-reference-types.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reads only an explicitly selected, already complete scope. Never refreshes Git. */
export class SourceMemoryReferenceRepository {
  private readonly state: string;
  constructor(state: string) { this.state=state; }
  async read(scope: SourceReferenceScope, revision: string, query: string): Promise<SourceReferenceBundle> {
    referenceCheck(/^[a-f0-9]{40}$/.test(revision), "revision_invalid");
    const root = path.resolve(this.state);
    const directory = path.join(root, "runtime-v1", sha(JSON.stringify(scope)));
    const file = path.join(directory, "reader", "knowledge-v3.sqlite");
    for (const candidate of [root, path.join(root, "runtime-v1"), directory, path.dirname(file), file]) {
      const s = await lstat(candidate);
      referenceCheck(!s.isSymbolicLink() && await realpath(candidate) === candidate && (s.mode & 0o077) === 0 &&
        (candidate === file ? s.isFile() : s.isDirectory()), "storage_denied");
    }
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
      const args = [scope.companyId, scope.projectId, scope.repositoryId, revision];
      const manifest = db.prepare("SELECT status,cursor,payload FROM manifests WHERE company=? AND project=? AND repository=? AND revision=?").get(...args) as {status:string;cursor:number;payload:string}|undefined;
      referenceCheck(manifest && manifest.status === "complete" && manifest.payload.length <= 1_048_576, "index_incomplete");
      const saved = JSON.parse(manifest.payload);
      referenceCheck(saved.revision === revision && saved.status === "complete" && Number.isSafeInteger(saved.totalFiles) && manifest.cursor === saved.totalFiles, "index_incomplete");
      const terms = referenceTerms(query);
      const hits: SourceReferenceHit[] = [];
      if (terms.length) {
        const unicodeFold=terms.some(t=>/[^\x00-\x7f]/.test(t)&&t.toUpperCase()!==t.toLowerCase());
        const fold=unicodeFold?"reference_fold":"lower";
        if(unicodeFold)db.function("reference_fold",{deterministic:true},(value:unknown)=>typeof value==="string"?value.toLowerCase():"");
        const pathWhere=terms.map(()=>`instr(${fold}(path),?)>0`).join(" OR ");
        const pathScore=terms.map(()=>`CASE WHEN instr(${fold}(path),?)>0 THEN 1 ELSE 0 END`).join("+");
        const paths=db.prepare(`SELECT path FROM documents WHERE company=? AND project=? AND repository=? AND revision=? AND (${pathWhere}) ORDER BY (${pathScore}) DESC,path LIMIT ?`).all(...args,...terms,...terms,limits.hits) as {path:string}[];
        const rows: {path:string;hash:string;content:string}[]=[];
        if(paths.length){
          for(const found of paths){
            const row=db.prepare("SELECT path,hash,content FROM documents WHERE company=? AND project=? AND repository=? AND revision=? AND path=? AND length(CAST(content AS BLOB))<=1048576").get(...args,found.path);
            if(row)rows.push(row as {path:string;hash:string;content:string});
          }
        }else{
          const where=terms.map(()=>`instr(${fold}(content),?)>0`).join(" OR ");
          const score=terms.map(()=>`CASE WHEN instr(${fold}(content),?)>0 THEN 1 ELSE 0 END`).join("+");
          rows.push(...db.prepare(`SELECT path,hash,content FROM documents WHERE company=? AND project=? AND repository=? AND revision=? AND length(CAST(content AS BLOB))<=1048576 AND (${where}) ORDER BY (${score}) DESC,path LIMIT ?`).all(...args,...terms,...terms,limits.hits) as {path:string;hash:string;content:string}[]);
        }
        for (const row of rows) {
          referenceCheck(typeof row.path === "string" && row.path.length <= 1024 && !row.path.includes("\0") && !row.path.includes("\\") &&
            row.path.split("/").every(part=>part && part!=="." && part!=="..") && /^[a-f0-9]{64}$/.test(row.hash) && sha(row.content) === row.hash, "document_invalid");
          const lines = row.content.split("\n"), at = lines.findIndex(line => terms.some(t=>line.toLowerCase().includes(t))), start = Math.max(0, at-2);
          const excerpt: string[] = [];
          for (let i=start; i<Math.min(lines.length,start+limits.lines); i++) {
            if (Buffer.byteLength([...excerpt,lines[i]].join("\n"))>limits.contentBytes) break;
            excerpt.push(lines[i]);
          }
          if (excerpt.length) hits.push({path:row.path,startLine:start+1,endLine:start+excerpt.length,content:excerpt.join("\n"),indexedContentSha256:row.hash});
        }
      }
      return {schema:1,standing:"reference",indexedScope:scope,revision,hits,blobReads:0,indexRefreshes:0};
    } finally { db.close(); }
  }
}
