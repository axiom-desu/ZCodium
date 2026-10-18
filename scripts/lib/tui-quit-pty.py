#!/usr/bin/env python3
"""Built TS CLI lifecycle acceptance; only the supplied private fixture and child are touched."""
import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

def main():
    cfg=json.load(sys.stdin); master,slave=pty.openpty()
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,160,0,0))
    original=termios.tcgetattr(slave); output=bytearray()
    def setup():
        os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
    child=subprocess.Popen([cfg['node'],cfg['entry']],cwd=cfg['cwd'],env=cfg['env'],stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup,close_fds=True)
    def drain():
        if select.select([master],[],[],0.05)[0]:
            try:output.extend(os.read(master,65536))
            except OSError as e:
                if e.errno!=errno.EIO:raise
    def text():
        raw=output.decode('utf-8','replace')
        raw=re.sub(r'\x1b\].*?(?:\x07|\x1b\\)','',raw,flags=re.S)
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',raw)
    def wait(predicate,label,seconds=30):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            drain()
            if predicate():return
            if child.poll() is not None:raise RuntimeError('CLI exited before '+label)
        raise RuntimeError('deadline waiting for '+label)
    try:
        # Product+version is emitted by the mounted TuiApp sidebar, not the startup spinner.
        wait(lambda:bool(re.search(r'ZCodium\s+\d+\.',text())),'mounted TUI')
        if cfg['busy']:
            os.write(master,b'slow request\r')
            wait(lambda:'partial' in text(),'real model stream')
        os.write(master,b'/quit\r')
        wait(lambda:child.poll() is not None,'/quit process exit',15)
        if child.returncode!=0:raise RuntimeError('nonzero /quit exit '+str(child.returncode))
        current=termios.tcgetattr(slave)
        if current[3]&(termios.ECHO|termios.ICANON)!=original[3]&(termios.ECHO|termios.ICANON):raise RuntimeError('terminal mode not restored')
        print(json.dumps({'status':'passed','busy':cfg['busy'],'exit':child.returncode,'termios':True}))
    finally:
        with open(os.path.join(cfg['root'],'pty-output.ansi'),'wb') as f:f.write(output)
        if child.poll() is None:os.killpg(child.pid,signal.SIGKILL);child.wait()
        termios.tcsetattr(slave,termios.TCSANOW,original);os.close(master);os.close(slave)

try:main()
except Exception as error:
    print(json.dumps({'status':'failed','error':str(error)}));sys.exit(1)
