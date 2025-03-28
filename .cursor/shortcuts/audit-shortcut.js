import { execSync } from "child_process";

/**
 * 直近の変更内容を取得する関数 (ステージング優先 + フォールバック)
 */
function getLatestChanges() {
  try {
    // 1) ステージングされた差分を取得
    const diffCached = execSync("git diff --cached").toString();
    if (diffCached.trim()) {
      // ステージングに変更がある場合はそれを返す
      return diffCached;
    } else {
      // ステージング差分がなければ未ステージングを返す
      return execSync("git diff").toString();
    }
  } catch (error) {
    return "// 変更内容を取得できませんでした";
  }
}

/**
 * function_list.txtの内容を取得する関数
 * 今回は監査対象パッケージからリクエストで提供される前提なら、
 * ローカルではなく別の方法で取得する可能性がありますが
 * ローカルにあるなら、ここで読み込んでもOKです。
 * ※ 注意: もしサーバー側でなくショートカットで読み込む必要があるなら
 *          ここで読み込むロジックを使います。
 */
function getFunctionListLocally() {
  try {
    return execSync("cat function_list.txt").toString();
  } catch (error) {
    return "// function_list.txtが見つかりません";
  }
}

/**
 * 変更されたファイルのリストを取得する関数
 * (ステージング + 未ステージング の両方をまとめる例)
 */
function getChangedFiles() {
  try {
    const stagedFiles = execSync("git diff --cached --name-only")
      .toString()
      .split("\n")
      .filter(Boolean);
    const unstagedFiles = execSync("git diff --name-only")
      .toString()
      .split("\n")
      .filter(Boolean);

    // 重複を除外してまとめる
    return [...new Set([...stagedFiles, ...unstagedFiles])];
  } catch (error) {
    return [];
  }
}

/**
 * 「@audit 修正内容」ショートカット
 *
 * - Git差分を取得
 * - ファイル一覧を取得
 * - (必要なら) function_list.txtを読み込む
 * - MCPツール "audit" にパラメータを渡すよう、Cursorエージェントにメッセージ送信
 */
export default {
  title: "Audit Code Changes",
  command: "@audit",
  onRun: async (args, api) => {
    // 例) "@audit タグとcontentの修正" => args = ["タグとcontentの修正"]
    const modificationDescription = args.join(" ");

    // 差分 & 変更ファイル取得
    const codeChanges = getLatestChanges();
    const changedFiles = getChangedFiles();

    // ここでは function_list.txt をローカルで取得する実装例
    // （もし「監査対象パッケージから提供」されるなら別途HTTPなどで受け取ってもOK）
    const functionList = getFunctionListLocally();
    const payload = {
      request: "直近のコード変更の監査をお願いします",
      modification_description: modificationDescription,
      code_changes: codeChanges,
      function_list: functionList,
      changed_files: changedFiles,
    };

    // 出力用の文字列
    // （Cursorのチャット欄に表示されるだけなので、
    //   ユーザがコピペしやすいようフォーマットする）
    const message = `以下をコピーして監査サーバーに送信してください:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tool/audit",
  "params": ${JSON.stringify(payload, null, 2)}
}
\`\`\`
`;

    // チャット欄にこのメッセージを表示
    api.chat.sendMessage(message);
  },
};
