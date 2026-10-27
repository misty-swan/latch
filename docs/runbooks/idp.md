# 本番IdP(Google/Apple)手順書

LATCHのサインインと退会の本人確認は、GoogleかAppleのアカウントで行う(IdP=ログインを引き受けてくれる外部のサービス)。この手順書は、本番で使えるようにするためにオーナーがGoogleとAppleの管理画面で行う作業と、得た値をLATCHに渡す方法をまとめる。仕組みは04 §4(「画面側のIdP接続」)。

この手順書では、本番の公開のドメインを`<公開のドメイン>`(例: `latch.example.jp`。`https://`は付けない)と書く。

## 1. しくみの要点(作業の前に)

- ボタンを押すと、同じタブでGoogleかAppleのログイン画面へ移り、終わると`https://<公開のドメイン>/auth/callback`へ戻ってくる。この戻り先のURLを、GoogleとAppleの両方に**一字一句同じに**登録する(違うと、ログイン画面がエラーを出して戻ってこない)
- LATCHが受け取るのは、本人であることを示す「IDトークン」だけ。名前・メールアドレスは求めない
- GoogleとAppleから受け取る値は**クライアントID**(公開してよい識別子)だけ。Googleの「クライアントシークレット」とAppleの秘密鍵(.p8)は使わないので、作らない・控えない
- 同じクライアントIDを、画面(ビルド時の環境変数)とWorker(サーバー)の2か所に入れる。片方だけだとサインインが失敗する

| 入れる先 | Google | Apple |
|---|---|---|
| 画面(ビルド時の環境変数) | `VITE_GOOGLE_CLIENT_ID` | `VITE_APPLE_CLIENT_ID` |
| Worker(本番の変数) | `GOOGLE_CLIENT_ID` | `APPLE_CLIENT_ID` |

画面側は、クライアントIDが入っていないIdPのボタンを出さない。片方だけ先に用意して公開することもできる。

## 2. Google(Google Cloud)

Google Cloudの管理画面(console.cloud.google.com)で行う。

1. **プロジェクトを選ぶか作る**: 画面上部のプロジェクト選択で、LATCH用のプロジェクトを選ぶ(無ければ「新しいプロジェクト」で作る)
2. **同意画面(Google Auth Platform)を設定する**: 左のメニューの「APIとサービス」→「OAuth同意画面」(「Google Auth Platform」と表示されることがある)
   - ブランディング: アプリ名`LATCH`・サポートのメールアドレス・アプリのホームページ`https://<公開のドメイン>/`・プライバシーポリシー`https://<公開のドメイン>/privacy`・利用規約`https://<公開のドメイン>/terms`・承認済みドメインに`<公開のドメイン>`の親ドメイン
   - 対象(Audience): 「外部」。公開の前に「本番環境に公開」にする(「テスト」のままだと、登録したテストユーザーしかログインできない)
   - スコープ(データへのアクセス): 何も足さない(LATCHが使う`openid`は審査の要らない基本の範囲)
3. **クライアントIDを作る**: 「クライアント」(または「認証情報」→「認証情報を作成」→「OAuthクライアントID」)
   - アプリケーションの種類: 「ウェブアプリケーション」
   - 名前: `LATCH web`(管理用の名前で、利用者には見えない)
   - 承認済みのJavaScript生成元: `https://<公開のドメイン>`
   - 承認済みのリダイレクトURI: `https://<公開のドメイン>/auth/callback`
4. 作成後に表示される**クライアントID**(`…apps.googleusercontent.com`で終わる値)を控える。クライアントシークレットは使わない

## 3. Apple(Apple Developer)

Apple Developerの管理画面(developer.apple.com/account)で行う。Apple Developer Program(有料)の登録が要る。

1. **App IDを用意する**: 「Certificates, Identifiers & Profiles」→「Identifiers」→「+」→「App IDs」→「App」
   - Bundle ID: 例`jp.example.latch`(逆順のドメイン形式。後から変えられない)
   - Capabilitiesで「Sign In with Apple」に印を付けて登録する
2. **Services IDを作る**: 「Identifiers」→「+」→「Services IDs」
   - Description: `LATCH`(Appleのログイン画面に出る名前)
   - Identifier: 例`jp.example.latch.web`(App IDとは別の値にする)。**これがAppleのクライアントIDになる**
3. **Services IDにドメインと戻り先を登録する**: 作ったServices IDを開き、「Sign In with Apple」に印を付けて「Configure」
   - Primary App ID: 1で作ったApp ID
   - Domains and Subdomains: `<公開のドメイン>`(`https://`は付けない)
   - Return URLs: `https://<公開のドメイン>/auth/callback`
   - 保存する(「Continue」→「Save」)
4. **ドメインの確認**: 画面がドメインの確認用ファイル(`apple-developer-domain-association.txt`)の配置を求めた場合だけ、そのファイルを受け取り、作業員に渡す(`https://<公開のドメイン>/.well-known/apple-developer-domain-association.txt`で配れるようにする作業が別に要る)。求められなければ何もしない
5. 2のIdentifier(Services ID)を控える。鍵(Keys)の作成は要らない

Appleの戻り先は`https://`で始まる公開のドメインに限られ、手元(`localhost`)では試せない。手元とstagingでは、テスト用サインイン(`VITE_DEV_AUTH=1`)を使う。

## 4. LATCHに値を渡す

控えたクライアントIDを、作業員(またはデプロイの手順)に渡す。値そのものは公開してよい識別子だが、この手順書やコミットには書かない。

1. **Worker**: 本番のWorkerに`GOOGLE_CLIENT_ID`・`APPLE_CLIENT_ID`を設定する(本番の手順は`docs/runbooks/prod.md`)。設定し忘れると、そのIdPでのサインインは一律に失敗する(サーバーは設定の欠落を認証の失敗として扱う・04 §4)
2. **画面**: 本番の画面をビルドするときに`VITE_GOOGLE_CLIENT_ID`・`VITE_APPLE_CLIENT_ID`を環境変数で渡す。本番のビルドには`VITE_DEV_AUTH`を付けない(付けると、ボタンがテスト用サインインに繋がる)
   ```bash
   VITE_GOOGLE_CLIENT_ID=<GoogleのクライアントID> VITE_APPLE_CLIENT_ID=<AppleのServices ID> pnpm --filter web build
   ```
   (`apps/web/dist`に本番の画面ができる。クライアントIDは画面のファイルに埋め込まれる)
3. 本番のWorkerにテスト用の鍵(`LATCH_TEST_IDP_JWKS`)が入っていないことを確かめる(入っていると起動が拒否される・04 §4)

## 5. 確かめる

公開の後(または公開と同じドメインで)、次を順に確かめる。

1. サインインの画面に「Googleで続ける」「Appleで続ける」が出る(出ないボタンは、画面のビルドにクライアントIDが入っていない)
2. それぞれで新しいアカウントを作り、登録の画面まで進む。登録・同意を終えてホームに着く
3. 一度ログアウトし、同じアカウントで入り直すとホームに着く(登録の画面に戻らない)
4. 「自分」→退会で、サインインに使ったIdPのボタン(「Googleで確かめて退会する」または「Appleで確かめて退会する」)が出る。押して確かめると「退会しました。」が出る
5. IdPの画面で取り消すと、元の画面に戻り、エラーの一言は出ない

うまくいかないときの目安:

| 症状 | よくある原因 |
|---|---|
| GoogleやAppleの画面で「redirect_uri_mismatch」「invalid_request」 | 戻り先のURLの登録が`https://<公開のドメイン>/auth/callback`と一字一句同じでない |
| IdPから戻ると「認証に失敗しました」 | Workerの`GOOGLE_CLIENT_ID`/`APPLE_CLIENT_ID`が未設定か、画面のビルドと違う値 |
| Googleで、自分以外がログインできない | 同意画面の対象が「テスト」のまま |
| 戻ると「確かめられませんでした」 | 出発から10分以上たった・別のタブで出発した(出発の控えはそのタブだけに置く)。もう一度ボタンから始める |
