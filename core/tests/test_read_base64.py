#!/usr/bin/env python3
import atexit, base64, json, os, pathlib, subprocess, sys, tempfile

MAX_BINARY = 20 * 1024 * 1024

def send(p, i, method, params):
    body=json.dumps({"jsonrpc":"2.0","id":i,"method":method,"params":params},ensure_ascii=False,separators=(",",":")).encode()
    p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode()+body);p.stdin.flush()
    while True:
        headers={}
        while True:
            line=p.stdout.readline(); assert line
            if line==b"\r\n": break
            k,v=line.decode().split(":",1);headers[k.lower()]=v.strip()
        msg=json.loads(p.stdout.read(int(headers["content-length"])))
        if msg.get("id")==i or (msg.get("id") is None and msg.get("error",{}).get("code")==-32700):return msg

def main():
    p=subprocess.Popen([sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    def cleanup_process():
        if p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=5)
    atexit.register(cleanup_process)
    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as outside:
        root=pathlib.Path(td)
        assert send(p,0,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"readRoots":[td],"writeRoots":[td],"denyPaths":[str(root/".env")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        def fs(i,method,params): return send(p,i,method,{"sessionId":"test-session",**params})

        # Small text file roundtrip.
        (root/"hello.txt").write_bytes("hello 二进制 preview\n".encode())
        r=fs(1,"fs.readBase64",{"path":"hello.txt"})["result"]
        assert base64.b64decode(r["base64"])=="hello 二进制 preview\n".encode()
        assert r["size"]==len("hello 二进制 preview\n".encode()) and r["truncated"] is False

        # Real binary bytes (including NUL and 0xFF) roundtrip byte-exactly.
        blob=bytes(range(256))*64+b"\x00\xff\xfe\x00"
        (root/"blob.bin").write_bytes(blob)
        r=fs(2,"fs.readBase64",{"path":"blob.bin"})["result"]
        assert base64.b64decode(r["base64"])==blob
        assert r["size"]==len(blob) and r["truncated"] is False

        # Empty file: empty base64, size 0.
        (root/"empty.bin").write_bytes(b"")
        r=fs(3,"fs.readBase64",{"path":"empty.bin"})["result"]
        assert r["base64"]=="" and r["size"]==0 and r["truncated"] is False

        # Paths outside the session root are rejected before any read.
        (pathlib.Path(outside)/"secret.bin").write_bytes(b"secret")
        assert fs(4,"fs.readBase64",{"path":"../"+pathlib.Path(outside).name+"/secret.bin"})["error"]["code"]==-32002
        assert fs(5,"fs.readBase64",{"path":str(pathlib.Path(outside)/"secret.bin")})["error"]["code"]==-32002

        # denyPaths applies to binary reads exactly as to fs.read.
        (root/".env").write_bytes(b"secret")
        assert fs(6,"fs.readBase64",{"path":".env"})["error"]["code"]==-32002

        # Missing files and directories are not readable as binary.
        assert fs(7,"fs.readBase64",{"path":"missing.bin"})["error"]["code"]==-32003
        assert fs(8,"fs.readBase64",{"path":"."})["error"]["code"]==-32000

        # Unknown params fields are rejected.
        assert fs(9,"fs.readBase64",{"path":"blob.bin","offset":0})["error"]["code"]==-32602

        # Files larger than the 20 MiB budget return the prefix with truncated.
        prefix=bytes((i*7)%256 for i in range(4096))
        with open(root/"huge.bin","wb") as f:
            f.write(prefix)
            f.truncate(MAX_BINARY+7)
        r=fs(10,"fs.readBase64",{"path":"huge.bin"})["result"]
        assert r["truncated"] is True and r["size"]==MAX_BINARY
        decoded=base64.b64decode(r["base64"])
        assert len(decoded)==MAX_BINARY
        assert decoded[:4096]==prefix
        with open(root/"huge.bin","rb") as f:
            assert decoded==f.read(MAX_BINARY)

        # Exactly at the budget: full content, not truncated.
        with open(root/"exact.bin","wb") as f:
            f.truncate(MAX_BINARY)
        r=fs(11,"fs.readBase64",{"path":"exact.bin"})["result"]
        assert r["truncated"] is False and r["size"]==MAX_BINARY
        assert len(base64.b64decode(r["base64"]))==MAX_BINARY

        print("ok")

if __name__=="__main__":
    main()
