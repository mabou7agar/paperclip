import { createHash } from "node:crypto";
import type { RemoteSourceRequest, RemoteSourceReader } from "./source-memory.js";

// A closed Git-only read protocol. No shell, network, arbitrary path reads, repository writes or archives.
export const remoteSourceGitScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
(async()=>{try {
 const [baseArg,rootArg,raw,guard]=process.argv.slice(1),q=JSON.parse(raw);
 const base=fs.realpathSync(baseArg),root=fs.realpathSync(rootArg);
 const inside=p=>p===base||p.startsWith(base+path.sep);
 if(!inside(root)||!Array.isArray(q.args)||q.args.length>12||!q.args.every(a=>typeof a==='string'&&a.length<1024))throw Error();
 // Admit metadata paths before the accepted guard scans them; never scan a foreign common dir.
 const text=p=>{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>4096)throw Error();return fs.readFileSync(p,'utf8').trim()};
 const dot=path.join(root,'.git'),entry=fs.lstatSync(dot);let metadata=dot;
 if(entry.isFile()){const value=text(dot);if(!/^gitdir: [^\0\r\n]+$/.test(value))throw Error();metadata=path.resolve(root,value.slice(8))}
 else if(!entry.isDirectory()||entry.isSymbolicLink())throw Error();
 if(!inside(metadata)||fs.realpathSync(metadata)!==metadata)throw Error();
 let common=metadata;const commonLink=path.join(metadata,'commondir');
 if(fs.existsSync(commonLink))common=path.resolve(metadata,text(commonLink));
 if(!inside(common)||fs.realpathSync(common)!==common)throw Error();
 const {SafeGitRepository}=await import(guard),safe=new SafeGitRepository();
 const storage=await safe.storage.assert(root);
 if(storage.repoRoot!==root||!inside(storage.metadata)||!inside(storage.common)||!inside(storage.objects))throw Error();
 const prefix=await safe.arguments(root),options=safe.options();
 const run=(args,input,maxBuffer)=>cp.execFileSync('git',[...prefix,...args],{...options,input,maxBuffer,timeout:15000,stdio:['pipe','pipe','pipe']});
 const a=q.args,sha=s=>/^[a-f0-9]{40}$/.test(s),same=v=>JSON.stringify(a)===JSON.stringify(v);
 const allowed=same(['rev-parse','--show-toplevel'])||same(['rev-parse','HEAD'])||same(['symbolic-ref','-q','HEAD'])
  ||same(['remote','get-url','origin'])||same(['ls-files','-v','-z'])||same(['ls-files','--others','--exclude-standard','-z'])
  ||a.length===3&&a[0]==='rev-parse'&&a[1]==='--verify'&&/^[a-f0-9]{40}\^\{commit\}$/.test(a[2])
  ||a.length===4&&a[0]==='ls-tree'&&a[1]==='-r'&&a[2]==='-z'&&sha(a[3])
  ||a.length===5&&a[0]==='ls-tree'&&a[1]==='-r'&&a[2]==='--name-only'&&a[3]==='-z'&&sha(a[4])
  ||a.length===6&&a[0]==='diff'&&a[1]==='--binary'&&a[2]==='--no-ext-diff'&&a[3]==='--no-textconv'&&sha(a[4])&&a[5]==='--'
  ||a.length===7&&a[0]==='diff'&&a[1]==='--name-status'&&a[2]==='-z'&&a[3]==='--find-renames'&&sha(a[4])&&sha(a[5])&&a[6]==='--'
  ||a.length===2&&a[0]==='cat-file'&&['--batch','--batch-check'].includes(a[1])&&typeof q.stdin==='string'&&q.stdin.length<33000&&q.stdin.trim().split('\n').every(sha);
 if(!allowed||!Number.isInteger(q.maxBytes)||q.maxBytes<1||q.maxBytes>134300000)throw Error();
 process.stdout.write(run(a,q.stdin,q.maxBytes).toString('base64'));
} catch { process.stderr.write('source_memory_remote_read_refused');process.exitCode=1; }})();
`;

export function createRemoteSourceReader(input: {
  cwd: string; baseCwd: string; assertOwned: () => Promise<void>;
  execute: (request: { command: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; bypassSession: true }) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
}): RemoteSourceReader {
  return async (request: RemoteSourceRequest) => {
    await input.assertOwned();
    const guards = request.guards;
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    if (!guards || digest(guards.safe) !== "a920416b7a0334d96d83b9f63ea32b66e632838f2c5bea9d5776718c255551ae" ||
        digest(guards.storage) !== "648e10854c124005b5e0856ca2f43d5d2c40bf7af6b97ef48240e79bf6c6cd63") throw new Error("source_memory_reader_content_changed");
    const dataUrl = (value: string) => "data:text/javascript;base64," + Buffer.from(value).toString("base64");
    const safe = guards.safe.replace("'./GitStorageRepository.mjs'", JSON.stringify(dataUrl(guards.storage)));
    const { guards: _guards, ...bounded } = request;
    const result = await input.execute({ command: "node", args: ["-e", remoteSourceGitScript, input.baseCwd, input.cwd, JSON.stringify(bounded), dataUrl(safe)],
      cwd: input.baseCwd, env: { NODE_OPTIONS: "", NODE_PATH: "", NODE_NO_WARNINGS: "1" }, timeoutMs: 20_000, bypassSession: true });
    await input.assertOwned();
    if (result.exitCode !== 0 || result.timedOut || result.stdout.length > Math.ceil(request.maxBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.stdout)) throw new Error("source_memory_remote_read_refused");
    return result.stdout;
  };
}
