#!/usr/bin/env bash
#
# auto-audit.sh
#
# 使用例:
#   ./auto-audit.sh             # JSON-RPCリクエストを生成して表示
#   ./auto-audit.sh -h          # HTTPサーバーへ送信するcurlコマンドを表示
#   ./auto-audit.sh --http      # HTTPサーバーへ送信するcurlコマンドを表示
#   ./auto-audit.sh -h 8080     # ポート番号を指定してHTTPサーバーへ送信
#   ./auto-audit.sh --http --send # HTTPサーバーへ直接送信（要curl, jq）
#
# 実行すると:
#   1) task_list.txtから修正内容を読み込み
#   2) Git差分(ステージング優先)
#   3) function_list.txt 内容
#   4) 変更されたファイル一覧(.auditignoreで指定されたファイルは除外)
#      ※実行したディレクトリ以下のファイルのみが対象
# を取得し、jq で JSON-RPC リクエストを生成して標準出力に表示します。
# 実行途中で進捗ログも表示します。
#

set -e

########################################
# 設定
########################################
MCP_PORT=3000 # デフォルトポート番号
HTTP_MODE=false # HTTPモードフラグ
SEND_REQUEST=false # リクエスト送信フラグ
TEMP_JSON_FILE="/tmp/audit_request_$$.json" # 一時ファイル（$$はプロセスID）
AUDIT_IGNORE_FILE=".auditignore" # 監査除外ファイル設定
CURRENT_DIR=$(pwd) # 現在のディレクトリを保存

# 終了時に一時ファイルを削除
cleanup() {
  [ -f "$TEMP_JSON_FILE" ] && rm -f "$TEMP_JSON_FILE"
}
trap cleanup EXIT

########################################
# 引数の解析
########################################
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--http)
      HTTP_MODE=true
      # 次の引数がポート番号の場合は取得
      if [[ $# -gt 1 && "$2" =~ ^[0-9]+$ ]]; then
        MCP_PORT="$2"
        shift
      fi
      ;;
    --send)
      SEND_REQUEST=true
      ;;
    *)
      # 引数は無視
      ;;
  esac
  shift
done

########################################
# 1. ログ表示ヘルパー関数
########################################
info() {
  echo -e "[INFO] $*"
}

error() {
  echo -e "[ERROR] $*" >&2
}

########################################
# 2. task_list.txtから修正内容を読み込む
########################################
info "task_list.txtから修正内容を読み込みます..."
if [ ! -f "task_list.txt" ]; then
  error "task_list.txtが存在しません。task_list.txtを作成してください。"
  exit 1
fi

modificationDescription="$(cat task_list.txt)"
if [ -z "$modificationDescription" ]; then
  error "task_list.txtの内容が空です。修正内容を記載してください。"
  exit 1
fi

info "task_list.txtから修正内容を読み込みました: $modificationDescription"

########################################
# 3. .auditignoreファイルを読み込む
########################################
ignore_patterns=()
if [ -f "$AUDIT_IGNORE_FILE" ]; then
  info ".auditignoreファイルを読み込みます..."
  while IFS= read -r line || [[ -n "$line" ]]; do
    # コメント行と空行をスキップ
    if [[ -n "$line" && ! "$line" =~ ^[[:space:]]*# ]]; then
      # 先頭と末尾の空白を削除
      trimmed_line=$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
      if [ -n "$trimmed_line" ]; then
        ignore_patterns+=("$trimmed_line")
      fi
    fi
  done < "$AUDIT_IGNORE_FILE"
  info "監査除外パターン: ${#ignore_patterns[@]}件読み込みました"
else
  info ".auditignoreファイルが見つかりません。すべてのファイルを監査対象とします。"
fi

########################################
# 4. 差分取得 (ステージング優先 + フォールバック)
########################################
info "Gitステージング差分を確認しています..."
diffCached="$(git diff --cached || true)"

if [ -n "$diffCached" ] && [ -n "$(echo "$diffCached" | tr -d '[:space:]')" ]; then
  info "ステージングされた差分を検出しました。"
  codeChanges="$diffCached"
else
  info "ステージング差分が見つからないため未ステージング差分を使用します..."
  codeChanges="$(git diff || true)"
fi

########################################
# 5. function_list.txtを読み込む
########################################
info "function_list.txt の内容を読み込みます..."
if [ -f "function_list.txt" ]; then
  functionList="$(cat function_list.txt)"
  info "function_list.txt を読み込みました。"
else
  functionList="// function_list.txtが見つかりません"
  info "function_list.txt は存在しません。"
fi

########################################
# 6. 変更ファイル一覧を取得
#    (ステージング + 未ステージング の両方をまとめて重複排除)
########################################
info "変更されたファイルの一覧を取得します..."
stagedFiles="$(git diff --cached --name-only || true)"
unstagedFiles="$(git diff --name-only || true)"

# まとめて sort -u で重複排除
combinedFiles="$(printf '%s\n%s\n' "$stagedFiles" "$unstagedFiles" | sort -u)"
# 上記で空行は消え、重複も除外される

# 絶対パスの現在のディレクトリを取得
currentAbsPath=$(realpath "$CURRENT_DIR")
info "現在のディレクトリ: $currentAbsPath"

# カレントディレクトリ以下のファイルのみをフィルタリング
currentDirFilesOnly=""
totalFileCount=0
currentDirFileCount=0

while IFS= read -r file; do
  if [ -n "$file" ]; then
    totalFileCount=$((totalFileCount + 1))
    
    # ファイルの絶対パスを取得
    fileAbsPath=$(realpath --relative-to="$currentAbsPath" "$(git rev-parse --show-toplevel)/$file" 2>/dev/null || echo "")
    
    # ファイルがカレントディレクトリ以下にあるか確認
    # fileAbsPathが空でない、かつ".."で始まらない場合
    if [ -n "$fileAbsPath" ] && [[ ! "$fileAbsPath" == \.\.$* ]] && [[ ! "$fileAbsPath" == /* ]]; then
      # 現在のディレクトリ以下
      if [ -n "$currentDirFilesOnly" ]; then
        currentDirFilesOnly+=$'\n'
      fi
      currentDirFilesOnly+="$file"
      currentDirFileCount=$((currentDirFileCount + 1))
    fi
  fi
done <<< "$combinedFiles"

info "リポジトリ全体の変更ファイル: $totalFileCount 件"
info "現在のディレクトリ以下の変更ファイル: $currentDirFileCount 件"

# 現在のディレクトリ以下のファイルのみを対象とするよう変更
combinedFiles="$currentDirFilesOnly"

# .auditignoreで指定されたパターンに一致するファイルを除外
if [ ${#ignore_patterns[@]} -gt 0 ]; then
  # 一時ファイルにファイル一覧を保存
  tempFileList=$(mktemp)
  echo "$combinedFiles" > "$tempFileList"
  
  # 除外パターンを処理
  filteredFiles="$combinedFiles"
  excludedCount=0
  for pattern in "${ignore_patterns[@]}"; do
    # grepの-vオプションで、パターンに一致しない行だけを残す
    # -Eは拡張正規表現を使用、-xはline matchingを有効にする
    # 一度tmpファイルに書き出して再度読み込む処理を挟む
    beforeCount=$(echo "$filteredFiles" | wc -l)
    filteredFiles=$(echo "$filteredFiles" | grep -v -E "$pattern" || echo "")
    afterCount=$(echo "$filteredFiles" | wc -l)
    excludedCount=$((excludedCount + (beforeCount - afterCount)))
  done
  combinedFiles="$filteredFiles"
  
  # 一時ファイルを削除
  rm -f "$tempFileList"
  
  info "監査除外: $excludedCount 件のファイルを除外しました"
fi

# 正確なファイル数を数える
count=0
while read -r line; do
  [ -n "$line" ] && count=$((count + 1))
done <<< "$combinedFiles"

info "監査対象ファイル数: $count"

# 監査対象ファイルがない場合は警告
if [ $count -eq 0 ]; then
  info "警告: 監査対象ファイルがありません。処理を続行します..."
fi

########################################
# 7. ファイルの差分を現在のディレクトリ以下のファイルのみに制限
########################################
if [ -n "$combinedFiles" ]; then
  info "差分をカレントディレクトリ以下のファイルに制限します..."
  
  # 元の差分を保存
  original_diff="$codeChanges"
  filtered_diff=""
  
  # 各ファイルごとに差分を抽出して結合
  while IFS= read -r file; do
    if [ -n "$file" ]; then
      # ファイルごとの差分を抽出
      file_diff=$(echo "$original_diff" | awk -v file="$file" '
        BEGIN { in_file = 0; file_diff = ""; }
        /^diff --git a\// {
          # 新しいファイルの開始
          in_file = 0;
          if ($3 == "b/"file || $2 == "a/"file) {
            in_file = 1;
            file_diff = file_diff $0 "\n";
          }
        }
        in_file == 1 { if ($0 !~ /^diff --git a\//) file_diff = file_diff $0 "\n"; }
        END { print file_diff; }
      ')
      
      # 抽出した差分を結合
      if [ -n "$file_diff" ]; then
        filtered_diff="${filtered_diff}${file_diff}"
      fi
    fi
  done <<< "$combinedFiles"
  
  # フィルタリングされた差分を使用
  if [ -n "$filtered_diff" ]; then
    codeChanges="$filtered_diff"
    info "差分を現在のディレクトリ以下のファイルに制限しました"
  else
    info "警告: カレントディレクトリ以下のファイルの差分が見つかりません"
  fi
fi

########################################
# 8. diff内容の確認
########################################
# diff --git a/path/to/file b/path/to/file パターンを抽出して
# 本当にchangedFilesに含まれるファイルだけの差分になっているか確認
info "差分内容を検証しています..."
diff_files=$(echo "$codeChanges" | grep -E "^diff --git" | sed -E 's/^diff --git a\/([^ ]+) b\/([^ ]+)$/\1/' || echo "")

diff_file_count=0
unexpected_files=""
while IFS= read -r diff_file; do
  if [ -n "$diff_file" ]; then
    diff_file_count=$((diff_file_count + 1))
    
    # combinedFilesにこのファイルが含まれているか確認
    if ! echo "$combinedFiles" | grep -q "^$diff_file$"; then
      if [ -n "$unexpected_files" ]; then
        unexpected_files+=$'\n'
      fi
      unexpected_files+="$diff_file"
    fi
  fi
done <<< "$diff_files"

# 想定外のファイルが差分に含まれている場合は警告
if [ -n "$unexpected_files" ]; then
  warning_count=$(echo "$unexpected_files" | wc -l)
  info "警告: 監査対象外なのに差分に含まれているファイルが $warning_count 件あります"
  info "以下のファイルは除外リストに含まれているか、カレントディレクトリ外ですが差分に含まれています:"
  echo "$unexpected_files" | while read -r ufile; do
    info "  - $ufile"
  done
  
  # 想定外のファイルの差分を除去
  info "監査対象外のファイルの差分を除去します..."
  filtered_diff=""
  current_file=""
  include_lines=true
  
  # 差分を1行ずつ処理して監査対象外のファイルの差分を除去
  while IFS= read -r line; do
    if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/(.+)$ ]]; then
      # 新しいファイルの差分が始まった
      file_path="${BASH_REMATCH[1]}"
      
      # このファイルが監査対象に含まれているか確認
      if echo "$combinedFiles" | grep -q "^$file_path$"; then
        include_lines=true
        current_file="$file_path"
        filtered_diff="${filtered_diff}${line}"$'\n'
      else
        include_lines=false
        current_file=""
      fi
    elif [ "$include_lines" = true ]; then
      # 監査対象ファイルの場合は差分に含める
      filtered_diff="${filtered_diff}${line}"$'\n'
    fi
  done <<< "$codeChanges"
  
  # フィルタリングされた差分を使用
  codeChanges="$filtered_diff"
  info "監査対象外のファイルの差分を除去しました"
fi

info "差分内のファイル数: $diff_file_count"
info "監査対象ファイル数: $count"

########################################
# 9. jqを使って JSON-RPC リクエストを生成
########################################
info "JSON-RPC リクエストを組み立てています..."

# changedFilesJson : ファイル一覧をJSON配列に変換
#   1行1ファイル => jq -R . で文字列としてパース => jq -s . で配列化
changedFilesJson="$(echo "$combinedFiles" | jq -R . | jq -s .)"

# - jq -n で空のJSONを初期化
# - --arg / --argjson で変数を埋め込む
requestJson="$(
  jq -n \
    --arg request "直近のコード変更の監査をお願いします" \
    --arg modDesc "$modificationDescription" \
    --arg codeChanges "$codeChanges" \
    --arg functionList "$functionList" \
    --argjson changedFiles "$changedFilesJson" \
    '{
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tool/audit",
       "params": {
         "request": $request,
         "modification_description": $modDesc,
         "code_changes": $codeChanges,
         "function_list": $functionList,
         "changed_files": $changedFiles
       }
     }'
)"

# 一時ファイルにJSON保存
echo "$requestJson" > "$TEMP_JSON_FILE"
info "JSON-RPC リクエストを生成しました。"

########################################
# 10. 結果を標準出力に表示
########################################
if [ "$HTTP_MODE" = true ]; then
  # HTTPモードの場合、curlコマンドを表示
  cat <<EOM

========================================================
HTTPサーバーへのリクエスト方法:

curlコマンドで以下を実行してください（一時ファイルを使用）:

curl -X POST http://localhost:${MCP_PORT}/ \\
  -H "Content-Type: application/json" \\
  -d @${TEMP_JSON_FILE}

または、以下をコピーして直接実行できます:

# 監査リクエスト送信
curl -X POST http://localhost:${MCP_PORT}/ \\
  -H "Content-Type: application/json" \\
  -d @${TEMP_JSON_FILE} | jq

========================================================

EOM

  # --sendオプションが指定されていれば直接送信
  if [ "$SEND_REQUEST" = true ]; then
    info "HTTPサーバーへリクエストを送信しています..."
    if ! command -v curl &> /dev/null; then
      error "curlコマンドが見つかりません。インストールしてください。"
      exit 1
    fi
    
    response=$(curl -s -X POST "http://localhost:${MCP_PORT}/" \
      -H "Content-Type: application/json" \
      -d @"${TEMP_JSON_FILE}")
    
    echo "========================================================"
    echo "サーバーからのレスポンス:"
    echo
    if command -v jq &> /dev/null; then
      # JSONの整形出力
      formatted_json=$(echo "$response" | jq '.')
      
      # aiReportフィールドの抽出を試みる
      ai_report=$(echo "$response" | jq -r '.result.aiReport // empty')
      
      if [ -n "$ai_report" ]; then
        # aiReportフィールドがある場合、そのフィールドだけ別途出力
        echo "$formatted_json" | jq 'del(.result.aiReport)'
        echo
        echo "========== 監査レポート =========="
        echo "$ai_report"
        echo "=================================="
      else
        # 通常のJSON出力
        echo "$formatted_json"
      fi
    else
      echo "$response"
    fi
    echo "========================================================"
    info "リクエストの送信が完了しました。"
  else
    info "処理が完了しました。上記のcurlコマンドをコピーして実行すると、HTTPサーバー(ポート:${MCP_PORT})へリクエストを送信できます。"
    info "--sendオプションを追加すると直接リクエストを送信できます: ./pre_audit.sh -h --send"
  fi

else
  # 通常モードの場合、JSON-RPCリクエストのみ表示
  cat <<EOM

========================================================
以下をコピーして監査サーバーに送信してください:

\`\`\`json
${requestJson}
\`\`\`
========================================================

EOM

  info "処理が完了しました。上記JSONをコピーして、MCPサーバー(tool/audit)へ送信できます。"
  info "HTTPサーバーへ直接送信する場合は ./pre_audit.sh -h または ./pre_audit.sh --http オプションを使用してください。"
  info "さらに --send オプションを追加すると自動的にHTTPリクエストを送信します。"
fi
