// fire-config.sample.js
// このファイルをコピーして `fire-config.js` を作成し、以下の2つの項目を正しく設定してください。
// `fire-config.js` は .gitignore によってGitリポジトリには含まれません。

const PRIVATE_CONFIG = {
    // 1. GASのウェブアプリケーションURL
    GAS_URL: "https://script.google.com/macros/s/ここにあなたのGASのURLを貼る/exec",

    // 2. 認証用APIキー (自分で決めた秘密の文字列)
    // このキーは、後述するGASのスクリプトプロパティにも同じ値を設定する必要があります。
    API_KEY: "ここに自分で決めた秘密のAPIキーを設定する"
};