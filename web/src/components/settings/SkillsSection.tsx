import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";

export function SkillsSection(): ReactElement {
  const { t } = useI18n();
  const skills = useQuery({ queryKey: ["global-skills"], queryFn: api.globalSkills });
  if (skills.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (skills.isError) return <p className="panel-empty">{t("无法加载技能清单。", "Could not load skills.")}</p>;
  return (
    <>
      <p className="settings-note">{t(
        "全局技能放在数据目录 skills/<名称>/SKILL.md，项目技能放在 <工作目录>/.owc/skills/ 下；对话中输入 / 可呼出技能补全，模型也可经 load_skill 工具按需加载。",
        "Place global skills in skills/<name>/SKILL.md under the data directory, and project skills in <workspace>/.owc/skills/. Type / in chat for completion; models can also load them with load_skill.",
      )}</p>
      {skills.data.skills.length === 0 ? (
        <p className="panel-empty">{t("还没有全局技能。", "No global skills installed.")}</p>
      ) : (
        <table className="pricing-table catalog-table">
          <thead>
            <tr><th>{t("名称", "Name")}</th><th>{t("描述", "Description")}</th><th>{t("路径", "Path")}</th></tr>
          </thead>
          <tbody>
            {skills.data.skills.map((skill) => (
              <tr key={skill.name}>
                <td className="mono">/{skill.name}</td>
                <td>{skill.description}</td>
                <td className="mono">{skill.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
