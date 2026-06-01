import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// 按 requestId 暂存 token 用量
const usageStore = new Map<string, Record<string, number>>();

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
  const { messages } = await req.json();
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();

  const formattedMessages = messages.map(
    (msg: { role: string; parts?: Array<{ type: string; text: string }> }) => ({
      role: msg.role,
      content:
        msg.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") || "",
    }),
  );

  const result = streamText({
    model: openai.chat(process.env.OPENAI_MODEL || "gpt-4o-mini"),
    system: `你是 DevPilot，一个专业的开发运维 AI 助手。
你的职责：
- 帮助开发者解答技术问题
- 协助排查线上问题
- 提供代码审查建议
- 解释错误日志和监控指标

回答风格：简洁专业，给出可执行的建议，必要时提供代码示例。`,
    messages: formattedMessages,
    onFinish: ({ usage }) => {
      usageStore.set(requestId, {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    },
  });

  return result.toUIMessageStreamResponse();
}

// 按 requestId 查询单次对话的 token 用量
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const requestId = searchParams.get("id");

  if (!requestId) {
    return Response.json(null);
  }

  const usage = usageStore.get(requestId);
  if (usage) {
    usageStore.delete(requestId);
  }
  return Response.json(usage || null);
}
