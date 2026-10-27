import { type Html, html } from './html.ts';

type LayoutOptions = {
  title: string;
  /** Who is signed in, if anyone */
  user?: string | undefined;
  body: Html;
  /** More of the `<head>`, such as a refresh */
  head?: Html | undefined;
};

export const layout = ({ title, user, body, head }: LayoutOptions) => html`<!DOCTYPE html>
<html lang="en" class="bg-zinc-100 text-zinc-900 antialiased">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · LDaCA admin</title>
  <link rel="stylesheet" href="/admin/admin.css">
  <script src="/admin/admin.js" defer></script>
  ${head}
</head>
<body class="min-h-screen font-sans">
  <header class="border-b-4 border-amber-400 bg-zinc-900 text-zinc-100">
    <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-3">
      <p class="flex items-center gap-3 font-semibold tracking-wide">
        LDaCA
        <span class="rounded bg-amber-400 px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-widest text-zinc-900">Admin</span>
      </p>
      ${
        user &&
        html`<div class="flex items-center gap-4 text-sm">
        <p class="text-zinc-400">Signed in as <span class="font-medium text-zinc-100">${user}</span></p>
        <form method="post" action="/admin/sign-out"><button type="submit" class="cursor-pointer rounded border border-zinc-600 px-3 py-1 hover:border-amber-400 hover:text-amber-400">Sign out</button></form>
      </div>`
      }
    </div>
  </header>
  <main class="mx-auto max-w-5xl px-6 py-8">
    <h1 class="mb-6 text-2xl font-bold tracking-tight">${title}</h1>
    ${body}
  </main>
</body>
</html>`;
