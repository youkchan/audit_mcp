#!/usr/bin/env node

import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

/**
 * ES Modulesで __dirname が使えないためのユーティリティ。
 */
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

// デフォルトポート設定
export const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// AIプロバイダの定義
export enum AIProvider {
  OPENAI = 'openai',
  DEEPSEEK = 'deepseek',
}

// デフォルトのAIプロバイダ
export const DEFAULT_PROVIDER = process.env.DEFAULT_AI_PROVIDER as AIProvider || AIProvider.DEEPSEEK;

/**
 * 監査リクエストの型定義
 */
export interface AuditRequest {
  request: string;
  modification_description: string;
  code_changes: string;      // 差分 (diff)
  function_list: string;     // function_list.txt の内容
  changed_files?: string[];  // 変更ファイル一覧
}

/**
 * ファイルごとの差分を抽出する
 * @returns ファイルパスとその差分内容のマップ
 */
function splitDiffByFiles(diffContent: string): Map<string, string> {
  const fileMap = new Map<string, string>();
  if (!diffContent) return fileMap;
  
  const lines = diffContent.split('\n');
  let currentFile = '';
  let currentContent: string[] = [];
  
  // diff --git a/path/to/file b/path/to/file パターンを抽出
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/;
  
  lines.forEach(line => {
    const match = line.match(fileRegex);
    if (match) {
      // 新しいファイルの差分が始まった
      if (currentFile && currentContent.length > 0) {
        // 前のファイルの内容を保存
        fileMap.set(currentFile, currentContent.join('\n'));
      }
      
      // 新しいファイルの情報を設定
      currentFile = match[1]; // パスを取得
      currentContent = [line]; // 現在の行を含める
    } else if (currentFile) {
      // 現在のファイルの内容に追加
      currentContent.push(line);
    }
  });
  
  // 最後のファイルの内容を保存
  if (currentFile && currentContent.length > 0) {
    fileMap.set(currentFile, currentContent.join('\n'));
  }
  
  return fileMap;
}

/**
 * モデル名を環境変数から取得する
 * 環境変数が設定されていない場合はデフォルト値を使用
 */
function getOpenAIModelName(): string {
  return process.env.OPENAI_MODEL || "gpt-4";
}

/**
 * DeepSeekのモデル名を環境変数から取得する
 */
function getDeepSeekModelName(): string {
  return process.env.DEEPSEEK_MODEL || "deepseek-chat";
}

/**
 * 使用するAIプロバイダを決定する
 */
function getAIProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER as AIProvider;
  return provider || DEFAULT_PROVIDER;
}

/**
 * OpenAI GPT に対してコード監査リクエストを行う関数。
 * 大きな差分データは複数のリクエストに分割して処理する
 */
export async function callOpenAIAudit(inputData: AuditRequest): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("環境変数 OPENAI_API_KEY が設定されていません。");
  }

  // 差分データをファイルごとに分割
  const fileDiffs = splitDiffByFiles(inputData.code_changes);
  
  // ファイル数が少ない（1つか2つ）、または差分が小さい場合は分割せずに処理
  if (fileDiffs.size <= 2 || inputData.code_changes.length < 10000) {
    return await sendSingleAuditRequest(apiKey, inputData);
  }
  
  // 差分が大きい場合、ファイルごとに分割して監査
  console.log(`大きな差分データを${fileDiffs.size}個のファイルに分割して監査します`);
  
  // 各ファイルの監査結果
  const fileResults: {file: string, result: string}[] = [];
  
  // ファイルごとに監査を実行
  for (const [filePath, diffContent] of fileDiffs.entries()) {
    console.log(`ファイル "${filePath}" の監査を実行中...`);
    
    // ファイル単位のリクエストデータを作成
    const fileRequest: AuditRequest = {
      request: `${inputData.request} - ファイル: ${filePath}`,
      modification_description: `${inputData.modification_description} - このリクエストはファイル "${filePath}" のみを対象としています。`,
      code_changes: diffContent,
      function_list: inputData.function_list,
      changed_files: [filePath]
    };
    
    try {
      // 個別のファイルを監査
      const fileAuditResult = await sendSingleAuditRequest(apiKey, fileRequest);
      fileResults.push({
        file: filePath,
        result: fileAuditResult
      });
    } catch (err) {
      console.error(`ファイル "${filePath}" の監査中にエラーが発生:`, err);
      fileResults.push({
        file: filePath,
        result: `エラー: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  
  // 各ファイルの結果を統合
  const combinedResults = fileResults.map(item => 
    `## ${item.file} の監査結果:\n\n${item.result}\n`
  ).join('\n---\n\n');
  
  // 総合サマリーの生成
  const summaryPrompt = `
以下は、コード変更の各ファイルに対する監査結果です。これらの結果を総合的に分析し、変更全体に対する簡潔なサマリーを作成してください。
問題点があれば箇条書きで指摘し、全体の評価を付けてください。

変更の概要: ${inputData.modification_description}

ファイル監査結果:
${fileResults.map(item => `- ${item.file}: ${item.result.substring(0, 100)}...`).join('\n')}
`;

  // サマリー生成リクエスト
  const summaryResult = await callCompletion([
    {
      role: "system", 
      content: "あなたはコード監査の専門家です。複数のファイル監査結果を統合して、全体の評価を提供してください。"
    },
    { role: "user", content: summaryPrompt }
  ]);
  
  // 最終的な監査レポート
  return `# 監査サマリー\n\n${summaryResult}\n\n# 詳細な監査結果\n\n${combinedResults}`;
}

/**
 * 単一のOpenAI監査リクエストを送信する
 */
async function sendSingleAuditRequest(apiKey: string, inputData: AuditRequest): Promise<string> {
  // ChatCompletion 用のプロンプトを用意
  const messages = [
    {
      role: "system",
      content: `あなたはソフトウェア監査ツールです。与えられた「リクエスト」「変更内容」「差分」「function_list」「変更ファイル一覧」を確認し、下記の観点で監査してください：

【重要な監査観点】
1. 指示していない変更がないか（修正内容に記載されていない変更が行われていないか）
2. 既存機能が削除されていないか（特にfunction_list.txtに記載されている機能が失われていないか）
3. TODO / FIXME が残っていないか
4. 修正内容とコードの差分に整合性があるか（修正内容で述べられていることと実際のコード変更が一致しているか）
5. 修正内容に記載されている目的が適切に実装されているか

必ず以下の形式で監査レポートを作成してください：

# コード監査レポート

## 1. 指示していない変更
[指示していない変更の有無とその詳細を記載。なければ「指示していない変更は見つかりませんでした。」と記載]

## 2. 既存機能の削除
[既存機能が削除されていないか、特にfunction_list.txtに記載されている機能が失われていないか確認した結果を記載]

## 3. TODO/FIXME の残存
[TODO/FIXMEコメントの有無とその詳細を記載。なければ「残存しているTODO/FIXMEコメントは見つかりませんでした。」と記載]

## 4. 修正内容との整合性
[修正内容の説明と実際のコード変更が一致しているか詳細に分析した結果を記載]

## 5. 目的の実装状況
[修正内容に記載されている目的が適切に実装されているか詳細に確認した結果を記載]

## 6. 技術的問題点
[コード品質、パフォーマンス、セキュリティなどの技術的観点での問題点があれば箇条書きで指摘]
- 問題点1 [重要度: 高/中/低]
- 問題点2 [重要度: 高/中/低]
- ...

## 7. 総合評価
[監査全体の総合評価と、改善すべき重要な点を簡潔にまとめる]

## function_list.txt更新案
[今回の修正に関連してfunction_list.txtに追加・更新すべき内容。関数の振る舞いが正確に理解できるような詳細な説明と、変更されたプロンプトがある場合はそのプロンプトも含める]

上記の各セクションは必ず含め、具体的かつ詳細な情報を提供してください。特に修正内容との整合性と目的の実装状況については詳細に分析してください。`,
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

  return await callCompletion(messages);
}

/**
 * AIプロバイダに応じてメッセージを送信する
 */
async function callCompletion(messages: any[]): Promise<string> {
  const provider = getAIProvider();
  
  console.log(`AIプロバイダ: ${provider} を使用します`);
  
  // プロバイダに応じた関数を呼び出す
  switch (provider) {
    case AIProvider.OPENAI:
      const openAiKey = process.env.OPENAI_API_KEY;
      if (!openAiKey) throw new Error("環境変数 OPENAI_API_KEY が設定されていません。");
      return await callOpenAICompletion(openAiKey, messages);
      
    case AIProvider.DEEPSEEK:
      const deepseekKey = process.env.DEEPSEEK_API_KEY;
      if (!deepseekKey) throw new Error("環境変数 DEEPSEEK_API_KEY が設定されていません。");
      return await callDeepSeekCompletion(deepseekKey, messages);
      
    default:
      throw new Error(`未対応のAIプロバイダです: ${provider}`);
  }
}

/**
 * OpenAI API に対して汎用的なメッセージを送信する
 */
async function callOpenAICompletion(apiKey: string, messages: any[]): Promise<string> {
  const apiUrl = "https://api.openai.com/v1/chat/completions";
  const modelName = getOpenAIModelName();
  
  console.log(`OpenAI APIにリクエスト送信: モデル=${modelName}`);

  // リクエストボディを作成
  const requestBody = {
    model: modelName,
    messages,
    max_tokens: 1500,
    temperature: 0.2,
  };

  // リクエスト内容をログに出力
  console.log("===== OpenAI APIリクエスト内容 =====");
  console.log(JSON.stringify(requestBody, null, 2));
  console.log("===================================");

  // OpenAI API (ChatCompletion) 呼び出し
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
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
  const responseContent = jsonData.choices?.[0]?.message?.content || "";

  // レスポンス受信のログを出力
  console.log("===== OpenAI APIレスポンス受信完了 =====");
  console.log(`レスポンス長: ${responseContent.length}文字`);
  console.log("レスポンスの先頭100文字: " + responseContent.substring(0, 100) + "...");
  console.log("========================================");

  return responseContent;
}

/**
 * DeepSeek API に対してメッセージを送信する
 */
async function callDeepSeekCompletion(apiKey: string, messages: any[]): Promise<string> {
  const apiUrl = "https://api.deepseek.com/v1/chat/completions";
  const modelName = getDeepSeekModelName();
  
  console.log(`DeepSeek APIにリクエスト送信: モデル=${modelName}`);

  // リクエストボディを作成
  const requestBody = {
    model: modelName,
    messages,
    max_tokens: 1500,
    temperature: 0.2,
  };

  // リクエスト内容をログに出力
  console.log("===== DeepSeek APIリクエスト内容 =====");
  console.log(JSON.stringify(requestBody, null, 2));
  console.log("======================================");

  // OpenAI互換のリクエスト形式でDeepSeek APIを呼び出し
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API エラー: ${response.status}\n${errText}`);
  }

  // 応答JSONをパース（OpenAI互換のレスポンス形式）
  type DeepSeekResponse = {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const jsonData = (await response.json()) as DeepSeekResponse;
  const responseContent = jsonData.choices?.[0]?.message?.content || "";

  // レスポンス受信のログを出力
  console.log("===== DeepSeek APIレスポンス受信完了 =====");
  console.log(`レスポンス長: ${responseContent.length}文字`);
  console.log("レスポンスの先頭100文字: " + responseContent.substring(0, 100) + "...");
  console.log("==========================================");

  return responseContent;
}

/**
 * 監査レポートを保存する
 */
export function saveAuditReport(aiReport: string): string {
  // レポートをファイルに保存 (./audits/reports/配下)
  const reportsDir = path.join(__dirname, "audits", "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `audit-report-${timestamp}.txt`);

  fs.writeFileSync(reportPath, aiReport, "utf8");
  return reportPath;
}

/**
 * 監査を実行し、レポートを生成・保存する
 */
export async function performAudit(params: AuditRequest): Promise<{
  status: string;
  message: string;
  reportPath: string;
  aiReport: string;
}> {
  try {
    console.log("コード監査を開始します...");
    const startTime = Date.now();

    // OpenAI GPT へ監査依頼を送り、結果を取得
    const aiReport = await callOpenAIAudit(params);

    // レポートをファイルに保存
    const reportPath = saveAuditReport(aiReport);

    // 処理にかかった時間を計算（秒単位）
    const processingTime = (Date.now() - startTime) / 1000;

    console.log(`===== 監査完了 =====`);
    console.log(`処理時間: ${processingTime.toFixed(2)}秒`);
    console.log(`レポート保存先: ${reportPath}`);
    console.log(`レポート長: ${aiReport.length}文字`);
    console.log(`====================`);

    return {
      status: "success",
      message: "監査レポートを生成しました。",
      reportPath,
      aiReport,
    };
  } catch (error) {
    console.error("監査中にエラーが発生しました:", error);
    throw error;
  }
} 