import net from 'node:net';

export const NATIVE_WAKE_SOCKET = '/opt/paperclip-runner-wake/wake.sock';

/** A content-free hint, never execution or identity authority. The broker
 * reconstructs durable native state on startup and after each hint. */
export function notifyNativeBroker() {
  return new Promise(resolve => {
    const socket = net.createConnection({path:NATIVE_WAKE_SOCKET});
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
    socket.setTimeout(1000,()=>finish(false));
    socket.once('error',()=>finish(false));
    socket.once('connect',()=>socket.end('1',()=>finish(true)));
    socket.once('close',()=>finish(false));
  });
}
