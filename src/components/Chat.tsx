"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useEffect } from "react";

export default function Chat() {
  // useChat 核心 hook：管理消息列表、发送请求、解析流式响应
  // transport 指定 API 地址，对应 route.ts 的路径
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  // 输入框状态（useChat 不再内置 input 管理，需要自己维护）
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // status 状态机：submitted → streaming → ready / error
  const isLoading = status === "submitted" || status === "streaming";

  // 新消息到来时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 表单提交：发送消息并清空输入框
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      {/* ===== 顶部标题栏 ===== */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-lg font-semibold">DevPilot</h1>
        <p className="text-sm text-zinc-400">开发运维 AI 助手</p>
      </header>

      {/* ===== 消息列表区域 ===== */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {/* 空状态：显示快捷提问按钮 */}
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

        {/* 渲染每条消息 */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-100"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="text-xs text-zinc-500 mb-1">DevPilot</div>
              )}
              {/* parts 是新版 AI SDK 的消息结构，text 类型包含实际文本 */}
              {msg.parts?.map((part, i) =>
                part.type === "text" ? <span key={i}>{part.text}</span> : null
              )}
            </div>
          </div>
        ))}

        {/* 加载中的打字动画 */}
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

        {/* 滚动锚点 */}
        <div ref={messagesEndRef} />
      </div>

      {/* ===== 底部输入栏 ===== */}
      <form onSubmit={handleSubmit} className="border-t border-zinc-800 px-6 py-4">
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
