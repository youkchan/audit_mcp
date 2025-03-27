#!/usr/bin/env node

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// 現在のディレクトリを取得
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 監査サーバーを実行する関数
 * @param {string} request ユーザーからのリクエスト内容
 * @param {string} modification 修正内容の説明
 * @param {string} codeChanges コード変更内容
 * @param {string} functionList 機能リストの内容
 * @param {string[]} filesToCheck .gitignoreチェックを行うファイルリスト（オプション）
 * @returns {Promise<object>} 監査結果
 */
function runAudit(request, modification, codeChanges, functionList, filesToCheck = []) {
  return new Promise((resolve, reject) => {
    // サーバープロセスを起動
    const serverProcess = spawn('node', [join(__dirname, 'dist', 'audit-server.js')]);
    
    let stdoutData = '';
    let stderrData = '';
    
    // 標準出力を収集
    serverProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });
    
    // 標準エラー出力を収集
    serverProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
      // 進捗状況をコンソールに表示（オプション）
      console.error(data.toString());
    });
    
    // プロセス終了時の処理
    serverProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`サーバープロセスが終了コード ${code} で終了しました\n${stderrData}`));
        return;
      }
      
      try {
        // 標準出力からJSONレスポンスを解析
        const responseLines = stdoutData.split('\n').filter(line => line.trim());
        if (responseLines.length === 0) {
          reject(new Error('サーバーからの応答がありません'));
          return;
        }
        
        const lastResponseLine = responseLines[responseLines.length - 1];
        const responseJson = JSON.parse(lastResponseLine);
        resolve(responseJson);
      } catch (err) {
        reject(new Error(`サーバー応答の解析に失敗しました: ${err.message}`));
      }
    });
    
    // エラー発生時の処理
    serverProcess.on('error', (err) => {
      reject(new Error(`サーバープロセスの起動に失敗しました: ${err.message}`));
    });
    
    // リクエストを標準入力に送信
    const requestObject = {
      jsonrpc: '2.0',
      id: 1,
      method: 'callTool',
      params: {
        name: 'code_audit',
        parameters: {
          request,
          modification_description: modification,
          code_changes: codeChanges,
          function_list: functionList,
          files_to_check: filesToCheck
        }
      }
    };
    
    serverProcess.stdin.write(JSON.stringify(requestObject) + '\n');
    serverProcess.stdin.end();
  });
}

// メイン処理
async function main() {
  try {
    // コマンドライン引数からファイルパスを取得
    const args = process.argv.slice(2);
    
    if (args.length < 4) {
      console.error('使用方法: node client-example.js <リクエスト> <修正内容> <コード変更ファイル> <機能リストファイル> [チェック対象ファイル1 チェック対象ファイル2 ...]');
      process.exit(1);
    }
    
    const [requestText, modificationText, codeChangesPath, functionListPath, ...filesToCheck] = args;
    
    // ファイルから内容を読み込む
    const codeChanges = readFileSync(codeChangesPath, 'utf8');
    const functionList = readFileSync(functionListPath, 'utf8');
    
    console.log('監査を実行中...');
    const result = await runAudit(requestText, modificationText, codeChanges, functionList, filesToCheck);
    
    console.log('\n✅ 監査結果:');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.isConsistent) {
      console.log('\n✅ コードの整合性に問題はありません');
    } else {
      console.log('\n⚠️ コードに以下の問題があります:');
      result.issues.forEach(issue => console.log(`- ${issue}`));
    }
    
    if (result.gitIgnoredFiles.length > 0) {
      console.log('\n⚠️ 以下のファイルは.gitignoreに含まれています:');
      result.gitIgnoredFiles.forEach(file => console.log(`- ${file}`));
    }
    
    console.log(`\n📝 詳細なレポートは ${result.reportSaved} に保存されました`);
    
  } catch (error) {
    console.error('エラー:', error.message);
    process.exit(1);
  }
}

// スクリプトが直接実行された場合にメイン処理を実行
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { runAudit }; 