import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// 创建 OpenAI 兼容的 provider 实例
// 用自定义 fetch 去掉第三方 API 不支持的 OpenAI 专属参数
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  fetch: async (url, options) => {
    if (options?.body) {
      const body = JSON.parse(options.body as string);
      // 删除第三方兼容 API 通常不支持的 OpenAI 专属字段
      delete body.service_tier;
      delete body.store;
      delete body.parallel_tool_calls;
      delete body.stream_options;
      options.body = JSON.stringify(body);
    }
    return fetch(url, options);
  },
});

export async function POST(req: Request) {
  // 从前端请求体中提取消息历史
  const { messages } = await req.json();

  // streamText：调用 LLM 并返回流式响应
  const result = streamText({
    // 用 .chat() 显式走 chat/completions 接口，避免走 responses API
    model: openai.chat(process.env.OPENAI_MODEL || "gpt-4o-mini"),
    // system prompt 定义 AI 的角色和行为
    system: `你是 DevPilot，一个专业的开发运维 AI 助手。
你的职责：
- 帮助开发者解答技术问题
- 协助排查线上问题
- 提供代码审查建议
- 解释错误日志和监控指标

回答风格：简洁专业，给出可执行的建议，必要时提供代码示例。`,
    messages,
  });

  // 将流式结果转为前端 useChat 能解析的响应格式
  return result.toUIMessageStreamResponse();
}
