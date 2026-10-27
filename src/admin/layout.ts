import { type Html, html } from './html.ts';

type LayoutOptions = {
  title: string;
  /** Who is signed in, if anyone */
  user?: string | undefined;
  body: Html;
};

export const layout = ({ title, user, body }: LayoutOptions) => html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · LDaCA admin</title>
</head>
<body>
  <header>
    <p>LDaCA admin</p>
    ${
      user &&
      html`<p>Signed in as ${user}</p>
    <form method="post" action="/admin/sign-out"><button type="submit">Sign out</button></form>`
    }
  </header>
  <main>
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
