"""Blocking native commit-event observer. It can grant no job authority."""
import json
import re
import subprocess
import threading
from contracts import UUID, require

class NativeStateEvents:
    def __init__(self,plugin_id,application_container="paperclip-paperclip-1",command=None):
        require(UUID.fullmatch(plugin_id),'native_event_plugin_invalid')
        require(isinstance(application_container,str)and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',application_container),'native_event_container_invalid')
        self.plugin_id=plugin_id;self.event=threading.Event();self.ready=threading.Event();self.failed=threading.Event();self.stopping=False
        # The optional command is dependency injection for isolated tests only;
        # operator configuration cannot supply an executable or script.
        argv=command or ['docker','exec','-i','--user','1000:1000','-e','NODE_OPTIONS=','-e','NODE_PATH=',application_container,'node',
            '/opt/paperclip-runner-events/native_events.mjs',plugin_id]
        self.child=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        self.thread=threading.Thread(target=self.read,daemon=True);self.thread.start()
        if not self.ready.wait(20) or self.failed.is_set():
            self.close();raise RuntimeError('native_event_listener_unavailable')
        # Initial scan starts after LISTEN. Earlier committed changes are already
        # visible to it; later events retain their own dirty bit.
        self.event.clear()
    def read(self):
        try:
            for line in iter(lambda:self.child.stdout.readline(1025),''):
                require(len(line)<=1024,'native_event_frame_invalid');value=json.loads(line)
                require(isinstance(value,dict)and set(value)=={'kind','pluginId'}and value['pluginId']==self.plugin_id,'native_event_frame_invalid')
                if value['kind']=='listening':self.ready.set();self.event.set()
                elif value['kind']=='changed':self.event.set()
                else:raise RuntimeError('native_event_listener_unavailable')
        except Exception:pass
        finally:
            if not self.stopping:self.failed.set();self.ready.set();self.event.set()
    def wait(self,timeout):
        received=self.event.wait(timeout)
        if received:self.event.clear()
        require(not self.failed.is_set(),'native_event_listener_unavailable')
        return received
    def close(self):
        self.stopping=True
        if self.child.stdin:
            try:self.child.stdin.close()
            except (OSError,BrokenPipeError):pass
        if self.child.poll()is None:
            try:self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                try:self.child.wait(timeout=2)
                except subprocess.TimeoutExpired:self.child.kill();self.child.wait(timeout=2)
        if self.child.stdout:self.child.stdout.close()
        self.thread.join(timeout=2)
