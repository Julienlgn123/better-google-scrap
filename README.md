# 🗺️ Google Reviews Scraper — code machine

API REST de scraping d'avis Google Maps (Puppeteer + Chromium headless). C'est
exactement le code qui tourne sur `scraper-1` à `scraper-4` — ce repo existe
pour pouvoir cloner et déployer une nouvelle machine en une commande au lieu
de copier les fichiers à la main à chaque fois.

## 🚀 Déployer une nouvelle machine

Sur une VM fraîche (Ubuntu, root ou sudo) :

```bash
git clone <URL_DE_CE_REPO> scraper
cd scraper
API_SECRET=la-meme-cle-que-les-autres-machines ./deploy.sh
```

`deploy.sh` fait tout :
- installe Docker si absent
- détecte le nombre de cœurs (`nproc`) et choisit la config :
  - **≥ 3 cœurs** → "grosse" machine → `MAX_BROWSERS=2`, `MAX_TABS_PER_BROWSER=10` (20 onglets, comme scraper-1/3)
  - **< 3 cœurs** → "petite" machine → `MAX_BROWSERS=1`, `MAX_TABS_PER_BROWSER=5` (5 onglets, comme scraper-2/4)
- build l'image et lance le container sur le port **8443** (pas 3000 — voir
  ci-dessous)
- vérifie que `/health` répond

Tu peux surcharger la détection automatique :

```bash
API_SECRET=xxx MAX_BROWSERS=3 MAX_TABS_PER_BROWSER=10 ./deploy.sh
```

## ⚠️ Pourquoi le port 8443 et pas 3000

Sur un compte UpCloud en mode "trial", le firewall ne peut pas être modifié —
le port 3000 (celui que l'app écoute nativement) reste bloqué en entrant,
mais 8443 est autorisé par défaut. `deploy.sh` mappe donc `8443:3000`
(le container écoute toujours en interne sur 3000, seul le port exposé change).
Si ta machine n'a pas cette restriction, lance avec `PORT_EXTERNAL=3000`.

## 🔧 Après déploiement

Une fois la machine en ligne, connecte-la au reste du système :

1. **`dispatcher/machines.js`** (projet `dispatcher`, local) — ajoute la
   machine avec son `baseUrl` et sa `maxConcurrent` (= `MAX_BROWSERS × MAX_TABS_PER_BROWSER`).
2. **Vercel (`public-checker`)** — ajoute une variable d'env `SCRAPER_N_URL`
   pointant sur `http://IP:8443`, et référence-la dans `api/check.js` /
   `api/status.js` (`MACHINES` array), puis `vercel --prod`.

## 🔌 API

| Route | Description |
|---|---|
| `POST /scrape` | `{ url, max_reviews, sort_by }` → scrape un lien Google Maps |
| `POST /scrape-batch` | `{ urls: [...] }` → jusqu'à 10 liens en parallèle |
| `GET /health` | État du pool (onglets actifs, browsers ouverts, capacité max) |

Toutes les routes (sauf `/`) nécessitent le header `x-api-key: <API_SECRET>`.

## 🧠 Ce que fait le code (server.js)

- **Pool multi-browser** : plusieurs instances Chromium en parallèle, chacune
  avec plusieurs onglets. Remplit les browsers déjà ouverts avant d'en lancer
  un nouveau (lazy), jusqu'à `MAX_BROWSERS`.
- **Attentes adaptatives** (`page.waitForFunction`/`waitForSelector`) au lieu
  de délais fixes — continue dès que la page est prête, plafonné par un
  timeout de sécurité sinon (~3x plus rapide qu'avec des délais fixes).
- **Blocage images/médias/polices** par onglet (`setRequestInterception`) —
  on ne lit que du texte/attributs, jamais de rendu visuel, donc ça allège
  fortement le CPU/réseau sans rien casser.
- **Retry sur échec d'extraction** : si le nom de l'établissement reste
  introuvable (page mal chargée), retente une fois avec une page fraîche
  avant de conclure que le lien est invalide/mort.

Capacité soutenable réelle testée par charge (pas juste la capacité théorique
du pool) : voir les commentaires dans `dispatcher/machines.js`.
