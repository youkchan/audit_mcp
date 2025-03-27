# コード監査サーバー

このサーバーは、コード変更の監査と整合性チェックを行うMCPサーバーです。リクエスト内容、修正内容の説明、コード変更、機能リストを入力として受け取り、それらの整合性をチェックします。また、.gitignoreに含まれるファイルの検出も行います。

## 主な機能

- 機能リストとコード変更の整合性チェック
- .gitignoreファイルに含まれるファイルの検出
- 監査レポートの生成と保存

## インストール方法

```bash
cd audits
npm install
npm run build
```

## 使用方法

### 簡素化された監査リクエスト

Cursorのチャットで、次のシンプルなコマンドで監査を依頼できます：

```
@audit 変更内容の説明
```

例えば：

```
@audit タグとcontentの修正を行いました
```

このコマンドを使用すると、AIは自動的に：
1. 最近の変更内容（git diff）を取得
2. function_list.txtの内容を読み込み
3. 変更されたファイルのリストを収集
4. これらの情報を組み合わせて適切な監査リクエストを生成して実行

これにより、手動で完全なリクエストを入力する必要がなくなります。

### 手動での監査リクエスト

完全なフォーマットで監査を依頼する場合は、以下のフォーマットを使用します：

```
以下のコード変更を監査してください：

リクエスト内容：「リクエストの説明」
修正内容：「実際に行った変更の説明」
コード変更：
```diff
// コード変更の差分
```

function_list.txtの内容：
```
// function_list.txtの内容
```
```

### サーバーの起動

```bash
npm start
```

### Cursorへの設定

Cursor内でMCPサーバーを利用するには、以下の設定を行います：

1. Cursorの設定を開く
2. "MCP Servers"セクションに移動
3. 新規サーバーを追加
   - 名前: `code-audit-server`
   - パス: `/path/to/clip-auto-maker/audits/dist/audit-server.js`
   - 有効化: オン

## 監査レポート

監査レポートは `audits/reports` ディレクトリに保存されます。各レポートには以下の情報が含まれます：

- リクエスト内容
- 修正内容の説明
- 機能の整合性チェック結果
- .gitignoreチェック結果（該当する場合）

## 開発者向け情報

### プロジェクト構造

- `audit-server.ts` - メインのサーバーコード
- `package.json` - 依存関係と設定
- `tsconfig.json` - TypeScript設定
- `reports/` - 生成された監査レポートの保存先
- `audit-command.md` - 監査コマンドの説明
- `auto-audit.js` - 監査を自動化するユーティリティスクリプト
- `ai-audit-handler.js` - AIが監査コマンドを処理するための指示

### 依存関係

- `@modelcontextprotocol/sdk` - MCPサーバー実装用SDK
- `chalk` - コンソール出力の色付け
- `zod` - スキーマ検証
- `@types/node` - Node.js型定義
- `typescript` - TypeScript開発用

### スクリプト

- `npm run build` - TypeScriptをビルド
- `npm run dev` - 開発モードで実行（ファイル変更を監視）
- `npm start` - ビルド済みサーバーを起動 