/**
 * 聊天动作桥：命令体系（app/commands）触发「发送消息」时，经此桥路由到
 * ChatView 的 submitDraft（含 `!` shell 路由、/help 语义与编辑重发分支）。
 * ChatView 挂载时注册，卸载时清除；桥未挂时 sendDraft 命令的 when
 * （draftNonEmpty）自然不满足，安全 no-op。
 */
export const chatBridge: { submitDraft?: (behavior?: "start" | "steer" | "follow_up") => void } = {};
