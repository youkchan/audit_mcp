#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { performAudit, AuditRequest } from "./audit-common.js";

/**
 * audit-mcp-server.ts
 *
 * このファイルでは、
 *  1) MCPサーバーを設定
 *  2) "audit" MCPツールを定義
 *  3) StdioServerTransportを使ってメッセージの送受信を設定
 *  という流れを実装しています。
 * 
 * 使用例:
 *   node audit-mcp-server.js
 */

/**
 * MCPサーバーを設定する
 */
function setupMcpServer(): McpServer {
  // MCPサーバーを作成
  const server = new McpServer({
    name: "cursor-audit-server",
    version: "1.0.0",
  });

  // ツール "audit" を定義
  //   受け取れるパラメータを zod で定義し、実行ロジックを実装
  server.tool(
    "audit",
    {
      request: z.string().describe("監査リクエストの内容"),
      modification_description: z.string().describe("変更内容の説明"),
      code_changes: z.string().describe("コード差分 (diff形式など)"),
      function_list: z.string().describe("function_list.txt の内容 (パッケージ側で管理)"),
      changed_files: z.array(z.string()).optional().describe("変更されたファイル一覧"),
    },
    async (params: AuditRequest) => {
      try {
        // 共通監査機能を呼び出し
        const result = await performAudit(params);

        // MCPレスポンスとして返却
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// MCPサーバーを設定
const server = setupMcpServer();

// 標準入出力で通信を開始
console.log("MCPサーバーを標準入出力モードで起動しています...");
const transport = new StdioServerTransport();
await server.connect(transport); 