import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../src/agent/readonly-command.js";

describe("isReadOnlyCommand", () => {
  it("放行纯只读单命令与常见探查形态", () => {
    expect(isReadOnlyCommand("ls")).toBe(true);
    expect(isReadOnlyCommand("head -80 file.txt")).toBe(true);
    expect(isReadOnlyCommand("cat package.json")).toBe(true);
    expect(isReadOnlyCommand("grep -rn \"foo\" src/")).toBe(true);
    expect(isReadOnlyCommand("git status")).toBe(true);
    expect(isReadOnlyCommand("git log --oneline -5")).toBe(true);
    expect(isReadOnlyCommand("git diff HEAD~1")).toBe(true);
    expect(isReadOnlyCommand("git rev-parse --abbrev-ref HEAD")).toBe(true);
    expect(isReadOnlyCommand("find . -name \"*.ts\" -not -path \"*/node_modules/*\" | head -10")).toBe(true);
    expect(isReadOnlyCommand("echo \"a>b\"")).toBe(true); // 引号内的 > 不是重定向
    expect(isReadOnlyCommand("echo 'a;b && c'")).toBe(true); // 引号内的分隔符不切段
    expect(isReadOnlyCommand("cd /x && echo hi && ls")).toBe(true);
    expect(isReadOnlyCommand("cd /x; ls; echo done")).toBe(true);
    expect(isReadOnlyCommand("ls server/test 2>/dev/null | head")).toBe(true);
    expect(isReadOnlyCommand("ls >/dev/null && echo ok")).toBe(true);
    expect(isReadOnlyCommand("  ls   ")).toBe(true);
    expect(isReadOnlyCommand("true")).toBe(true);
  });

  it("放行用户报告的典型复合探查命令", () => {
    const cmd = "cd /share/work/openwebcode && echo \"=== release.yml ===\" && head -80 .github/workflows/release.yml && echo \"=== server test files ===\" && ls server/test 2>/dev/null | head; find server -maxdepth 3 -name \"*.test.ts\" -not -path \"*/node_modules/*\" | head -10 && echo \"=== web test files ===\" && find web/src -name \"*.test.ts*\" -not -path \"*/node_modules/*\" | head -10 && echo \"=== server vitest config ===\" && ls server/vitest.config.ts server/vitest.config.mts 2>/dev/null";
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });

  it("拒绝写重定向与非 /dev/null 目标", () => {
    expect(isReadOnlyCommand("echo x > file")).toBe(false);
    expect(isReadOnlyCommand("echo x >> file")).toBe(false);
    expect(isReadOnlyCommand("echo x > /tmp/f")).toBe(false);
    expect(isReadOnlyCommand("echo x 2> err.txt")).toBe(false);
    expect(isReadOnlyCommand("echo x 2>&1")).toBe(false);
    expect(isReadOnlyCommand("echo x &> file")).toBe(false);
    expect(isReadOnlyCommand("head x 3> f")).toBe(false);
    expect(isReadOnlyCommand("cat < file")).toBe(false);
    expect(isReadOnlyCommand("cat << EOF")).toBe(false);
    expect(isReadOnlyCommand("echo x >/dev/nullx")).toBe(false); // 词边界不符
  });

  it("拒绝命令替换与任意命令执行形态", () => {
    expect(isReadOnlyCommand("echo $(rm -rf /)")).toBe(false);
    expect(isReadOnlyCommand("echo `rm -rf /`")).toBe(false);
    expect(isReadOnlyCommand("echo \"$(whoami)\"")).toBe(false); // 双引号内仍执行
    expect(isReadOnlyCommand("echo '$(rm -rf /)'")).toBe(true); // 单引号内不执行
    expect(isReadOnlyCommand("head x && rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("head x || touch y")).toBe(false);
    expect(isReadOnlyCommand("head x & rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("env rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("command rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("awk 'BEGIN{system(\"rm -rf /\")}'")).toBe(false);
    expect(isReadOnlyCommand("xargs rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("sudo ls")).toBe(false);
    expect(isReadOnlyCommand("nohup ls &")).toBe(false);
    expect(isReadOnlyCommand("npm test")).toBe(false);
    expect(isReadOnlyCommand("node -e \"process.exit()\"")).toBe(false);
  });

  it("拒绝白名单命令的写形态", () => {
    expect(isReadOnlyCommand("find . -exec rm {} \\;")).toBe(false);
    expect(isReadOnlyCommand("find . -delete")).toBe(false);
    expect(isReadOnlyCommand("sed -i s/a/b/ f")).toBe(false);
    expect(isReadOnlyCommand("sed --in-place s/a/b/ f")).toBe(false);
    expect(isReadOnlyCommand("sed -i.bak s/a/b/ f")).toBe(false);
    expect(isReadOnlyCommand("sed s/a/b/ f")).toBe(true);
    expect(isReadOnlyCommand("sort -o out f")).toBe(false);
    expect(isReadOnlyCommand("sort f")).toBe(true);
    expect(isReadOnlyCommand("date -s 2026-01-01")).toBe(false);
    expect(isReadOnlyCommand("date")).toBe(true);
  });

  it("拒绝 git 写子命令与选项形态", () => {
    expect(isReadOnlyCommand("git push")).toBe(false);
    expect(isReadOnlyCommand("git commit -m x")).toBe(false);
    expect(isReadOnlyCommand("git checkout main")).toBe(false);
    expect(isReadOnlyCommand("git reset --hard")).toBe(false);
    expect(isReadOnlyCommand("git config user.name x")).toBe(false);
    expect(isReadOnlyCommand("git -C /x status")).toBe(false);
    expect(isReadOnlyCommand("git")).toBe(false);
    expect(isReadOnlyCommand("git status --porcelain")).toBe(true);
  });

  it("拒绝路径形式与环境变量赋值前缀", () => {
    expect(isReadOnlyCommand("./script.sh")).toBe(false);
    expect(isReadOnlyCommand("/usr/bin/ls")).toBe(false);
    expect(isReadOnlyCommand("FOO=bar ls")).toBe(false);
    expect(isReadOnlyCommand("ls /tmp")).toBe(true);
  });
});
