<?xml version="1.0" encoding="UTF-8"?>
<!-- Renders feed.xml as a readable page when opened directly in a browser
     (feed readers ignore the xml-stylesheet PI and parse the RSS as-is). -->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output method="html" encoding="UTF-8" indent="no"/>

<xsl:template match="/rss/channel">
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title><xsl:value-of select="title"/></title>
<link rel="icon" href="data:image/svg+xml,&lt;svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'&gt;&lt;text y='.9em' font-size='90'&gt;&#9834;&lt;/text&gt;&lt;/svg&gt;"/>
<link rel="stylesheet" href="/assets/fonts.css"/>
<style>
:root {
  --bg: #f5f2ed; --surface: #faf8f5; --text: #1a1916; --muted: #5c584f;
  --border: #dedad3; --accent: #2c4a3e; --accent-light: #e8efe8; --player-bg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17150f; --surface: #201d16; --text: #ece7dc; --muted: #a49b8b;
    --border: #363126; --accent: #8fb9a4; --accent-light: #232e28; --player-bg: #201d16;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text);
  min-height: 100vh; font-size: 15px; line-height: 1.6;
}
header {
  padding: 4rem 2rem 3rem; text-align: center;
  border-bottom: 1px solid var(--border); background: var(--surface);
}
.eyebrow {
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 1.2rem;
}
h1 {
  font-family: 'DM Serif Display', serif; font-size: clamp(2rem, 5vw, 3.2rem);
  font-weight: 400; letter-spacing: -0.02em; color: var(--text);
}
h1 em { font-style: italic; color: var(--accent); }
.tagline { margin-top: 1rem; font-size: 14px; color: var(--muted); font-weight: 300; }
.notice {
  max-width: 640px; margin: 2rem auto 0; padding: 0.9rem 1.2rem;
  background: var(--accent-light); border-radius: 6px; font-size: 13px;
  color: var(--muted); font-weight: 300; line-height: 1.6;
}
.notice a, .tagline a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent); }
.notice code {
  font-size: 12px; background: var(--player-bg); border: 1px solid var(--border);
  padding: 0.1em 0.4em; border-radius: 3px;
}
main { max-width: 720px; margin: 0 auto; padding: 3rem 2rem 6rem; }
.item-list {
  border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--player-bg);
}
.item {
  display: block; padding: 1rem 1.4rem; text-decoration: none; color: inherit;
  border-top: 1px solid var(--border);
}
.item:first-child { border-top: none; }
.item:hover { background: var(--accent-light); }
.item-date {
  font-size: 12px; color: var(--muted); font-weight: 500;
  font-variant-numeric: tabular-nums; display: block; margin-bottom: 0.3rem;
}
.item-title { font-size: 14px; color: var(--text); font-weight: 400; line-height: 1.5; }
.item:hover .item-title { color: var(--accent); }
footer {
  text-align: center; padding: 2.5rem; border-top: 1px solid var(--border);
  font-size: 12px; color: var(--muted); background: var(--surface);
}
footer a { color: var(--accent); text-decoration: none; }
footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <p class="eyebrow">RSS Feed</p>
  <h1>The <em>Hannan</em> Tapes</h1>
  <p class="tagline">
    <xsl:value-of select="description"/><br/>
    <a href="/updates/">View the Updates page</a> &#183; <a href="/">Back to the archive</a>
  </p>
  <p class="notice">
    You're viewing the RSS feed's raw XML rendered for readability. Point a feed reader at
    this URL (<code>https://renedebos.com/feed.xml</code>) to subscribe, or use the links above
    to browse the site directly.
  </p>
</header>
<main>
  <div class="item-list">
    <xsl:for-each select="item">
      <a class="item">
        <xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>
        <span class="item-date"><xsl:value-of select="substring(pubDate, 6, 11)"/></span>
        <span class="item-title"><xsl:value-of select="title"/></span>
      </a>
    </xsl:for-each>
  </div>
</main>
<footer>
  Part of <a href="/">The Hannan Tapes</a> archive
</footer>
</body>
</html>
</xsl:template>
</xsl:stylesheet>
