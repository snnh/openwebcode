/**
 * 跨层契约一致性检查（类型级，编译期校验）：
 * `import type` 服务端真值类型，断言与 web 端契约的结构兼容性，防止
 * server 演进后 web 契约再次窄化。运行时无操作（全部为类型断言），
 * 由 `tsc --noEmit` 承担实际校验。
 *
 * 方向约定：
 * - 输出（server → web，如 PersonaDetail）：`ServerType extends WebType`
 * - 输入（web → server，如 PersonaPresetInput）：`WebType extends ServerType`
 * 方向写反会把「web 过窄」误判为通过。
 */
import type { PersonaAlias as ServerPersonaAlias, PersonaDetail as ServerPersonaDetail, PersonaPreset as ServerPersonaPreset } from "../../server/src/extensions/env-sim/types.js";
import type { ExtensionPermission as ServerExtensionPermission } from "../../server/src/extensions/types.js";
import type { PersonaAlias, PersonaDetail, PersonaPresetInput } from "../../web/src/lib/contracts/session";
import type { ExtensionPermission } from "../../web/src/lib/contracts/extension";

type Expect<T extends true> = T;

// ── env-sim：输出方向（server 详情可展示为 web 详情） ──
type _personaDetail = Expect<ServerPersonaDetail extends PersonaDetail ? true : false>;
// ── env-sim：输入方向（web 提交体字段集 ⊂ 服务端模型字段，类型兼容；端点接受松散 body，运行时宽松解析） ──
type _personaInput = Expect<PersonaPresetInput extends Partial<ServerPersonaPreset> ? true : false>;
// ── env-sim：别名双向一致（web 表单透传 aliases，json 文本框直接使用） ──
type _alias_out = Expect<ServerPersonaAlias extends PersonaAlias ? true : false>;
type _alias_in = Expect<PersonaAlias extends ServerPersonaAlias ? true : false>;

// ── extension：输出方向（server 权限联合是 web 联合的子集） ──
type _permission = Expect<ServerExtensionPermission extends ExtensionPermission ? true : false>;

// ── scm 写操作返回（服务端 service.ts stage/unstage/discard 均返回 Promise<{ok:true}>） ──
import type { ScmService } from "../../server/src/scm/service.js";
type _scm_stage = Expect<Awaited<ReturnType<ScmService["stage"]>> extends { ok: true } ? true : false>;
type _scm_unstage = Expect<Awaited<ReturnType<ScmService["unstage"]>> extends { ok: true } ? true : false>;
type _scm_discard = Expect<Awaited<ReturnType<ScmService["discard"]>> extends { ok: true } ? true : false>;

// 校验入口：tsc 通过即所有断言成立；运行时仅占位（web 契约来自类型层，无需执行）。
export const contractsCheck = true;
