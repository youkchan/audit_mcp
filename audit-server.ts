#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fetch from "node-fetch";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

/**
 * audit-server.ts
 *
 * このファイルでは、
 *  1) "audit" MCPツールを定義
 *  2) 受け取った差分・function_listなどを OpenAI API へ投げて監査を行う
 *  3) レポートをファイルに保存
 *  という流れを実装しています。
 */

/**
 * ES Modulesで __dirname が使えないためのユーティリティ。
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * OpenAI GPT に対してコード監査リクエストを行う関数。
 */
async function callOpenAIAudit(inputData: {
  request: string;
  modification_description: string;
  code_changes: string;      // 差分 (diff)
  function_list: string;     // function_list.txt の内容 (監査対象パッケージから提供される想定)
  changed_files?: string[];  // 変更ファイル一覧
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("環境変数 OPENAI_API_KEY が設定されていません。");
  }

  const apiUrl = "https://api.openai.com/v1/chat/completions";

  // ChatCompletion 用のプロンプトを用意
  const messages = [
    {
      role: "system",
      content: `あなたはソフトウェア監査ツールです。与えられた「リクエスト」「変更内容」「差分」「function_list」「変更ファイル一覧」を確認し、
- 指示していない変更がないか
- 既存機能が削除されていないか
- TODO / FIXME が残っていないか
などを点検し、問題点があれば箇条書きで指摘してください。`,
    },
    {
      role: "user",
      content: `
【リクエスト】:
${inputData.request}

【修正内容の概要】:
${inputData.modification_description}

【変更されたファイル】:
${(inputData.changed_files || []).join("\n") || "（なし）"}

【function_list.txt の内容】:
\`\`\`
${inputData.function_list}
\`\`\`

【コード差分】:
\`\`\`diff
${inputData.code_changes}
\`\`\`
`,
    },
  ];

  // OpenAI API (ChatCompletion) 呼び出し
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo", // 必要に応じて "gpt-4" に変更可
      messages,
      max_tokens: 800,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API エラー: ${response.status}\n${errText}`);
  }

  // 応答JSONをパース
  type OpenAIResponse = {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const jsonData = (await response.json()) as OpenAIResponse;
  return jsonData.choices?.[0]?.message?.content || "";
}

// 1) MCPサーバーを作成
const server = new McpServer({
  name: "cursor-audit-server",
  version: "1.0.0",
});

// 2) ツール "audit" を定義
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
  async (params) => {
    try {
      // 3) OpenAI GPT へ監査依頼を送り、結果を取得
      const aiReport = await callOpenAIAudit(params);

      // 4) レポートをファイルに保存 (./audits/reports/配下)
      const reportsDir = path.join(__dirname, "audits", "reports");
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const reportPath = path.join(reportsDir, `audit-report-${timestamp}.txt`);

      fs.writeFileSync(reportPath, aiReport, "utf8");

      // 5) MCPレスポンスとして返却
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                message: "OpenAIの監査レポートを生成しました。",
                reportPath,
                aiReport,
              },
              null,
              2
            ),
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

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);