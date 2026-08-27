#!/usr/bin/env python3
import atexit, base64, ctypes, faulthandler, hashlib, json, os, pathlib, queue, subprocess, sys, tempfile, threading, time

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
    def read_frame():
        headers={}
        while True:
            line=p.stdout.readline(); assert line
            if line==b"\r\n": break
            k,v=line.decode().split(":",1);headers[k.lower()]=v.strip()
        return json.loads(p.stdout.read(int(headers["content-length"])))
    box=queue.Queue()
    worker=threading.Thread(target=lambda: box.put(read_frame()), daemon=True)
    worker.start()
    try:
        msg=box.get(timeout=5)
    except queue.Empty:
        raise AssertionError(f"id {i} {method}: response timed out (挂起点) — faulthandler 已 dump 栈")
    try:
        _=msg["jsonrpc"]
    except (TypeError, KeyError):
        raise AssertionError(f"id {i} {method}: malformed response {msg!r}")
    if msg.get("id")==i or (msg.get("id") is None and msg.get("error",{}).get("code")==-32700):return msg
    return send(p, i, method, params)

MAX_BINARY = 20 * 1024 * 1024

# --- absolute-path policy suite (absorbed from test_abs_path.py) ---
# Verify session_policy_path: absolute paths inside roots allowed, outside denied.
CORE = sys.argv[1] if len(sys.argv) > 1 else r"D:\dev\openwebcode\build\Debug\owc-exec.exe"


def abspath_send(proc, message):
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    proc.stdin.flush()


def abspath_receive(proc):
    headers = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError("owc-exec closed stdout")
        if line == b"\r\n":
            break
        name, value = line.decode("ascii").split(":", 1)
        headers[name.lower()] = value.strip()
    return json.loads(proc.stdout.read(int(headers["content-length"])))


def abspath_rpc(proc, request_id, method, params=None):
    abspath_send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
    while True:
        message = abspath_receive(proc)
        if message.get("id") == request_id:
            return message


def main_fs():
    faulthandler.dump_traceback_later(10, repeat=True)  # 挂起时每 10s dump 栈到 stderr，定位挂点
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
        # A matched line's text is capped at 512 bytes (same limit as the
        # grep job) so one huge line cannot overflow the 32 MiB frame.  The
        # match itself is still found beyond the cap; only the stored text
        # is truncated.
        long_line="x"*600+"needle"+"y"*600
        assert fs(175,"fs.write",{"path":"long-line.txt","content":long_line})["result"]["ok"]
        long_matches=fs(176,"fs.grep",{"path":"long-line.txt","pattern":"needle"})["result"]
        assert long_matches["truncated"] is False and len(long_matches["matches"])==1,long_matches
        long_text=long_matches["matches"][0]["text"]
        assert len(long_text)<=512 and "needle" not in long_text,long_matches
        head_matches=fs(177,"fs.grep",{"path":"long-line.txt","pattern":"xxx"})["result"]
        assert len(head_matches["matches"])==1 and head_matches["matches"][0]["text"]=="x"*512,head_matches
        # Truncation must not split a UTF-8 multi-byte sequence: a line of CJK
        # characters (3 bytes each) longer than 512 bytes must yield valid UTF-8
        # text at or under 512 bytes -- the cut backs off to a character boundary.
        cjk_line="\u4e2d"*200+"needle"+"\u4e2d"*200  # 400*3=1200 bytes + "needle"
        assert fs(178,"fs.write",{"path":"cjk-line.txt","content":cjk_line})["result"]["ok"]
        cjk_matches=fs(179,"fs.grep",{"path":"cjk-line.txt","pattern":"needle"})["result"]
        assert len(cjk_matches["matches"])==1,cjk_matches
        cjk_text=cjk_matches["matches"][0]["text"]
        assert len(cjk_text)<=512,cjk_matches
        cjk_text.encode("utf-8")  # raises UnicodeDecodeError if a sequence was split
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
        # Empty page (cursor at the end of the collection, or an empty
        # directory): the closing suffix must be appended after growing the
        # buffer, otherwise the header-only allocation overflows.
        empty_page=fs(199,"fs.scan",{"path":"scan-root","cursor":3,"maxDepth":8})["result"]
        assert empty_page=={"entries":[],"truncated":False},empty_page
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
        # Burst folding: many changes in one watched directory between
        # polls collapse into a single directory-level "changed" event.
        # (Windows ReadDirectoryChangesW may split a burst across batches,
        # so keep polling until a folded batch appears.)
        burst=fs(190,"fs.watch",{"path":"watch-root"})["result"]["watchId"]
        for n in range(6):
            assert fs(191,"fs.write",{"path":f"watch-root/burst-{n}.txt","content":str(n)})["result"]["ok"]
        folded=None
        for _ in range(20):
            events=fs(192,"fs.watch.poll",{"watchId":burst,"limit":128})["result"]["events"]
            if events==[{"path":"","kind":"changed"}]:
                folded=events
                break
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

def main_read_base64():
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

def main_abs_path():
    workspace = tempfile.mkdtemp(prefix="owc-abspath-ws-")
    outside = tempfile.mkdtemp(prefix="owc-abspath-out-")
    with open(os.path.join(workspace, "hello.txt"), "w", encoding="utf-8") as f:
        f.write("hello\n")
    with open(os.path.join(outside, "secret.txt"), "w", encoding="utf-8") as f:
        f.write("secret\n")

    proc = subprocess.Popen([CORE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    rid = 0

    def call(method, params):
        nonlocal rid
        rid += 1
        return abspath_rpc(proc, rid, method, params)

    r = call("session.configure", {"sessionId": "abs", "cwd": workspace,
                                   "sandbox": {"enabled": False}})
    assert "result" in r, r

    def expect_ok(label, method, params):
        r = call(method, params)
        assert "result" in r, f"{label}: expected result, got {r}"
        print(f"OK   {label}")

    def expect_denied(label, method, params):
        r = call(method, params)
        assert "error" in r and r["error"]["code"] == -32002, f"{label}: expected -32002, got {r}"
        print(f"DENY {label}")

    ws_abs = os.path.join(workspace, "hello.txt")
    out_abs = os.path.join(outside, "secret.txt")

    # relative baseline
    expect_ok("relative read", "fs.read", {"sessionId": "abs", "path": "hello.txt"})
    # absolute inside workspace (native form with backslashes on Windows)
    expect_ok("absolute read inside", "fs.read", {"sessionId": "abs", "path": ws_abs})
    # absolute with forward slashes
    expect_ok("absolute read inside (fwd)", "fs.read",
              {"sessionId": "abs", "path": ws_abs.replace(os.sep, "/")})
    # absolute with dot components inside workspace
    expect_ok("absolute read with /./", "fs.read",
              {"sessionId": "abs", "path": os.path.join(workspace, ".", "hello.txt")})
    # absolute with /../ inside: core canonicalizes in C (model need not care)
    expect_ok("absolute read with /../ inside", "fs.read",
              {"sessionId": "abs", "path": os.path.join(workspace, "sub", "..", "hello.txt")})
    # glob/list/stat/hash on absolute inside
    expect_ok("absolute glob inside", "fs.glob",
              {"sessionId": "abs", "path": workspace, "pattern": "*.txt"})
    expect_ok("absolute stat inside", "fs.stat", {"sessionId": "abs", "path": ws_abs})
    # absolute outside workspace -> denied
    expect_denied("absolute read outside", "fs.read", {"sessionId": "abs", "path": out_abs})
    # absolute with /../ escaping workspace -> denied
    expect_denied("absolute read /../ escape", "fs.read",
                  {"sessionId": "abs", "path": os.path.join(workspace, "..", os.path.basename(outside), "secret.txt")})
    # relative with .. still denied
    expect_denied("relative .. read", "fs.read", {"sessionId": "abs", "path": "../x.txt"})
    # absolute write inside workspace allowed; outside denied
    expect_ok("absolute write inside", "fs.write",
              {"sessionId": "abs", "path": os.path.join(workspace, "new.txt"), "content": "x"})
    expect_denied("absolute write outside", "fs.write",
                  {"sessionId": "abs", "path": os.path.join(outside, "new.txt"), "content": "x"})
    # UNC rejected (cannot be inside roots anyway)
    expect_denied("UNC read", "fs.read", {"sessionId": "abs", "path": "\\\\server\\share\\x"})

    # path.normalize: canonical form + policy verdict (no IO)
    def norm_seps(p):
        return p.replace("\\", "/").lower()

    r = call("path.normalize", {"sessionId": "abs", "path": "hello.txt"})
    assert "result" in r and r["result"]["allowed"] is True, r
    assert norm_seps(r["result"]["path"]) == norm_seps(ws_abs), r
    assert norm_seps(r["result"]["root"]) == norm_seps(workspace), r
    print("OK   normalize relative")

    r = call("path.normalize", {"sessionId": "abs",
                                "path": os.path.join(workspace, "sub", "..", "hello.txt")})
    assert "result" in r and r["result"]["allowed"] is True, r
    assert norm_seps(r["result"]["path"]) == norm_seps(ws_abs), r
    print("OK   normalize absolute with /../ inside")

    r = call("path.normalize", {"sessionId": "abs", "path": out_abs})
    assert "result" in r and r["result"]["allowed"] is False and "reason" in r["result"], r
    assert norm_seps(r["result"]["path"]) == norm_seps(out_abs), r
    print("OK   normalize outside -> allowed=false with canonical path")

    # purpose=write vs read: writeRoots narrower than readRoots
    subdir = os.path.join(workspace, "wr")
    os.makedirs(subdir, exist_ok=True)
    r = call("session.configure", {"sessionId": "abs2", "cwd": workspace,
                                   "sandbox": {"enabled": False,
                                               "readRoots": [workspace],
                                               "writeRoots": [subdir]}})
    assert "result" in r, r
    r = call("path.normalize", {"sessionId": "abs2", "path": "hello.txt", "purpose": "read"})
    assert "result" in r and r["result"]["allowed"] is True, r
    print("OK   normalize purpose=read allowed under readRoots")
    r = call("path.normalize", {"sessionId": "abs2", "path": "hello.txt", "purpose": "write"})
    assert "result" in r and r["result"]["allowed"] is False, r
    print("OK   normalize purpose=write denied outside writeRoots")
    r = call("path.normalize", {"sessionId": "abs2", "path": os.path.join("wr", "x.txt"), "purpose": "write"})
    assert "result" in r and r["result"]["allowed"] is True, r
    print("OK   normalize purpose=write allowed inside writeRoots")

    # unnormalizable / invalid forms -> -32602
    def expect_invalid(label, params):
        r = call("path.normalize", params)
        assert "error" in r and r["error"]["code"] == -32602, f"{label}: expected -32602, got {r}"
        print(f"DENY {label}")

    expect_invalid("normalize relative ..", {"sessionId": "abs", "path": "../x.txt"})
    expect_invalid("normalize UNC", {"sessionId": "abs", "path": "\\\\server\\share\\x"})
    expect_invalid("normalize bad purpose", {"sessionId": "abs", "path": "hello.txt", "purpose": "execute"})
    expect_invalid("normalize unknown field", {"sessionId": "abs", "path": "hello.txt", "extra": 1})
    expect_invalid("normalize unknown session", {"sessionId": "nope", "path": "hello.txt"})

    # core.ping advertises the capability
    r = call("core.ping", {})
    assert r["result"]["features"]["pathNormalize"] is True, r
    print("OK   core.ping features.pathNormalize")

    call("session.cleanup", {"sessionId": "abs2"})
    call("session.cleanup", {"sessionId": "abs"})
    proc.stdin.close()
    rc = proc.wait(timeout=10)
    assert rc == 0, f"core exited with {rc}"
    print("PASS: absolute path policy behaves correctly")

def main():
    main_fs()
    main_read_base64()
    main_abs_path()

if __name__=="__main__":main()
