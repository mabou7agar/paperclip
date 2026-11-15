"""Actual loopback transport; synthetic envelope only, no execution or providers."""
import http.server
import json
import pathlib
import sys
import threading
import unittest
import uuid

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'broker'))
from native_repository import NativeRepository

class NativeWebhookHttpTest(unittest.TestCase):
    def test_signed_output_uses_fixed_webhook_without_reading_or_sending_board_token(self):
        seen=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                seen.append((self.path,self.headers.get('Authorization'),json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(b'{"deliveryId":"synthetic-delivery","status":"success"}')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            native=NativeRepository({'apiBaseUrl':f'http://127.0.0.1:{server.server_port}',
                'tokenFile':'/this-fixture-must-never-read-a-board-token'})
            plugin=str(uuid.uuid4());envelope={'payload':'synthetic-public-fixture','signature':'synthetic-no-authority'}
            result=native.deliver_envelope(plugin,envelope)
            self.assertEqual(result['status'],'success')
            self.assertEqual(seen,[(f'/api/plugins/{plugin}/webhooks/terminal',None,envelope)])
            with self.assertRaises(Exception):native.deliver_envelope('../other',envelope)
            self.assertEqual(len(seen),1)
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)

if __name__=='__main__':unittest.main()
