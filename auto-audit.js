#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * 直近の変更内容を取得する関数
 * @returns {string} 変更の差分
 */
function getLatestChanges() {
  try {
    // git diffで変更内容を取得
    const diff = execSync('git diff --cached').toString();
    if (!diff.trim()) {
      // ステージングされた変更がない場合は未ステージングの変更を取得
      return execSync('git diff').toString();
    }
    return diff;
  } catch (error) {
    return '// 変更内容を取得できませんでした';
  }
}

/**
 * function_list.txtの内容を取得する関数
 * @returns {string} function_list.txtの内容
 */
function getFunctionList() {
  try {
    return readFileSync('function_list.txt', 'utf-8');
  } catch (error) {
    return '// function_list.txtが見つかりません';
  }
}

/**
 * 変更されたファイルのリストを取得する関数
 * @returns {string[]} 変更されたファイルのパスのリスト
 */
function getChangedFiles() {
  try {
    // ステージングされたファイルと未ステージングのファイルの両方を取得
    const stagedFiles = execSync('git diff --cached --name-only').toString().split('\n').filter(Boolean);
    const unstagedFiles = execSync('git diff --name-only').toString().split('\n').filter(Boolean);
    
    // 重複を除いて結合
    return [...new Set([...stagedFiles, ...unstagedFiles])];
  } catch (error) {
    return [];
  }
}

/**
 * 監査リクエストを生成する関数
 * @param {string} modificationDescription 修正内容の説明
 * @returns {string} 監査リクエスト
 */
function generateAuditRequest(modificationDescription) {
  const codeChanges = getLatestChanges();
  const functionList = getFunctionList();
  const changedFiles = getChangedFiles();
  
  return `以下のコード変更を監査してください：

リクエスト内容：「直近のコード変更の監査をお願いします」
修正内容：「${modificationDescription}」
コード変更：
\`\`\`diff
${codeChanges}
\`\`\`

function_list.txtの内容：
\`\`\`
${functionList}
\`\`\`

変更されたファイル：
${changedFiles.join('\n')}`;
}

// メイン処理
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('使用方法: node auto-audit.js "修正内容の説明"');
    process.exit(1);
  }
  
  const modificationDescription = args.join(' ');
  const request = generateAuditRequest(modificationDescription);
  
  // 一時ファイルに保存してクリップボードにコピー
  const tempFile = join(process.cwd(), 'audits', 'temp-audit-request.txt');
  writeFileSync(tempFile, request, 'utf-8');
  
  console.log('監査リクエストを生成しました。Cursorのチャットにペーストしてください。');
  console.log(`リクエストは ${tempFile} に保存されました`);
  
  try {
    if (process.platform === 'darwin') {
      // macOSの場合はpbcopyを使用
      execSync(`cat "${tempFile}" | pbcopy`);
      console.log('リクエストをクリップボードにコピーしました');
    } else if (process.platform === 'win32') {
      // Windowsの場合はclipを使用
      execSync(`type "${tempFile}" | clip`);
      console.log('リクエストをクリップボードにコピーしました');
    }
  } catch (error) {
    console.log('クリップボードへのコピーに失敗しました。ファイルから内容をコピーしてください');
  }
}

main(); 