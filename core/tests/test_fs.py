#!/usr/bin/env python3
import atexit, ctypes, hashlib, json, os, pathlib, subprocess, sys, tempfile, time

def windows_short_path(path):
    if os.name != "nt": return None
    required=ctypes.windll.kernel32.GetShortPathNameW(str(path),None,0)
    if not required: return None
    buffer=ctypes.create_unicode_buffer(required)
    if not ctypes.windll.kernel32.GetShortPathNameW(str(path),buffer,required): return None
    return buffer.value

def directory_link(link, target):
    try:
        if os.name == "nt": os.symlink(target, link, target_is_directory=True)
        else: os.symlink(target, link)
        return True
    except OSError:
        # Creating a symbolic link needs elevation on some Windows hosts;
        # a directory junction exercises the same reparse-point boundary.
        if os.name == "nt":
            return subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],capture_output=True).returncode == 0
        return False

def directory_junction(link, target):
    if os.name != "nt": return False
    return subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],capture_output=True).returncode == 0

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
        root=pathlib.Path(td); (root/"目录").mkdir();
        assert send(p,0,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"readRoots":[td],"writeRoots":[td],"denyPaths":[str(root/".env")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        (root/".env").write_text("secret")
        (root/"private").mkdir(); (root/"private"/"secret.txt").write_text("secret")
        assert send(p,105,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"denyPaths":[str(root/".env"),str(root/"private")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        assert send(p,104,"fs.read",{"sessionId":"test-session","path":".env"})["error"]["code"]==-32002
        assert send(p,107,"fs.read",{"sessionId":"test-session","path":"./.env"})["error"]["code"]==-32002
        assert send(p,106,"fs.read",{"sessionId":"test-session","path":"private/secret.txt"})["error"]["code"]==-32002
        def fs(i,method,params): return send(p,i,method,{"sessionId":"test-session",**params})
        # denyPaths is enforced on the resolved path, not the request text:
        # a directory junction into a denied tree and a trailing-dot spelling
        # of the denied directory must both be rejected (Windows only).
        if os.name == "nt":
            if directory_junction(root/"private-link", root/"private"):
                assert fs(180,"fs.read",{"path":"private-link/secret.txt"})["error"]["code"]==-32002
                assert fs(181,"fs.write",{"path":"private-link/injected.txt","content":"no"})["error"]["code"]==-32002
                # Remove the junction again: later glob/scan coverage only
                # tolerates unreadable directories, not reparse points.
                os.rmdir(root/"private-link")
            assert fs(182,"fs.read",{"path":"private./secret.txt"})["error"]["code"]==-32002
        first_write=fs(1,"fs.write",{"path":"目录/文件.txt","content":"一\n二\n三"})
        assert first_write.get("result",{}).get("ok"),first_write
        assert fs(101,"fs.write",{"path":"新/深/文件.txt","content":"alpha\nbeta","createDirs":True})["result"]["ok"]
        # readRoots/writeRoots are enforced by every file RPC, independently
        # of denyPaths.  A later configure restores the broad workspace policy
        # for the remaining filesystem coverage below.
        assert send(p,108,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"readRoots":[str(root/"目录")],"writeRoots":[str(root/"新")],"denyPaths":[],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        assert fs(109,"fs.read",{"path":"新/深/文件.txt"})["error"]["code"]==-32002
        assert fs(110,"fs.write",{"path":"目录/blocked.txt","content":"no"})["error"]["code"]==-32002
        assert send(p,111,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"readRoots":[td],"writeRoots":[td],"denyPaths":[str(root/".env"),str(root/"private")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        globbed=fs(102,"fs.glob",{"path":".","pattern":"新/*/文件.txt"})["result"]
        assert globbed=={"paths":["新/深/文件.txt"],"truncated":False},globbed
        matches=fs(103,"fs.grep",{"path":"新","pattern":"beta"})["result"]
        assert matches=={"matches":[{"path":"深/文件.txt","line":2,"text":"beta"}],"truncated":False},matches
        r=fs(2,"fs.read",{"path":"目录/文件.txt","offset":1,"limit":1})["result"]
        assert r=={"content":"二\n","totalLines":3,"encoding":"utf-8","truncated":True},r
        assert fs(3,"fs.stat",{"path":"目录/文件.txt"})["result"]["type"]=="file"
        many=send(p,150,"fs.statMany",{"sessionId":"test-session","paths":["目录/文件.txt","新/深/文件.txt"]})["result"]
        assert [entry["path"] for entry in many["entries"]]==["目录/文件.txt","新/深/文件.txt"]
        assert [entry["type"] for entry in many["entries"]]==["file","file"]
        assert send(p,151,"fs.statMany",{"sessionId":"test-session","paths":[]})["error"]["code"]==-32602
        content="一\n二\n三".encode()
        assert fs(148,"fs.hash",{"path":"目录/文件.txt"})["result"]=={"sha256":hashlib.sha256(content).hexdigest(),"size":len(content)}
        assert fs(149,"fs.hash",{"path":"目录/文件.txt","unexpected":True})["error"]["code"]==-32602
        assert fs(152,"fs.write",{"path":"scan-root/a.txt","content":"a","createDirs":True})["result"]["ok"]
        assert fs(153,"fs.write",{"path":"scan-root/nested/b.txt","content":"b","createDirs":True})["result"]["ok"]
        assert fs(154,"fs.write",{"path":"scan-root/private/secret.txt","content":"secret","createDirs":True})["result"]["ok"]
        # scan paths are relative to the requested base, have a stable cursor,
        # and never reveal or descend into a denied directory.
        assert send(p,155,"session.configure",{"sessionId":"test-session","cwd":td,"sandbox":{"enabled":True,"denyPaths":[str(root/".env"),str(root/"private"),str(root/"scan-root"/"private")],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
        first_scan_response=fs(156,"fs.scan",{"path":"scan-root","limit":2,"maxDepth":8})
        assert "result" in first_scan_response,first_scan_response
        first_scan=first_scan_response["result"]
        assert first_scan=={"entries":[{"path":"a.txt","type":"file","size":1},{"path":"nested","type":"directory","size":0}],"nextCursor":2,"truncated":False},first_scan
        second_scan=fs(157,"fs.scan",{"path":"scan-root","cursor":first_scan["nextCursor"],"limit":2,"maxDepth":8})["result"]
        assert second_scan=={"entries":[{"path":"nested/b.txt","type":"file","size":1}],"truncated":False},second_scan
        shallow_scan=fs(158,"fs.scan",{"path":"scan-root","maxDepth":0})["result"]
        assert [entry["path"] for entry in shallow_scan["entries"]]==["a.txt","nested"] and shallow_scan["truncated"] is True,shallow_scan
        assert fs(159,"fs.scan",{"path":"scan-root","limit":257})["error"]["code"]==-32602
        assert fs(160,"fs.scan",{"path":"scan-root","unexpected":True})["error"]["code"]==-32602
        assert fs(161,"fs.write",{"path":"watch-root/.keep","content":"keep","createDirs":True})["result"]["ok"]
        watch=fs(162,"fs.watch",{"path":"watch-root"})["result"]["watchId"]
        assert isinstance(watch,int) and watch>0
        assert fs(163,"fs.write",{"path":"watch-root/observed.txt","content":"observed"})["result"]["ok"]
        watched=[]
        for _ in range(10):
            watched.extend(fs(164,"fs.watch.poll",{"watchId":watch,"limit":128})["result"]["events"])
            if watched: break
            time.sleep(0.05)
        assert watched,watched
        assert fs(165,"fs.watch.cancel",{"watchId":watch})["result"]=={"ok":True}
        assert fs(166,"fs.watch.poll",{"watchId":watch})["error"]["code"]==-32003
        if os.name!="nt":
            # Burst folding: many changes in one watched directory between
            # polls collapse into a single directory-level "changed" event.
            # (Windows reports a single root-level changed event by design.)
            burst=fs(190,"fs.watch",{"path":"watch-root"})["result"]["watchId"]
            for n in range(6):
                assert fs(191,"fs.write",{"path":f"watch-root/burst-{n}.txt","content":str(n)})["result"]["ok"]
            folded=[]
            for _ in range(20):
                folded.extend(fs(192,"fs.watch.poll",{"watchId":burst,"limit":128})["result"]["events"])
                if folded: break
                time.sleep(0.05)
            assert folded==[{"path":"","kind":"changed"}],folded
            assert fs(193,"fs.watch.cancel",{"watchId":burst})["result"]=={"ok":True}
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
        # A configured cwd must not gain the mounted-folder exception merely by
        # being a directory junction.  This needs no elevated VHD creation.
        if os.name == "nt":
            linked_root=root/"root-junction"
            if directory_junction(linked_root, outside):
                assert send(p,144,"session.configure",{"sessionId":"root-junction-session","cwd":str(linked_root),"sandbox":{"enabled":True,"readRoots":[str(linked_root)],"writeRoots":[str(linked_root)],"denyPaths":[],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
                root_escape=send(p,145,"fs.write",{"sessionId":"root-junction-session","path":"must-not-write.txt","content":"no"})
                assert root_escape.get("error",{}).get("code")==-32002,root_escape
                assert not (pathlib.Path(outside)/"must-not-write.txt").exists()
            # A junction directly to the volume root also is not a mounted
            # folder.  Stat only: a broken implementation must not write C:\\.
            volume_root_link=root/"root-volume-junction"
            if directory_junction(volume_root_link, pathlib.Path(root.anchor)):
                assert send(p,146,"session.configure",{"sessionId":"root-volume-junction-session","cwd":str(volume_root_link),"sandbox":{"enabled":True,"readRoots":[str(volume_root_link)],"writeRoots":[str(volume_root_link)],"denyPaths":[],"network":"allow"}})["result"]["sandboxCapability"] in {"advisory","partial","enforced"}
                root_volume_escape=send(p,147,"fs.stat",{"sessionId":"root-volume-junction-session","path":"."})
                assert root_volume_escape.get("error",{}).get("code")==-32002,root_volume_escape
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
        # A directory that cannot be listed (for example System Volume
        # Information on a mounted volume) must not abort glob/grep/scan of
        # the surrounding workspace.
        restricted=root/"restricted"
        restricted.mkdir()
        (restricted/"secret.txt").write_text("secret")
        restricted_glob=fs(170,"fs.glob",{"path":".","pattern":"*/secret.txt"})
        if os.name == "nt":
            subprocess.run(["icacls",str(restricted),"/deny","%USERNAME%:(RD)"],capture_output=True)
        assert fs(171,"fs.glob",{"path":".","pattern":"*"})["result"]["truncated"] is False
        assert fs(172,"fs.scan",{"path":"."})["result"]["truncated"] is False
        assert fs(173,"fs.grep",{"path":".","pattern":"secret"})["result"]["truncated"] is False
        if os.name == "nt":
            subprocess.run(["icacls",str(restricted),"/remove:d","%USERNAME%"],capture_output=True)
        restored_glob=fs(174,"fs.glob",{"path":".","pattern":"*/secret.txt"})["result"]
        assert "restricted/secret.txt" in restored_glob["paths"],restored_glob
        for i in range(20): assert fs(20+i,"fs.write",{"path":"repeat","content":str(i)})["result"]["ok"]
        assert not list(root.glob("*.tmp")) and not list(root.glob(".*.tmp"))
        (pathlib.Path(outside)/"secret").write_text("secret")
        link=root/"escape"
        linked=directory_link(link, outside)
        if linked:
            assert fs(50,"fs.read",{"path":"escape/secret","offset":0,"limit":1})["error"]["code"]==-32002
            escaped_write=fs(51,"fs.write",{"path":"escape/new","content":"no"})
            assert escaped_write.get("error",{}).get("code")==-32002,escaped_write
        assert send(p,99,"core.shutdown",{})["result"]["ok"]
    assert p.wait()==0
    atexit.unregister(cleanup_process)
if __name__=="__main__":main()
