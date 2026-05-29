const cheerio = require('cheerio');
const { URL } = require('url');

function scrape(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe').remove();

  const title = $('title').first().text().trim();

  const metaDescription =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const text = $(el).text().trim();
    if (text) headings.push({ level: el.tagName.toLowerCase(), text });
  });

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    try {
      images.push({ src: new URL(src, pageUrl).href, alt: $(el).attr('alt') || '' });
    } catch {
      // skip malformed src
    }
  });

  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      links.push({ href: new URL(href, pageUrl).href, text: $(el).text().trim() });
    } catch {
      // skip malformed href
    }
  });

  return {
    url: pageUrl,
    crawledAt: new Date().toISOString(),
    title,
    metaDescription,
    headings,
    bodyText,
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    images,
    links,
  };
}

module.exports = { scrape };
