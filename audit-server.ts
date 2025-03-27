#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from "zod";

const execAsync = promisify(exec);

interface AuditData {
  request: string;
  modification_description: string;
  code_changes: string;
  function_list: string;
  files_to_check?: string[];
}

class AuditServer {
  private auditHistory: AuditData[] = [];
  private reportsDir: string = path.join(process.cwd(), 'audits', 'reports');

  constructor() {
    // 報告ディレクトリの存在確認と作成
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  private validateAuditData(input: unknown): AuditData {
    const data = input as Record<string, unknown>;

    if (!data.request || typeof data.request !== 'string') {
      throw new Error('Invalid request: must be a string');
    }
    if (!data.modification_description || typeof data.modification_description !== 'string') {
      throw new Error('Invalid modification_description: must be a string');
    }
    if (!data.code_changes || typeof data.code_changes !== 'string') {
      throw new Error('Invalid code_changes: must be a string');
    }
    if (!data.function_list || typeof data.function_list !== 'string') {
      throw new Error('Invalid function_list: must be a string');
    }

    return {
      request: data.request as string,
      modification_description: data.modification_description as string,
      code_changes: data.code_changes as string,
      function_list: data.function_list as string,
      files_to_check: Array.isArray(data.files_to_check) 
        ? data.files_to_check.filter(f => typeof f === 'string') as string[]
        : undefined
    };
  }

  private async checkGitIgnoredFiles(filesToCheck: string[]): Promise<{ ignored: string[], notIgnored: string[] }> {
    const ignored: string[] = [];
    const notIgnored: string[] = [];

    for (const file of filesToCheck) {
      try {
        // gitコマンドを使用して、ファイルが.gitignoreに含まれているか確認
        const { stdout } = await execAsync(`git check-ignore -v ${file}`);
        if (stdout.trim()) {
          ignored.push(file);
        } else {
          notIgnored.push(file);
        }
      } catch (error) {
        // git check-ignoreはファイルが無視されていない場合に非ゼロ終了コードを返す
        notIgnored.push(file);
      }
    }

    return { ignored, notIgnored };
  }

  private async checkFunctionListConsistency(functionList: string, codeChanges: string): Promise<{ isConsistent: boolean, issues: string[] }> {
    const issues: string[] = [];
    
    // 関数リストから機能を抽出
    const functionMatches = functionList.match(/\*\*([^*]+)\*\*/g) || [];
    const declaredFunctions = functionMatches.map(match => match.replace(/\*\*/g, '').trim());
    
    // コード変更から関数名を抽出（簡易的な実装）
    const functionRegex = /(?:function|def|class)\s+(\w+)/g;
    let codeMatch;
    const implementedFunctions: string[] = [];
    
    while ((codeMatch = functionRegex.exec(codeChanges)) !== null) {
      implementedFunctions.push(codeMatch[1]);
    }
    
    // function_listに記載されているが実装されていない関数
    const missingFunctions = declaredFunctions.filter(
      func => !implementedFunctions.some(impl => impl.includes(func))
    );
    
    if (missingFunctions.length > 0) {
      issues.push(`機能リストに記載されていますが実装されていない関数: ${missingFunctions.join(', ')}`);
    }
    
    // コードの整合性チェック（簡易的な実装）
    if (codeChanges.includes('TODO') || codeChanges.includes('FIXME')) {
      issues.push('コード内にTODOまたはFIXMEコメントが残っています');
    }
    
    return { 
      isConsistent: issues.length === 0,
      issues 
    };
  }

  private formatAuditReport(auditData: AuditData, consistency: { isConsistent: boolean, issues: string[] }, gitCheck?: { ignored: string[], notIgnored: string[] }): string {
    const { request, modification_description, code_changes } = auditData;
    
    let report = `
┌${'─'.repeat(50)}┐
│ ${chalk.blue('🔍 監査レポート')}${' '.repeat(36)}│
├${'─'.repeat(50)}┤
│ ${chalk.yellow('リクエスト内容:')}${' '.repeat(35)}│
│ ${request.substring(0, 46).padEnd(46)}${' '.repeat(2)}│
${request.length > 46 ? `│ ${request.substring(46, 92).padEnd(46)}${' '.repeat(2)}│` : ''}
│${' '.repeat(48)}│
│ ${chalk.yellow('修正内容(説明):')}${' '.repeat(33)}│
│ ${modification_description.substring(0, 46).padEnd(46)}${' '.repeat(2)}│
${modification_description.length > 46 ? `│ ${modification_description.substring(46, 92).padEnd(46)}${' '.repeat(2)}│` : ''}
│${' '.repeat(48)}│
│ ${chalk.yellow('機能の整合性:')}${' '.repeat(35)}│
│ ${consistency.isConsistent ? chalk.green('整合性があります ✓') : chalk.red('整合性に問題があります ✗')}${' '.repeat(24)}│
`;

    if (!consistency.isConsistent) {
      report += `│${' '.repeat(48)}│\n`;
      consistency.issues.forEach(issue => {
        report += `│ ${chalk.red('- ' + issue.substring(0, 44).padEnd(44))}${' '.repeat(2)}│\n`;
        if (issue.length > 44) {
          report += `│ ${'  ' + issue.substring(44, 90).padEnd(44)}${' '.repeat(2)}│\n`;
        }
      });
    }

    if (gitCheck) {
      report += `│${' '.repeat(48)}│\n`;
      report += `│ ${chalk.yellow('.gitignoreチェック:')}${' '.repeat(30)}│\n`;
      
      if (gitCheck.ignored.length > 0) {
        report += `│ ${chalk.red('以下のファイルは.gitignoreに含まれています:')}${' '.repeat(6)}│\n`;
        gitCheck.ignored.forEach(file => {
          report += `│ ${chalk.red('- ' + file.substring(0, 44).padEnd(44))}${' '.repeat(2)}│\n`;
        });
      } else {
        report += `│ ${chalk.green('対象ファイルは.gitignoreに含まれていません ✓')}${' '.repeat(4)}│\n`;
      }
    }

    report += `└${'─'.repeat(50)}┘`;
    return report;
  }

  private saveAuditReport(report: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(this.reportsDir, `audit-report-${timestamp}.txt`);
    
    fs.writeFileSync(reportPath, report, 'utf8');
    return reportPath;
  }

  public async processAudit(params: {
    request: string;
    modification_description: string;
    code_changes: string;
    function_list: string;
    files_to_check?: string[];
  }): Promise<{
    content: Array<{
      type: "text";
      text: string;
    }>;
    isError?: boolean;
  }> {
    try {
      const validatedInput = this.validateAuditData(params);
      this.auditHistory.push(validatedInput);

      // 機能リストとコード変更の整合性チェック
      const consistencyCheck = await this.checkFunctionListConsistency(
        validatedInput.function_list,
        validatedInput.code_changes
      );

      let gitCheck: { ignored: string[], notIgnored: string[] } | undefined;
      
      // .gitignoreチェック（ファイルリストが提供されている場合）
      if (validatedInput.files_to_check && validatedInput.files_to_check.length > 0) {
        gitCheck = await this.checkGitIgnoredFiles(validatedInput.files_to_check);
      }

      // 監査レポートを作成
      const report = this.formatAuditReport(validatedInput, consistencyCheck, gitCheck);
      const reportPath = this.saveAuditReport(report);
      
      console.error(report);
      console.error(`レポートは ${reportPath} に保存されました`);

      // 応答を返す
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            isConsistent: consistencyCheck.isConsistent,
            issues: consistencyCheck.issues,
            gitIgnoredFiles: gitCheck?.ignored || [],
            reportSaved: reportPath,
            status: 'success'
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
}

// 監査サーバーのインスタンスを作成
const auditServer = new AuditServer();

// サーバーの初期化
const server = new McpServer({
  name: "code-audit-server",
  version: "0.1.0"
});

// ツールの登録
server.tool(
  "code_audit",
  {
    request: z.string().describe("ユーザーからのリクエスト内容"),
    modification_description: z.string().describe("変更内容の日本語での説明"),
    code_changes: z.string().describe("実際のコード変更内容"),
    function_list: z.string().describe("機能リストの内容"),
    files_to_check: z.array(z.string()).optional().describe(".gitignoreチェックを行うファイルのリスト")
  },
  async (params, _extra) => {
    return await auditServer.processAudit(params);
  }
);

// サーバーの起動
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("監査サーバーが起動しました。待機中...");
  } catch (err) {
    console.error("Error running server:", err);
    process.exit(1);
  }
}

main(); 