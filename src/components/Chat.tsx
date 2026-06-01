"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useEffect } from "react";

const requestIdRef = { current: "" };

export default function Chat() {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: () => ({ "x-request-id": requestIdRef.current }),
    }),
  });

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [msgUsages, setMsgUsages] = useState<
    Record<string, { inputTokens: number; outputTokens: number }>
  >({});

  const isLoading = status === "submitted" || status === "streaming";

  const pendingRequestRef = useRef<string | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 流式响应结束后，轮询获取本次对话的 token 用量
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

  // 计算当前会话总用量
  const totalUsage = Object.values(msgUsages).reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const rid = crypto.randomUUID();
    requestIdRef.current = rid;
    pendingRequestRef.current = rid;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">DevPilot</h1>
          <p className="text-sm text-zinc-400">开发运维 AI 助手</p>
        </div>
        {totalUsage.inputTokens + totalUsage.outputTokens > 0 && (
          <div className="text-xs text-zinc-500 text-right">
            <div>总输入 {totalUsage.inputTokens} tokens</div>
            <div>总输出 {totalUsage.outputTokens} tokens</div>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500">
            <div className="text-4xl mb-4">🤖</div>
            <p className="text-lg font-medium">你好，我是 DevPilot</p>
            <p className="text-sm mt-1">问我任何开发运维相关的问题</p>
            <div className="grid grid-cols-2 gap-3 mt-8 max-w-md">
              {[
                "帮我解释一下这段报错",
                "如何优化慢 SQL 查询",
                "Docker 镜像太大怎么瘦身",
                "NestJS 中间件怎么写",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => sendMessage({ text: suggestion })}
                  className="text-left text-sm px-4 py-3 rounded-xl border border-zinc-800 hover:bg-zinc-900 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className="max-w-[80%]">
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-800 text-zinc-100"
                }`}
              >
                {msg.role === "assistant" && (
                  <div className="text-xs text-zinc-500 mb-1">DevPilot</div>
                )}
                {msg.parts?.map((part, i) =>
                  part.type === "text" ? <span key={i}>{part.text}</span> : null,
                )}
              </div>
              {msg.role === "assistant" && msgUsages[msg.id] && (
                <div className="text-[10px] text-zinc-600 mt-1 px-2">
                  输入 {msgUsages[msg.id].inputTokens} · 输出{" "}
                  {msgUsages[msg.id].outputTokens} tokens
                </div>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 rounded-2xl px-4 py-3 text-sm">
              <div className="flex items-center gap-1">
                <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-800 px-6 py-4"
      >
        <div className="flex gap-3 max-w-3xl mx-auto">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入你的问题..."
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-xl text-sm font-medium transition-colors"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
