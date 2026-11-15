import net from 'node:net';

export const NATIVE_WAKE_SOCKET = '/opt/paperclip-runner-wake/wake.sock';

/** A non-authoritative intent hint. The root ledger commits before ACK. The broker
 * reconstructs durable native state on startup and after each hint. */
export function notifyNativeBroker(request) {
  return new Promise(resolve => {
    const socket = net.createConnection({path:NATIVE_WAKE_SOCKET});
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
    socket.setTimeout(2000,()=>finish(false));
    socket.once('error',()=>finish(false));
    socket.once('connect',()=>socket.write(JSON.stringify(request?{companyId:request.companyId,jobId:request.jobId,
      sourceRunId:request.sourceRunId,taskId:request.taskId}:null)+'\n'));
    socket.once('data',value=>finish(value.equals(Buffer.from('1'))));
    socket.once('close',()=>finish(false));
  });
}
