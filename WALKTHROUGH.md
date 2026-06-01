# DevPilot 代码拆解文档

> 逐文件解读，帮你理解每一行代码在干什么、为什么这么写。

---

## 全局视角：数据流

先看整体，再看细节。一次对话的数据流：

```
用户输入 "怎么优化慢SQL"
       ↓
Chat.tsx → sendMessage({ text: "..." })
       ↓
POST /api/chat  ← 请求头带 x-request-id（UUID），携带完整消息历史
       ↓
route.ts → streamText({ model, system, messages })
       ↓
OpenAI API ← 实际调用 LLM
       ↓
流式返回 token → onFinish 回调捕获 usage → 存入 Map[requestId]
       ↓
toUIMessageStreamResponse() → useChat 解析流 → 更新 messages
       ↓
status 变为 ready → 前端轮询 GET /api/chat?id=<requestId> → 拿到 usage
       ↓
React 渲染 → 消息下方显示单次 token 用量，右上角累计总量
```

**关键认知**：前端不直接调 LLM，而是通过自己的后端（route.ts）中转。这样 API Key 不暴露给浏览器。

---

## 文件 1：`.env.local` — 环境变量

```
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

### 逐行解释

| 变量 | 作用 | 你该知道的 |
|------|------|-----------|
| `OPENAI_API_KEY` | API 密钥 | 绝对不能提交到 git，.env.local 已被 gitignore |
| `OPENAI_BASE_URL` | API 地址 | 改成 `https://api.deepseek.com` 就能用 DeepSeek |
| `OPENAI_MODEL` | 模型名 | `gpt-4o-mini` 便宜够用，换 `gpt-4o` 更强但贵 10 倍 |

### 为什么叫 "OpenAI 兼容"？

DeepSeek、通义千问、Moonshot 等国产模型都实现了 OpenAI 的 API 格式，所以只要换 `BASE_URL` 和 `API_KEY` 就能切换模型，代码不用改。

### 动手实验

```bash
# 用 curl 直接调一次，理解最底层的请求格式
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "你是助手"},
      {"role": "user", "content": "你好"}
    ]
  }'
```

请求体核心字段：
- `model`：用哪个模型
- `messages`：对话历史数组，每条有 `role`（system/user/assistant）和 `content`
- `stream`：true/false，是否流式返回（后面会用到）

---

## 文件 2：`src/app/api/chat/route.ts` — 后端接口

这是整个应用的核心枢纽。

```ts
import { streamText } from "ai";              // ①
import { createOpenAI } from "@ai-sdk/openai"; // ②

// ⑩ 按 requestId 暂存 token 用量，供 GET 请求读取
const usageStore = new Map<string, Record<string, number>>();

const openai = createOpenAI({                   // ③
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  fetch: async (url, options) => {              // ③-b
    if (options?.body) {
      const body = JSON.parse(options.body as string);
      delete body.service_tier;
      delete body.store;
      delete body.parallel_tool_calls;
      delete body.stream_options;
      options.body = JSON.stringify(body);
    }
    return fetch(url, options);
  },
});

export async function POST(req: Request) {      // ④
  const { messages } = await req.json();        // ⑤
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID(); // ⑪

  // ⑤-b 格式转换：useChat 发来的消息是 parts 格式，streamText 需要 role/content 格式
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

  const result = streamText({                   // ⑥
    model: openai.chat(process.env.OPENAI_MODEL || "gpt-4o-mini"),  // ⑥-b
    system: `你是 DevPilot...`,                  // ⑦
    messages: formattedMessages,                // ⑧ 用转换后的消息
    onFinish: ({ usage }) => {                  // ⑫
      usageStore.set(requestId, {               // 流结束后把 usage 存起来
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    },
  });

  return result.toUIMessageStreamResponse();    // ⑨
}

// ⑬ GET /api/chat?id=xxx → 返回指定请求的 token 用量
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const requestId = searchParams.get("id");
  if (!requestId) return Response.json(null);

  const usage = usageStore.get(requestId);
  if (usage) usageStore.delete(requestId);      // 读后即删，避免内存泄漏
  return Response.json(usage || null);
}
```

> **踩坑记录**：AI SDK 新版默认用 `openai(model)` 会走 OpenAI 的 `responses` API（新接口），
> 但大部分第三方兼容 API（DeepSeek、小米 MiMo 等）只支持 `chat/completions` 旧接口。
> 必须用 `openai.chat(model)` 显式指定走 chat completions。
> 同时，AI SDK 会附带 `service_tier`、`store` 等 OpenAI 专属参数，第三方 API 不认识会报 404，
> 所以用自定义 `fetch` 在请求发出去前把这些字段删掉。

### 逐行拆解

**① `streamText` 来自 `ai` 包（Vercel AI SDK）**

它是对 LLM API 调用的封装。你也可以用 `fetch` 直接调 OpenAI API，但 `streamText` 帮你处理了：
- 流式响应的解析
- 错误重试
- Token 计数
- 多 provider 兼容

**② `createOpenAI` 是 provider 工厂函数**

AI SDK 的设计是：每种模型提供商（OpenAI、Anthropic、Google）有自己的 provider，但调用方式统一。

**③ 创建 provider 实例**

```ts
const openai = createOpenAI({
  apiKey: "...",    // 你的密钥
  baseURL: "...",   // API 地址（换 DeepSeek 就改这里）
  fetch: ...,       // 自定义 fetch，去掉第三方 API 不支持的参数
});
```

这个 `openai` 是一个工厂，调用 `openai.chat("gpt-4o-mini")` 会返回一个具体的模型实例。

**③-b 自定义 fetch 的作用**

AI SDK 默认发请求时会带 `service_tier`、`store`、`parallel_tool_calls` 等 OpenAI 专属参数。
第三方兼容 API 不认识这些字段，会直接返回 404。
自定义 fetch 在请求发出前把这些字段从 body 里删掉，确保兼容性。

**④ `export async function POST`**

Next.js App Router 的约定：`route.ts` 里导出的 `POST` 函数就是 POST 请求的处理函数。同理可以导出 `GET`、`PUT`、`DELETE`。

**⑤ `await req.json()`**

解析请求体。前端发来的 JSON 被解析成对象，提取消息历史。

**⑤-b 消息格式转换**

`useChat` 新版发来的消息格式是 `parts` 结构：
```ts
{ role: "user", parts: [{ type: "text", text: "你好" }] }
```

但 `streamText` 期望的是传统的 `role/content` 格式：
```ts
{ role: "user", content: "你好" }
```

所以需要做一次 map 转换。这也是你在 Chat.tsx 里加 `JSON.stringify(messages)` 调试后发现的——直接把 parts 格式丢给 streamText 会拿到空回复。

**⑥ `streamText({ model, messages })`**

核心调用。它做了这些事：
1. 把 messages 数组发给 OpenAI API
2. 开启流式接收（SSE）
3. 返回一个 `result` 对象，包含流式数据

**⑦ `system` prompt**

系统提示词，定义 AI 的角色。用户看不到这条消息，但它影响 AI 的所有回答。这是 Agent 开发中最基础也最重要的概念之一。

**⑧ `messages`**

前端传来的完整对话历史。每轮对话都会把之前所有消息带上，这样 AI 才有"记忆"。

**⑨ `toUIMessageStreamResponse()`**

把流式结果转成前端 `useChat` hook 能解析的特定格式。这个格式包含了：
- 文本 token（逐步输出）
- 元数据（finish reason、usage 等）

**⑩ `usageStore` — 内存级 token 用量存储**

用一个 Map 按 `requestId` 存每次对话的 token 用量。简单但有限制：
- 服务重启就清空（生产环境应该存数据库）
- 只存最后一次请求的值也没问题，因为前端是按 requestId 精确查询的

**⑪ `x-request-id` 请求头**

前端在发送消息时自动生成 UUID，通过请求头传给后端。后端用这个 ID 把 usage 存到 Map 里，前端再用同一个 ID 来查询。这样就把"一次请求"和"它的 token 用量"关联起来了。

**⑫ `onFinish` 回调**

`streamText` 的生命周期钩子，流式输出全部完成后触发。参数 `usage` 包含：
- `inputTokens`：输入 token 数（系统提示词 + 对话历史 + 用户当前消息）
- `outputTokens`：输出 token 数（AI 回复的长度）

**⑬ `GET` 处理器 — 查询 token 用量**

同一个 `route.ts` 文件可以同时导出 `POST` 和 `GET`。前端轮询 `GET /api/chat?id=xxx`，拿到 usage 后从 Map 里删除（读后即删，避免内存泄漏）。

### 动手实验

1. 在 `system` 里加一句"回答必须用文言文"，观察 AI 回答风格的变化
2. 把 `mimo-v2.5-pro` 换成 `mimo-v2.5`，对比响应速度和 token 用量
3. 试试去掉 `formattedMessages` 转换，直接把 `messages` 传给 `streamText`，观察会发生什么（空回复或报错）
4. 试试把 `openai.chat()` 改回 `openai()`，看报错信息，理解两种 API 的区别
5. 在 `onFinish` 里加 `console.log("Token 用量:", usage)`，观察每次对话消耗了多少 token

---

## 文件 3：`src/components/Chat.tsx` — 前端 UI

这是用户直接交互的组件，70 行左右。

```tsx
"use client";                                          // ①

import { useChat } from "@ai-sdk/react";               // ②
import { DefaultChatTransport } from "ai";              // ③
import { useState, useRef, useEffect } from "react";    // ④

const requestIdRef = { current: "" };                   // ⑭

export default function Chat() {
  const { messages, sendMessage, status } = useChat({   // ⑤
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: () => ({ "x-request-id": requestIdRef.current }), // ⑮
    }),
  });

  const [input, setInput] = useState("");               // ⑥
  const messagesEndRef = useRef<HTMLDivElement>(null);   // ⑦
  const [msgUsages, setMsgUsages] = useState<            // ⑯
    Record<string, { inputTokens: number; outputTokens: number }>
  >({});

  const isLoading = status === "submitted" || status === "streaming"; // ⑧
  const pendingRequestRef = useRef<string | null>(null);  // ⑰

  useEffect(() => {                                      // ⑨
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ⑱ 流式响应结束后，轮询获取本次对话的 token 用量
  useEffect(() => {
    if (status !== "ready" || !pendingRequestRef.current) return;
    const requestId = pendingRequestRef.current;
    pendingRequestRef.current = null;

    const timer = setTimeout(() => {
      fetch(`/api/chat?id=${requestId}`)
        .then((r) => r.json())
        .then((data) => {
          if (data) {
            const lastAssistant = [...messages]
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistant) {
              setMsgUsages((prev) => ({ ...prev, [lastAssistant.id]: data }));
            }
          }
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [status, messages]);

  // ⑲ 累计当前会话总用量
  const totalUsage = Object.values(msgUsages).reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  const handleSubmit = (e: React.FormEvent) => {        // ⑩
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    const rid = crypto.randomUUID();                     // ⑳
    requestIdRef.current = rid;
    pendingRequestRef.current = rid;
    sendMessage({ text: input });
    setInput("");
  };
  // ... JSX 渲染部分见下方
}
```

### 逐行拆解

**① `"use client"`**

Next.js App Router 默认用 Server Components（在服务端渲染）。但 `useChat` 需要浏览器环境（发 HTTP 请求、管理状态），所以必须标记为 Client Component。

**② `useChat` — 核心 hook**

这个 hook 做了大量工作：

```
你调用 sendMessage("你好")
    ↓
useChat 内部：
  1. 把 { role: "user", content: "你好" } 加入 messages
  2. 把完整 messages 数组 POST 到 /api/chat
  3. 接收流式响应，逐步拼接 AI 回复
  4. 每收到一个 token，更新 messages 状态
  5. React 重新渲染，用户看到逐字输出
    ↓
你什么都不用管，messages 自动更新
```

**③ `DefaultChatTransport`**

告诉 useChat 请求发到哪。`api: "/api/chat"` 对应 `src/app/api/chat/route.ts`。

为什么不直接硬编码？因为：
- 开发环境是 `http://localhost:3000/api/chat`
- 生产环境可能是 `https://your-domain.com/api/chat`
- transport 层统一处理了这个差异

`headers` 传一个函数而不是固定对象，这样每次请求都能返回不同的 `x-request-id`。`DefaultChatTransport` 内部会在每次 `sendMessages` 时调用这个函数，把返回的 headers 合并到请求头里。

**④ React hooks**

- `useState`：管理输入框文本
- `useRef`：引用 DOM 元素（用于滚动）
- `useEffect`：监听 messages 变化，自动滚动

**⑤ useChat 返回值**

| 字段 | 类型 | 含义 |
|------|------|------|
| `messages` | `UIMessage[]` | 完整消息列表（自动维护） |
| `sendMessage` | `function` | 发送消息的方法 |
| `status` | `string` | 当前状态 |

**⑥ 为什么 input 不用 useChat 管理？**

新版 AI SDK 的 `useChat` 不再内置 input 状态，你需要自己用 `useState` 管理。这是为了让 UI 更灵活（比如你想做文件上传、@提及等复杂输入）。

**⑦ `useRef` + 滚动**

`messagesEndRef` 挂在消息列表最底部的空 div 上。每当 messages 更新，`useEffect` 触发，自动滚到那里。

**⑧ status 状态机**

```
ready        → 空闲，可以发消息
submitted    → 消息已发送，等待 AI 开始响应
streaming    → AI 正在逐 token 输出
error        → 出错了
```

### JSX 渲染部分

```tsx
{/* 空状态：显示快捷提问 */}
{messages.length === 0 && (
  <div>
    {/* 4 个快捷按钮，点击直接 sendMessage */}
  </div>
)}

{/* 消息列表 */}
{messages.map((msg) => (
  <div key={msg.id}>
    {/* 用户消息靠右蓝色，AI 消息靠左灰色 */}
    {msg.parts?.map((part, i) =>
      part.type === "text" ? <span key={i}>{part.text}</span> : null
    )}
    {/* ㉑ 单次对话的 token 用量，显示在 assistant 消息下方 */}
    {msg.role === "assistant" && msgUsages[msg.id] && (
      <div className="text-[10px] text-zinc-600 mt-1 px-2">
        输入 {msgUsages[msg.id].inputTokens} · 输出 {msgUsages[msg.id].outputTokens} tokens
      </div>
    )}
  </div>
))}

{/* 加载动画：三个 bouncing 圆点 */}
{isLoading && ( ... )}

{/* 滚动锚点 */}
<div ref={messagesEndRef} />
```

**`msg.parts` 是什么？**

新版 AI SDK 把消息拆成了多个 part：
```ts
msg.parts = [
  { type: "text", text: "你好！" },
  // 后面学 Tool Use 后还会有：
  // { type: "tool-call", toolName: "search", args: {...} },
  // { type: "tool-result", result: {...} },
]
```

现在只需要处理 `text` 类型，后面加 Tool Use 时会扩展。

**⑭ `requestIdRef` — 跨请求传递 ID**

一个普通对象（不是 `useRef`），因为不需要触发重渲染。它在 `handleSubmit` 里被赋值，在 transport 的 `headers` 函数里被读取。由于 JS 对象是引用类型，transport 每次发请求时读到的都是最新值。

**⑮ `headers: () => ({ "x-request-id": ... })` — 动态请求头**

`DefaultChatTransport` 的 `headers` 支持传函数，每次 `sendMessages` 时调用。这样每个请求都能带上不同的 `x-request-id`，后端就能把 usage 存到对应的 key 下。

**⑯ `msgUsages` — 按消息 ID 存储 token 用量**

一个 state 对象，key 是消息 ID，value 是 `{ inputTokens, outputTokens }`。每条 assistant 消息对应一条 usage 记录。

**⑰ `pendingRequestRef` — 标记"正在等待 usage 的请求"**

发送消息时设为 requestId，流结束后轮询时读取并清空。用 ref 而不是 state 是因为它不需要触发重渲染。

**⑱ 轮询 useEffect — 拿 token 用量**

流式响应结束后（`status` 变为 `ready`），等 500ms 让服务端 `onFinish` 有时间存 usage，然后 `fetch GET /api/chat?id=xxx` 拿到数据，存入 `msgUsages`。500ms 的延迟是经验值，太短可能还没存好，太长用户体验差。

**⑲ `totalUsage` — 累计当前会话的总 token 用量**

把 `msgUsages` 里所有记录的 input/output 加起来，显示在右上角。每次有新的 usage 写入都会触发重新计算。

**⑳ `crypto.randomUUID()` — 生成唯一请求 ID**

浏览器原生 API，生成类似 `"3UFAmpx0VkWf1TSY"` 的 UUID。用来关联"前端的一次发送"和"后端的一次 onFinish 回调"。

**㉑ 单次 token 用量显示**

在每条 assistant 消息下方小字显示该次对话的输入/输出 token 数。让用户直观看到每轮对话消耗了多少。

### 动手实验

1. 把快捷按钮的文案改成你工作中常问的问题
2. 在 `handleSubmit` 里加 `console.log(messages)`，观察每次发送时消息历史的增长
3. 把 `isLoading` 换成 `status === "streaming"` 试试区别（submitted 阶段是否显示 loading）
4. 试试去掉 `useEffect` 的自动滚动，体验有什么不同
5. 连续发 3 条消息，观察右上角的总 token 用量是否累加正确
6. 把 `setTimeout` 的 500ms 改成 0，看是否能拿到 usage（理解竞态问题）

---

## 文件 4：`src/app/page.tsx` — 入口页

```tsx
import Chat from "@/components/Chat";

export default function Home() {
  return <Chat />;
}
```

就这么简单。Next.js 的 page.tsx 就是对应路由的页面组件。`@/` 是 tsconfig 里配的路径别名，指向 `src/`。

---

## 文件 5：`src/app/layout.tsx` — 根布局

```tsx
export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

所有页面都会被这个 layout 包裹。`children` 就是 page.tsx 渲染的内容。

---

## 依赖关系图

```
@ai-sdk/openai          ← 提供 OpenAI provider（createOpenAI）
       ↓
ai                      ← 核心 SDK（streamText、DefaultChatTransport）
       ↓
@ai-sdk/react           ← React hooks（useChat）
       ↓
next                    ← 框架（route.ts、Server/Client Components）
       ↓
react                   ← UI 库（useState、useEffect、useRef）
```

| 包 | 作用 | 类比 |
|----|------|------|
| `ai` | LLM 调用 + 流处理 | 相当于 axios 之于 HTTP |
| `@ai-sdk/openai` | OpenAI 适配器 | 相当于 axios 里的 adapter |
| `@ai-sdk/react` | React hooks | 相当于 react-query 之于 fetch |
| `next` | 全栈框架 | 你已经熟悉了 |

---

## 概念总结

### 1. System Prompt（系统提示词）
定义 AI 的角色和行为规则。用户看不到，但影响所有回答。Agent 开发中最重要的控制手段。

### 2. Messages 数组
对话的完整历史。每次请求都带上全部历史，AI 才能"记住"之前说了什么。代价是 token 消耗随对话轮次线性增长。

### 3. 流式响应（Streaming）
不等 AI 全部想完再返回，而是每生成一个 token 就立刻推给前端。用户体验从"等 5 秒看一大段"变成"实时看打字效果"。

### 4. Client vs Server Component
- Server Component（默认）：在服务端渲染，不能用 useState/useEffect
- Client Component（`"use client"`）：在浏览器运行，可以用 hooks、发请求

route.ts 在服务端运行（保护 API Key），Chat.tsx 在客户端运行（处理用户交互）。

### 5. Token 计量（Usage Tracking）

每次 LLM 调用都会消耗 token。AI SDK 的 `streamText` 在 `onFinish` 回调里返回 `usage` 对象，包含输入和输出的 token 数。

计量的典型用途：
- **成本控制**：按 token 计费，知道每次对话花了多少钱
- **用户体验**：让用户看到消耗量，培养合理使用习惯
- **调试优化**：发现 token 消耗异常的对话，优化 prompt 或截断策略

本项目的实现方式：服务端用 Map 暂存 usage，前端通过轮询 GET 接口获取。简单但有局限（重启丢失、只支持单实例），生产环境应该存数据库。

### 6. 消息格式兼容性

AI SDK 各层之间的消息格式不统一，这是实际开发中常见的坑：

| 层 | 格式 | 示例 |
|----|------|------|
| useChat 返回 | `parts` 结构 | `{ role: "user", parts: [{ type: "text", text: "你好" }] }` |
| streamText 期望 | `role/content` | `{ role: "user", content: "你好" }` |
| OpenAI API | `role/content` | `{ role: "user", content: "你好" }` |

所以 route.ts 里需要做 `formattedMessages` 转换。这个转换层在实际项目中经常被忽略，导致"前端发了消息但 AI 没回复"的 bug。

---

## 下一步：扩展方向

理解了以上代码后，可以按这个顺序扩展：

1. **加记忆** — 存储对话历史到 localStorage 或数据库
2. **加 Tool Use** — 让 AI 能调用外部 API（查日志、查 MR）
3. **加 RAG** — 接入文档知识库
4. **加多 Agent** — 多个角色协作完成任务

每个方向都是在现有代码上叠加，不会推翻重来。
