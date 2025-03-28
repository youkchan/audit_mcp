#!/usr/bin/env node

import express from "express";
import { performAudit, AuditRequest, DEFAULT_PORT } from "./audit-common.js";

/**
 * audit-http-server.ts
 *
 * このファイルでは、
 *  1) Express.jsを使ってHTTPサーバーを構成
 *  2) JSON-RPCリクエストを受け付けて監査機能を実行
 *  という流れを実装しています。
 * 
 * 使用例:
 *   node audit-http-server.js
 *   PORT=8080 node audit-http-server.js  # ポート指定
 */

// 設定
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT;

// Expressアプリケーションを作成
const app = express();
app.use(express.json());

// JSON-RPCリクエスト型定義
interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params: any;
}

// JSON-RPCエンドポイント
// @ts-ignore: express 5.0.1との型互換性問題を無視
app.post('/', async (req, res) => {
  try {
    console.log("リクエスト受信:", JSON.stringify(req.body, null, 2));
    
    // リクエストのバリデーション
    if (!req.body || !req.body.method || !req.body.params) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: req.body?.id || null,
        error: {
          code: -32600,
          message: "Invalid Request: JSON-RPCリクエストの形式が不正です"
        }
      });
    }

    // JSON-RPCリクエストを処理
    const result = await processJsonRpcRequest(req.body as JsonRpcRequest);
    res.json(result);
  } catch (err) {
    console.error("エラー発生:", err);
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err)
      }
    });
  }
});

// 起動
app.listen(PORT, () => {
  console.log(`\n====================================================`);
  console.log(`🚀 監査サーバーが起動しました！`);
  console.log(`📋 HTTP Endpoint: http://localhost:${PORT}/`);
  console.log(`🔍 JSON-RPC監査リクエストはこちらに送信してください`);
  console.log(`====================================================\n`);
});

/**
 * JSON-RPCリクエストを処理する関数
 */
async function processJsonRpcRequest(request: JsonRpcRequest): Promise<any> {
  // 実装されているメソッドのチェック
  if (request.method !== "tool/audit") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `Method not found: ${request.method}`
      }
    };
  }

  try {
    // リクエストパラメータを取得
    const params = request.params as AuditRequest;
    
    // 監査を実行
    const result = await performAudit(params);
    
    // JSON-RPCレスポンスとして返却
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: result
    };
  } catch (err) {
    console.error("監査実行エラー:", err);
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err)
      }
    };
  }
} 