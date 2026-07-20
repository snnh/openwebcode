#!/usr/bin/env python3
import ctypes, json, os, pathlib, subprocess, sys, tempfile

def windows_short_path(path):
    if os.name != "nt": return None
    required=ctypes.windll.kernel32.GetShortPathNameW(str(path),None,0)
    if not required: return None
    buffer=ctypes.create_unicode_buffer(required)
    if not ctypes.windll.kernel32.GetShortPathNameW(str(path),buffer,required): return None
    return buffer.value

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
    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as outside:
        root=pathlib.Path(td); (root/"目录").mkdir();
        assert send(p,0,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"readRoots":[td],"writeRoots":[td],"denyPaths":[str(root/".env")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        (root/".env").write_text("secret")
        (root/"private").mkdir(); (root/"private"/"secret.txt").write_text("secret")
        assert send(p,105,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"denyPaths":[str(root/".env"),str(root/"private")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        assert send(p,104,"fs.read",{"sessionId":"test-session","path":".env"})["error"]["code"]==-32002
        assert send(p,106,"fs.read",{"sessionId":"test-session","path":"private/secret.txt"})["error"]["code"]==-32002
        def fs(i,method,params): return send(p,i,method,{"sessionId":"test-session",**params})
        first_write=fs(1,"fs.write",{"path":"目录/文件.txt","content":"一\n二\n三"})
        assert first_write.get("result",{}).get("ok"),first_write
        assert fs(101,"fs.write",{"path":"新/深/文件.txt","content":"alpha\nbeta","createDirs":True})["result"]["ok"]
        globbed=fs(102,"fs.glob",{"path":".","pattern":"新/*/文件.txt"})["result"]
        assert globbed=={"paths":["新/深/文件.txt"],"truncated":False},globbed
        matches=fs(103,"fs.grep",{"path":"新","pattern":"beta"})["result"]
        assert matches=={"matches":[{"path":"深/文件.txt","line":2,"text":"beta"}],"truncated":False},matches
        r=fs(2,"fs.read",{"path":"目录/文件.txt","offset":1,"limit":1})["result"]
        assert r=={"content":"二\n","totalLines":3,"encoding":"utf-8","truncated":True},r
        assert fs(3,"fs.stat",{"path":"目录/文件.txt"})["result"]["type"]=="file"
        listing=fs(4,"fs.list",{"path":"目录"})["result"]
        assert listing["truncated"] is False
        assert any(x["name"]=="文件.txt" for x in listing["entries"])
        assert fs(41,"fs.read",{"path":"目录/文件.txt"})["result"]["content"]=="一\n二\n三"
        # Windows returns canonical long paths from file handles.  A cwd supplied
        # in 8.3 form must still compare as the same workspace root.
        short_root=root/"short path root"; short_root.mkdir()
        short_cwd=windows_short_path(short_root)
        if short_cwd and os.path.normcase(short_cwd)!=os.path.normcase(str(short_root)):
            assert send(p,142,"session.configure",{"sessionId":"short-path-session","cwd":short_cwd,"sandbox":{"enabled":True,"readRoots":[short_cwd],"writeRoots":[short_cwd],"denyPaths":[],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
            short_write=send(p,143,"fs.write",{"sessionId":"short-path-session","path":"result.txt","content":"short-path-ok"})
            assert short_write.get("result",{}).get("ok"),short_write
            assert (short_root/"result.txt").read_text()=="short-path-ok"
        assert fs(5,"fs.read",{"path":"目录/文件.txt","offset":-1,"limit":1})["error"]["code"]==-32602
        assert fs(6,"fs.read",{"path":"目录/文件.txt","offset":0,"limit":0})["error"]["code"]==-32602
        assert fs(7,"fs.write",{"path":"目录/nul","content":"a\u0000b"})["error"]["code"]==-32700
        (root/"bad").write_bytes(b"\xff")
        assert fs(8,"fs.read",{"path":"bad","offset":0,"limit":1})["error"]["code"]==-32602
        assert fs(9,"fs.edit",{"path":"目录/文件.txt","oldText":"无","newText":"x"})["error"]["code"]==-32602
        assert fs(10,"fs.write",{"path":"multi","content":"aa"})["result"]["ok"]
        assert fs(11,"fs.edit",{"path":"multi","oldText":"a","newText":"b"})["error"]["code"]==-32602
        assert fs(111,"fs.edit",{"path":"multi","oldText":"a","newText":"b","replaceAll":True})["result"]["matches"]==2
        assert fs(12,"fs.edit",{"path":"multi","oldText":"bb","newText":"好"})["result"]["matches"]==1
        assert fs(13,"fs.stat",{"path":"missing"})["error"]["code"]==-32003
        assert fs(14,"fs.stat",{"path":"../x"})["error"]["code"]==-32002
        for i in range(20): assert fs(20+i,"fs.write",{"path":"repeat","content":str(i)})["result"]["ok"]
        assert not list(root.glob("*.tmp")) and not list(root.glob(".*.tmp"))
        (pathlib.Path(outside)/"secret").write_text("secret")
        link=root/"escape"
        try:
            if os.name=="nt": os.symlink(outside,link,target_is_directory=True)
            else: os.symlink(outside,link)
        except OSError: pass
        else:
            assert fs(50,"fs.read",{"path":"escape/secret","offset":0,"limit":1})["error"]["code"]==-32002
            assert fs(51,"fs.write",{"path":"escape/new","content":"no"})["error"]["code"]==-32002
        assert send(p,99,"core.shutdown",{})["result"]["ok"]
    assert p.wait()==0
if __name__=="__main__":main()
