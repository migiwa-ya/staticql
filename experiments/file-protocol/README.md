# StaticQL `file://` デモ

この実験用デモは、StaticQL のクエリ結果をローカルの静的 JavaScript ファイルから読み込みます。HTTP サーバーは使いません。

## 前提

- リポジトリの通常の開発環境が用意されていること（clone 後に `npm ci` 済み）。デモの生成と表示はネットワークや資格情報を使いません。
- Chromium は自動確認コマンド `demo-check.ts` のみで使います。自分のブラウザでデモを見るときは Chromium 以外でも構いません。

## 手順

1. リポジトリのルートで次のコマンドを実行します。

   ```sh
   npx --no-install tsx experiments/file-protocol/demo.ts
   ```

2. 生成された `.cache/file-protocol-demo/index.html` をブラウザで開きます。ファイルをダブルクリックするか、ブラウザにドラッグしてください。

出力先を変更する場合は、リポジトリ内の空のディレクトリを指定できます。

```sh
npx --no-install tsx experiments/file-protocol/demo.ts .cache/my-file-protocol-demo
```

従来の manifest 方式と比較するには、別の空ディレクトリを指定して `--manifest` を付けます。生成後、その `index.html` をブラウザで開いてください。

```sh
npx --no-install tsx experiments/file-protocol/demo.ts .cache/file-protocol-demo-manifest --manifest
```

既定の出力先を含め、出力先ディレクトリが空でない場合は生成を拒否します。中身を確認してから手動で削除するか、別の空ディレクトリを指定してください。リポジトリ外、リポジトリルート、外部へ抜けるシンボリックリンクは出力先にできません。

## 画面の見方

- ページ上部にブラウザの User-Agent と `location.protocol` が表示されます。ローカルで開くと protocol は `file:` です。
- 不在判定方式も表示されます。既定では `lenient`、`--manifest` 付きの生成では `manifest` です。`lenient` では読み込めなかったファイルを不在とみなすため、実在するファイルが読めなくても結果が欠落することがあります。
- 「実行」を押すと、herbs の `name` 検索、`nameUpper` カスタムインデックス検索、herbs を join した recipes 検索を順に実行します。
- 各行には slug の結果、生成時に `FsRepository` で得た結果との一致、読み込んだ script の数と一覧が出ます。script 一覧を展開するとパスを確認できます。
- クエリ実行中の payload 読み込みに失敗した場合は、エラー名・メッセージ・cause のメッセージを赤字で表示します。manifest 方式では「不在」は manifest にないファイル、「その他」は manifest にあるのに読み込めないファイルなどです。最初に読み込む `expected.js` / `demo-entry.js` の失敗では、`file://` では不在と読み取り不可を区別できない旨を表示します。

## 不在判定について

既定の `lenient` 方式では、読み込めなかったパスを不在とみなします。そのため、権限・パス・ファイル同期の問題などで実在するファイルが読めない場合も、エラーにならず検索結果が欠落することがあります。これは `StorageRepository` の契約である「確定した不在だけを `NotFoundError` とする」挙動に対する、この file:// デモ内の例外です。結果の欠落に気付く手掛かりは画面の `FsRepository` との比較です。

従来の manifest 方式は `--manifest` オプションで利用できます。manifest は論理ファイル数と path 長に応じて増加します。PR #81 の測定データでは約 40 B/ファイルでしたが、全データに共通する定数ではなく、数万ファイル規模は未検証です。

## Firefox / Safari で確認する場合

このデモは Firefox と Safari では未検証です。どちらかで開いた場合は、Issue #41 に次の点を報告してください。

- 最初の表示と「実行」ボタンの動作
- 3 行それぞれの結果が `FsRepository` と一致するか
- 各行の読み込みファイル数と、画面に出たエラー内容
- ブラウザ名・バージョンと OS

## フォルダを zip で共有する場合

生成された `.cache/file-protocol-demo/` フォルダ全体を zip にし、受け取った人は展開したフォルダ内の `index.html` を直接開きます。フォルダ内の相対参照を保つため、`index.html` だけを共有しないでください。

## 範囲と未検証項目

これは Issue #41 の検証用実験コードで、公開 API や本採用機能ではありません。次はこのデモの範囲外です。

- E1: `ScriptRepository` の改名はしません。名前が他の Repository の規則に合うかは未決のままです。
- E2: Wiki は更新しません。本採用の決定時まで Wiki に lenient の注意点は載らず、今回は README と Issue #41 のみです。
- E3: 公開 API、`exports`、`src/` への移設、payload 生成 CLI、書き込み対応はしません。
- E4: Firefox / Safari の動作確認はしません。
- E5: lenient で実在するのに読めないファイルをエラーとして検知する仕組み(件数の報告など)は追加しません。実際の利用で結果の欠落に気付ける保証はありません。
- E6: 既存 `run.ts` の挙動は変更しません(絶対パスのハードコードは #88 の扱いです)。
- E7: `expected.js` / `demo-entry.js` の失敗時に不在と読み取り不可を区別しません。`file://` の制約により区別できない旨を画面に表示します。

既存の feasibility prototype は引き続き `run.ts` を使います。このデモはその手順を変更しません。
