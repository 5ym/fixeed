# fixeed

[goonews.jp の RSS](https://www.goonews.jp/rss/rssall.xml) は日付が壊れているため、
定期的に取得して修正し、GitHub Pages で再配信するプロジェクトです。

## 壊れている箇所と修正内容

元フィードは RSS 1.0 (RDF) だが、日付フィールドが壊れている:

| 要素 | 壊れた値 | 修正後 |
| --- | --- | --- |
| `<updated>` | `Thu, 16 Jul 2026 18:00:10 +09001784192410` | `Thu, 16 Jul 2026 18:00:10 +0900` |
| `<dc:date>` (当日記事) | `17時39分T+09:00` | `2026-07-16T17:39:00+09:00` |
| `<dc:date>` (過去記事) | `07月15日T+09:00` | `2026-07-15T00:00:00+09:00` |

- `<updated>`: タイムゾーン `+0900` の直後に Unix タイムスタンプが連結されたゴミを除去。
- `<dc:date>`: ISO8601 テンプレートに日本語の相対日付が埋め込まれて壊れている。
  時刻のみ (`HH時MM分`) は当日、月日のみ (`MM月DD日`) は当年として補完し、
  W3CDTF (ISO8601) に変換する。

基準時刻には `<updated>` の値を使うため、**同じ入力なら同じ出力**（冪等）になる。

## 使い方

ランタイム依存無し ([Bun](https://bun.sh) で TypeScript を直接実行)。

```sh
# URL から取得して public/rssall.xml に出力
bun fix-rss.ts

# ローカルファイルを修正して標準出力へ
bun fix-rss.ts -i broken.xml -o -

# 出力先を指定
bun fix-rss.ts -o dist/feed.xml
```

## 自動更新 (GitHub Actions)

[.github/workflows/fix-rss.yml](.github/workflows/fix-rss.yml) が
毎時フィードを取得・修正し、GitHub Pages にデプロイする。

### 初回セットアップ

1. このリポジトリを GitHub に push する。
2. リポジトリの **Settings → Pages → Build and deployment → Source** を
   **GitHub Actions** に設定する。
3. **Actions** タブからワークフローを手動実行 (Run workflow) するか、
   毎時の cron を待つ。

公開後の購読 URL: `https://<ユーザー名>.github.io/fixeed/rssall.xml`
