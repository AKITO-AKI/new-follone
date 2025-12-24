# follone 技術指南書（引き継ぎ用）

最終更新: 2025-12-23  
対象: Chrome 拡張（MV3）「follone / X content safety assistant」 v0.4.36-a

---

## 1. 目的と現状

### 目的
- X（x.com）のタイムライン上の投稿を収集し、一定件数（バッチ）ごとに **Prompt API（Chrome LanguageModel API）** で分類。
- 「危険度」「偏り」などの指標に応じて投稿カードを強調表示（スポットライト／ラベル／進捗UI）する。

### 現状（既知の不安定点）
- Prompt API 側の **UnknownError / timeout** が発生すると、content.js 側が `fallback to mock` に落ちることがある。
- 以前のログに出ていた警告:
  - `No output language was specified in a LanguageModel API request ...`
- v0.4.36-a では、**outputLanguage 指定**と **offscreen 側のハードタイムアウト**、および **generic failure 判定**を追加し、content 側のタイムアウト（`timeout`）を減らす狙い。

---

## 2. ディレクトリ構成（拡張フォルダ直下）

- `manifest.json`  
  MV3 定義。permissions / host_permissions / content_scripts / offscreen_document / options_page など。
- `content.js`  
  X ページ内で動作するコンテンツスクリプト。投稿DOM監視、バッチ生成、SWへ分類要求、UI反映、ログ出力。
- `sw.js`  
  サービスワーカー。offscreen の起動保証・中継（content → offscreen）。
- `offscreen.html` / `offscreen.js`  
  Prompt API 実行環境。セッション管理（create / destroy）、分類（JSON schema 返答制約）、診断情報返却。
- `overlay.css`  
  画面右下のウィジェット、スポットライト、ローダー等のスタイル。
- `options.html` / `options.js` / `options.css`  
  設定UI（有効化・デバッグ・ログレベル・バッチサイズ・テキスト上限等）と診断表示（Prompt API availability/hasSession/lastError）。

---

## 3. 処理フロー（ざっくり）

### A. 投稿収集（content.js）
1. DOM 監視（MutationObserver / IntersectionObserver）で投稿カード（article）を抽出
2. 投稿テキストをクリーニングし、重複排除しつつキューに投入
3. キューが `batchSize` に達する or アイドル復帰で **分類バッチ** を生成

### B. 分類要求（content.js → sw.js）
- `chrome.runtime.sendMessage({ type: 'FOLLONE_CLASSIFY_BATCH', batch, topicList })`

### C. 中継・offscreen 起動保証（sw.js）
1. offscreen document が無ければ `chrome.offscreen.createDocument(...)` を実行
2. offscreen に `FOLLONE_OFFSCREEN_CLASSIFY` を送信
3. offscreen の結果を content.js に返す

### D. Prompt API 実行（offscreen.js）
1. `LanguageModel.capabilities()` で availability を確認
2. `LanguageModel.create(...)` でセッション生成
3. `session.prompt(prompt, { responseConstraint: schema, outputLanguage:'ja', ... })`
4. 結果 JSON をパースして返却

### E. UI反映（content.js）
- 返却された `risk` 等の値に応じて、投稿にクラス付与／スポットライト表示／ウィジェット数値更新。

---

## 4. メッセージ仕様（主要）

### content → sw
- `FOLLONE_BACKEND_STATUS` : バックエンド（Prompt API）状況照会
- `FOLLONE_WARMUP` : Prompt API セッション作成（ウォームアップ）
- `FOLLONE_CLASSIFY_BATCH` : 投稿バッチ分類

### sw → offscreen
- `FOLLONE_OFFSCREEN_STATUS`
- `FOLLONE_OFFSCREEN_WARMUP`
- `FOLLONE_OFFSCREEN_CLASSIFY`

### 典型的なレスポンス（概略）
- 成功: `{ ok: true, ... }`
- 失敗: `{ ok: false, error: '...' }`

---

## 5. デバッグ手順（最短ルート）

### 5.1 Xページ側（content.js）
- X を開いたタブで DevTools → Console
- `[follone]` でフィルタしてログを確認

### 5.2 サービスワーカー（sw.js）
- `chrome://extensions` → 「follone」→ Service worker の「検証（Inspect）」  
- ここで offscreen 作成や中継のエラーを見る

### 5.3 offscreen（offscreen.js）
- `chrome://extensions` → 「follone」→ 「Inspect views」 から offscreen.html を開く  
- Prompt API の警告／例外／session の作成可否を見る

### 5.4 options 診断
- Options 画面の「診断」欄:
  - Prompt API availability / Backend status / hasSession / lastError
- ここが最も現場向きの一次情報。

---

## 6. 代表的なエラーと意味（対処の当たり）

### A) `No output language was specified ...`
- LanguageModel API リクエストで outputLanguage が未指定。
- **v0.4.36-a で prompt 呼び出しに `outputLanguage:'ja'` を付与**して抑制する想定。

### B) `UnknownError: Other generic failures occurred.`
- Prompt API 内部の包括エラー（理由が潰れているタイプ）。
- 対処:
  - offscreen 側で **session 再生成**（v0.4.36-a で1回だけ自動リトライ）
  - 連発する場合は batchSize とテキスト上限を下げる（負荷低減）

### C) content 側ログ: `Prompt classify failed; fall back to mock timeout`
- content → sw の応答が一定時間内に返らなかった。
- 原因の候補:
  - offscreen で prompt がハング／長時間化
  - SW が例外で sendResponse に到達しない
- 対処:
  - v0.4.36-a の **offscreen 側ハードタイムアウト**で「応答が返らない状態」を減らす
  - batchSize / textLimit を一時的に小さく

### D) `The AudioContext was not allowed to start`
- X 側のオートプレイ規制に関する警告。follone 本体の致命傷ではない（無視でOK）。

### E) `ERR_CONNECTION_TIMED_OUT`（video.twimg.com 等）
- X 側のネットワークエラー。分類機能とは別系統。

---

## 7. 「ログが更新されない」時に見るべき観点

1. **debug が OFF** になっていないか（Options）
2. content.js の状態が `inFlight=true` のまま固まっていないか  
   - 「最後に出たログ」が `classify` の直前で止まっていれば、SW/offscreen 側で詰まっている可能性が高い
3. SW Inspector で例外が出ていないか
4. offscreen Inspector で prompt 実行が連続失敗していないか（lastError）

---

## 8. 次に送るべき情報（トラブル時のテンプレ）

次のチャット／報告に貼ると解析が早いです。

1. **Options 診断のスクショ**（availability / hasSession / lastError が見える状態）
2. **Xタブの Console ログ（[follone] でフィルタ）**の該当部分
3. **Service worker の Console ログ**
4. **offscreen の Console ログ**
5. 発生手順（例: 起動→AI起動→スクロール→何分で止まる、など）

---

## 9. TODO（改善ロードマップ案）

- Prompt API の **AbortSignal 対応**（APIが許す場合）で真のキャンセルを実装
- 「inFlight 固着」検出のための **heartbeat/ watchdog** を content に追加
- Prompt の短縮（余計な文脈削減）と JSON schema の簡略化
- 投稿ID（URL/時刻/ユーザー名等）をキーにした **キャッシュ**で再分類を抑制

---

## 付録: バージョン
- 推奨: **v0.4.36-a**（このガイドに同梱）
- 旧: v0.4.35-a（outputLanguage 未指定や offscreen 側の不備で不安定になり得る）
