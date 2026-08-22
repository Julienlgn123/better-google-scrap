import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Browser pool ──────────────────────────────────────────────────────────────
// Plusieurs instances Chromium peuvent tourner en parallèle. Chaque scrape
// réserve un "slot" : on remplit d'abord les browsers déjà ouverts (jusqu'à
// MAX_TABS_PER_BROWSER onglets chacun) et on n'en lance un nouveau que si
// tous les browsers existants sont pleins — dans la limite de MAX_BROWSERS.
// Les browsers ne sont donc ouverts qu'"en cas de besoin".

const MAX_TABS_PER_BROWSER = parseInt(process.env.MAX_TABS_PER_BROWSER) || 10;
const MAX_BROWSERS = parseInt(process.env.MAX_BROWSERS) || 5;

// browserPool[i] = { browser, activeTabs, ready }
const browserPool = [];

async function launchBrowser(entry) {
  console.log(`[browser] Launching Chromium instance (${browserPool.length}/${MAX_BROWSERS})...`);
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--window-size=1280,900',
        '--lang=fr-FR,fr',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    entry.browser = browser;
    browser.on('disconnected', () => {
      console.log('[browser] Instance disconnected — removing from pool');
      const idx = browserPool.indexOf(entry);
      if (idx !== -1) browserPool.splice(idx, 1);
    });

    return browser;
  } catch (err) {
    console.error('[browser] Failed to launch instance:', err.message);
    const idx = browserPool.indexOf(entry);
    if (idx !== -1) browserPool.splice(idx, 1);
    throw err;
  }
}

async function prewarmBrowser() {
  const entry = { browser: null, activeTabs: 0, ready: null };
  browserPool.push(entry);
  entry.ready = launchBrowser(entry);
  try {
    await entry.ready;
    console.log(`[browser] Chromium prêt ✅ (pool: 1/${MAX_BROWSERS})`);
  } catch (err) {
    console.error('[browser] Échec du démarrage de Chromium :', err.message);
  }
}

function poolStatus() {
  return {
    browsersOpen: browserPool.length,
    maxBrowsers: MAX_BROWSERS,
    maxTabsPerBrowser: MAX_TABS_PER_BROWSER,
    maxConcurrentTabs: MAX_BROWSERS * MAX_TABS_PER_BROWSER,
    activeTabs: browserPool.reduce((sum, e) => sum + e.activeTabs, 0),
  };
}

// ─── Slot allocator — remplit les browsers existants avant d'en ouvrir un nouveau
async function acquireSlot() {
  while (true) {
    // Browser déjà ouvert (ou en cours de lancement) avec de la place — on
    // prend le plus rempli pour ne laisser un browser vide qu'en dernier recours.
    let entry = browserPool
      .filter((e) => e.activeTabs < MAX_TABS_PER_BROWSER)
      .sort((a, b) => b.activeTabs - a.activeTabs)[0];

    if (!entry && browserPool.length < MAX_BROWSERS) {
      entry = { browser: null, activeTabs: 0, ready: null };
      browserPool.push(entry);
      entry.ready = launchBrowser(entry);
    }

    if (entry) {
      entry.activeTabs++;
      try {
        await entry.ready;
      } catch (err) {
        entry.activeTabs = Math.max(0, entry.activeTabs - 1);
        throw err;
      }
      return entry;
    }

    // Tous les browsers (jusqu'à MAX_BROWSERS) sont pleins — on attend un slot.
    await SLEEP(500);
  }
}

function releaseSlot(entry) {
  entry.activeTabs = Math.max(0, entry.activeTabs - 1);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  const token = req.headers['x-api-key'] || req.query.api_key;
  if (token !== secret) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
});

// ─── Routes info ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'Google Reviews Scraper API',
    status: 'running',
    ...poolStatus(),
    endpoints: {
      'POST /scrape':       'Scrape a single Google Maps URL',
      'POST /scrape-batch': 'Scrape up to 10 URLs in parallel',
      'GET  /health':       'Health check',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ...poolStatus(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Allège chaque onglet — on ne lit que du texte/attributs, jamais de rendu
// visuel : bloquer images/médias/polices réduit nettement le CPU/réseau par
// onglet sans toucher au CSS (dont Google Maps a besoin pour le lazy-load de
// la liste d'avis) ni au JS/XHR (qui chargent les données des avis).
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
async function blockHeavyResources(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort();
    else req.continue();
  });
}

// ─── URL resolution ───────────────────────────────────────────────────────────
async function resolveUrl(b, url) {
  if (!url.includes('goo.gl') && !url.includes('maps.app')) return url;

  const page = await b.newPage();
  await blockHeavyResources(page);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const resolved = page.url();
    await page.close();
    return resolved;
  } catch {
    const resolved = page.url();
    await page.close();
    return resolved && resolved !== 'about:blank' ? resolved : url;
  }
}

// ─── Une tentative de scrape — page dédiée, fermée à la fin de la tentative ────
async function attemptScrape(b, url, maxReviews, sortBy) {
  const page = await b.newPage();
  await blockHeavyResources(page);

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page
      .waitForFunction(() => document.querySelector('h1') || document.querySelectorAll('form').length >= 2, {
        timeout: 5000,
        polling: 100,
      })
      .catch(() => {});

    // Cookie consent — n'attend que si un bandeau a réellement été fermé
    try {
      const consentClicked = await page.evaluate(() => {
        const forms = document.querySelectorAll('form');
        if (forms.length >= 2) {
          const btn = forms[1].querySelector('button');
          if (btn) { btn.click(); return true; }
        }
        return false;
      });
      if (consentClicked) {
        await page
          .waitForFunction(() => document.querySelectorAll('form').length < 2, { timeout: 5000, polling: 100 })
          .catch(() => {});
      }
    } catch (_) {}

    // Business info
    const businessInfo = await page.evaluate(() => {
      const name =
        document.querySelector('h1.DUwDvf')?.textContent?.trim() ||
        document.querySelector('h1')?.textContent?.trim() ||
        document.querySelector('[aria-label][role="main"] h1')?.textContent?.trim() ||
        'N/A';
      const ratingEl =
        document.querySelector('div.F7nice span[aria-hidden="true"]') ||
        document.querySelector('span.ceNzKf') ||
        document.querySelector('[class*="stars"] span');
      const rating = ratingEl?.textContent?.trim() || 'N/A';
      const reviewCountEl =
        document.querySelector('button.HHrUdb') ||
        document.querySelector('span[aria-label*="avis"]') ||
        document.querySelector('span[aria-label*="reviews"]') ||
        document.querySelector('div.F7nice span span:last-child');
      const reviewCount = reviewCountEl?.textContent?.trim() || 'N/A';
      return { name, rating, reviewCount };
    });

    // Click "Avis" tab
    try {
      const clicked = await page.evaluate(() => {
        const allTabs = Array.from(
          document.querySelectorAll('button[role="tab"], div[role="tab"], button.hh2c6')
        );
        const reviewTab = allTabs.find((el) => {
          const t = el.textContent?.toLowerCase() || '';
          const a = el.getAttribute('aria-label')?.toLowerCase() || '';
          return t.includes('avis') || t.includes('review') || a.includes('avis') || a.includes('review');
        });
        if (reviewTab) { reviewTab.click(); return true; }
        return false;
      });
      void clicked; // le waitForSelector juste en dessous couvre déjà l'attente utile
    } catch (_) {}

    // Wait for reviews
    await page
      .waitForSelector(
        '[data-review-id], .jftiEf, div[jslog*="reviewId"], div[class*="review"] div[class*="rating"]',
        { timeout: 10000 }
      )
      .catch(() => {});

    // Sort
    try {
      const sortClicked = await page.evaluate(() => {
        const btn =
          document.querySelector('button[aria-label="Trier les avis"]') ||
          document.querySelector('button[data-value="Trier"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (sortClicked) {
        await page.waitForSelector('div[role="menuitemradio"]', { timeout: 5000 }).catch(() => {});

        const prevFirstReviewId = await page.evaluate(() => {
          const el = document.querySelector('[data-review-id], .jftiEf, div[jslog*="reviewId"]');
          return el ? el.getAttribute('data-review-id') || el.getAttribute('data-js-log-id') || el.outerHTML.slice(0, 50) : null;
        });

        const optionClicked = await page.evaluate((sortMode) => {
          const items = Array.from(document.querySelectorAll('div[role="menuitemradio"]'));
          const target = items.find((el) => {
            const t = el.querySelector('.mLuXec')?.textContent?.toLowerCase() || el.textContent.toLowerCase();
            return sortMode === 'recent'
              ? t.includes('récent') || t.includes('recent')
              : t.includes('pertinent') || t.includes('relevant');
          });
          if (target) { target.click(); return true; }
          if (sortMode === 'recent') {
            const byIndex = document.querySelector('div[role="menuitemradio"][data-index="1"]');
            if (byIndex) { byIndex.click(); return true; }
          }
          return false;
        }, sortBy);

        if (optionClicked) {
          // Attend que le 1er avis affiché change réellement (signe que le tri a pris effet)
          // plutôt qu'un délai fixe — plafonné à 5s si jamais rien ne change.
          await page
            .waitForFunction(
              (prevId) => {
                const el = document.querySelector('[data-review-id], .jftiEf, div[jslog*="reviewId"]');
                if (!el) return false;
                const curId = el.getAttribute('data-review-id') || el.getAttribute('data-js-log-id') || el.outerHTML.slice(0, 50);
                return curId !== prevId;
              },
              { timeout: 5000, polling: 100 },
              prevFirstReviewId
            )
            .catch(() => {});
        }
      }
    } catch (_) {}

    // Scroll & collect
    let reviews = [];
    let stuckCount = 0;
    let lastCount = 0;

    while (reviews.length < maxReviews && stuckCount < 6) {
      await page.evaluate(() => {
        document
          .querySelectorAll(
            'button.w8nwRe, button[jsaction*="review.expand"], ' +
              'button[aria-label*="Voir plus"], button[aria-label*="See more"]'
          )
          .forEach((b) => b.click());
      });
      await SLEEP(300);

      const extracted = await page.evaluate(() => {
        const candidates = [
          ...document.querySelectorAll('[data-review-id]'),
          ...document.querySelectorAll('.jftiEf'),
          ...document.querySelectorAll('div[jslog*="reviewId"]'),
        ];
        const seen = new Set();
        const unique = candidates.filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          return true;
        });
        return unique.map((el) => {
          const author =
            el.querySelector('.d4r55')?.textContent?.trim() ||
            el.querySelector('div[class*="author"]')?.textContent?.trim() ||
            el.querySelector('a[href*="contrib"]')?.textContent?.trim() ||
            el.querySelector('button[aria-label]')?.getAttribute('aria-label') ||
            'Anonyme';
          let stars = 0;
          const starsEl = el.querySelector(
            'span[aria-label*="étoile"], span[aria-label*="étoiles"], span[aria-label*="star"]'
          );
          if (starsEl) {
            const m = (starsEl.getAttribute('aria-label') || '').match(/(\d)/);
            if (m) stars = parseInt(m[1]);
          }
          if (!stars) stars = el.querySelectorAll('img[src*="star_full"], span.hCCjke').length;
          const dateEl =
            el.querySelector('.rsqaWe') ||
            el.querySelector('span.xRkPPb') ||
            el.querySelector('.DU9Pgb span') ||
            el.querySelector('span[class*="date"]');
          const date = dateEl?.textContent?.trim() || '';
          const textEl =
            el.querySelector('.wiI7pd') ||
            el.querySelector('span[jsaction*="review.expandText"]') ||
            el.querySelector('.MyEned span') ||
            el.querySelector('div[class*="review"] span[class*="text"]');
          const text = textEl?.textContent?.trim() || '';
          const id =
            el.getAttribute('data-review-id') ||
            el.getAttribute('data-js-log-id') ||
            `${author}__${date}__${text.substring(0, 20)}`;
          return { id, author, stars, date, text };
        });
      });

      const seenIds = new Set(reviews.map((r) => r.id));
      for (const r of extracted) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          reviews.push(r);
        }
      }

      if (reviews.length === lastCount) stuckCount++;
      else { stuckCount = 0; lastCount = reviews.length; }

      if (reviews.length < maxReviews) {
        const countBeforeScroll = await page.evaluate(
          () => document.querySelectorAll('[data-review-id], .jftiEf, div[jslog*="reviewId"]').length
        );

        await page.evaluate(() => {
          const scrollable =
            document.querySelector('div[role="main"] div[tabindex="-1"]') ||
            document.querySelector('.m6QErb[aria-label]') ||
            document.querySelector('div[jsaction*="mouseover:pane"]') ||
            document.querySelector('div[class*="section-scrollbox"]');
          if (scrollable) scrollable.scrollTop += 2000;
          else window.scrollBy(0, 2000);
        });

        // Attend que de nouveaux avis apparaissent suite au scroll, plutôt qu'un
        // délai fixe — si rien de nouveau ne charge (fin de liste), on plafonne
        // à 3s puis stuckCount prend le relais comme avant.
        await page
          .waitForFunction(
            (prevCount) =>
              document.querySelectorAll('[data-review-id], .jftiEf, div[jslog*="reviewId"]').length > prevCount,
            { timeout: 3000, polling: 100 },
            countBeforeScroll
          )
          .catch(() => {});
      }
    }

    const finalReviews = reviews.slice(0, maxReviews);
    const rated = finalReviews.filter((r) => r.stars > 0);
    const avgRating =
      rated.length > 0
        ? parseFloat((rated.reduce((s, r) => s + r.stars, 0) / rated.length).toFixed(2))
        : null;

    return {
      business: businessInfo,
      sortedBy: sortBy,
      stats: {
        totalRetrieved: finalReviews.length,
        averageRatingInSample: avgRating,
        withTextComment: finalReviews.filter((r) => r.text).length,
        distribution: [5, 4, 3, 2, 1].reduce((acc, n) => {
          acc[n] = rated.filter((r) => r.stars === n).length;
          return acc;
        }, {}),
      },
      reviews: finalReviews,
    };
  } finally {
    await page.close();
  }
}

// ─── Core scraper (gère le slot + les tentatives) ──────────────────────────────
// Si business.name reste "N/A" (page pas chargée correctement, sélecteurs qui
// ne matchent rien), on retente une fois avec une page fraîche avant de
// conclure — évite de renvoyer un "succès" avec des données vides à cause
// d'un raté ponctuel. Si ça échoue encore, le lien est considéré mort/invalide.
const MAX_SCRAPE_ATTEMPTS = 2;

async function scrapeOnePage(inputUrl, maxReviews, sortBy) {
  const entry = await acquireSlot();
  const b = entry.browser;

  try {
    const url = await resolveUrl(b, inputUrl);

    let result;
    for (let attempt = 1; attempt <= MAX_SCRAPE_ATTEMPTS; attempt++) {
      result = await attemptScrape(b, url, maxReviews, sortBy);
      if (result.business.name !== 'N/A') break;
      if (attempt < MAX_SCRAPE_ATTEMPTS) {
        console.log(`[scrape] Nom introuvable (tentative ${attempt}/${MAX_SCRAPE_ATTEMPTS}) — nouvel essai : ${url}`);
      }
    }

    if (result.business.name === 'N/A') {
      throw new Error(
        `Établissement introuvable après ${MAX_SCRAPE_ATTEMPTS} tentatives — le lien est probablement invalide ou la fiche a été supprimée/déplacée.`
      );
    }

    return {
      ...result,
      sourceUrl: inputUrl,
      resolvedUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    releaseSlot(entry);
  }
}

// ─── Validation URL ───────────────────────────────────────────────────────────
function isValidGoogleMapsUrl(url) {
  return (
    typeof url === 'string' &&
    (url.includes('google.com/maps') ||
      url.includes('maps.app.goo.gl') ||
      url.includes('goo.gl'))
  );
}

// ─── POST /scrape — URL unique ────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url, max_reviews = 20, sort_by = 'recent' } = req.body;

  if (!url) return res.status(400).json({ error: 'Missing required field: url' });
  if (!isValidGoogleMapsUrl(url)) {
    return res.status(400).json({ error: 'URL must be a Google Maps link' });
  }
  if (!['recent', 'relevant'].includes(sort_by)) {
    return res.status(400).json({ error: 'sort_by must be "recent" or "relevant"' });
  }

  const count = Math.min(Math.max(1, parseInt(max_reviews) || 20), 200);
  console.log(`[${new Date().toISOString()}] /scrape  url=${url} count=${count}`);

  try {
    const data = await scrapeOnePage(url, count, sort_by);
    console.log(`[${new Date().toISOString()}] Done: ${data.stats.totalRetrieved} avis — "${data.business.name}"`);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error /scrape:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /scrape-batch — jusqu'à 10 URLs en parallèle ───────────────────────
//
// Body :
// {
//   "urls": [
//     { "url": "https://maps.google.com/...", "max_reviews": 20, "sort_by": "recent" },
//     { "url": "https://maps.app.goo.gl/...", "max_reviews": 10 },
//     ...
//   ],
//   "max_reviews": 20,   ← défaut global (surchargeable par item)
//   "sort_by": "recent"  ← défaut global
// }
//
// Réponse :
// {
//   "success": true,
//   "total": 3,
//   "succeeded": 2,
//   "failed": 1,
//   "results": [
//     { "index": 0, "url": "...", "success": true,  "data": { ... } },
//     { "index": 1, "url": "...", "success": false, "error": "..." },
//     ...
//   ]
// }

app.post('/scrape-batch', async (req, res) => {
  const {
    urls,
    max_reviews: globalMax = 20,
    sort_by: globalSort = 'recent',
  } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }
  if (urls.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 URLs per batch request' });
  }

  // Normalise chaque item du tableau
  const jobs = urls.map((item, index) => {
    const url      = typeof item === 'string' ? item : item.url;
    const maxRev   = Math.min(Math.max(1, parseInt(item.max_reviews ?? globalMax) || 20), 200);
    const sortBy   = item.sort_by ?? globalSort;
    return { index, url, maxRev, sortBy };
  });

  // Valide les URLs
  const invalid = jobs.filter((j) => !isValidGoogleMapsUrl(j.url));
  if (invalid.length > 0) {
    return res.status(400).json({
      error: 'Some URLs are not valid Google Maps links',
      invalidIndexes: invalid.map((j) => j.index),
    });
  }

  console.log(`[${new Date().toISOString()}] /scrape-batch  ${jobs.length} URLs en parallèle`);
  const startedAt = Date.now();

  // Lance toutes les pages en parallèle — le pool de browsers gère la concurrence
  const settled = await Promise.allSettled(
    jobs.map((job) => scrapeOnePage(job.url, job.maxRev, job.sortBy))
  );

  const results = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      console.log(
        `[${new Date().toISOString()}] batch[${i}] ✅ "${result.value.business.name}" — ${result.value.stats.totalRetrieved} avis`
      );
      return { index: i, url: jobs[i].url, success: true, data: result.value };
    } else {
      console.error(`[${new Date().toISOString()}] batch[${i}] ❌`, result.reason?.message);
      return { index: i, url: jobs[i].url, success: false, error: result.reason?.message || 'Unknown error' };
    }
  });

  const succeeded = results.filter((r) => r.success).length;
  const elapsed   = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(
    `[${new Date().toISOString()}] /scrape-batch done — ${succeeded}/${jobs.length} réussis en ${elapsed}s`
  );

  res.json({
    success: true,
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    elapsedSeconds: parseFloat(elapsed),
    results,
  });
});

// ─── GET /scrape (test rapide navigateur) ────────────────────────────────────
app.get('/scrape', async (req, res) => {
  const { url, max_reviews = 10, sort_by = 'recent' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing query param: url' });

  const count = Math.min(Math.max(1, parseInt(max_reviews) || 10), 200);
  console.log(`[${new Date().toISOString()}] GET /scrape url=${url}`);

  try {
    const data = await scrapeOnePage(url, count, sort_by);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error GET /scrape:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Pré-chauffe un premier browser au démarrage ─────────────────────────────
prewarmBrowser();

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Google Reviews Scraper API — port ${PORT}`);
  console.log(`   POST /scrape        { url, max_reviews, sort_by }`);
  console.log(`   POST /scrape-batch  { urls: [...], max_reviews, sort_by }`);
  console.log(`   GET  /health`);
  console.log(`   Pool : max ${MAX_BROWSERS} Chrome × ${MAX_TABS_PER_BROWSER} onglets (= ${MAX_BROWSERS * MAX_TABS_PER_BROWSER} en parallèle)`);
});
