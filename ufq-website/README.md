# UFQ – United For Quality website

A bilingual (Arabic / English) company website for **UFQ**, served by nginx inside Docker.

Sections: **Home** (logo + company name) · **Our Services** · **Certificates** · **About Us** · **Contact**

- Arabic is the default (right-to-left). The **EN / عربي** button in the header switches language;
  the choice is remembered in the browser.
- Link straight to a language with `?lang=en` or `?lang=ar`.
- Works on phones (collapsible menu).

## Run it with Docker

Needs only Docker on the machine.

```bash
cd ufq-website
docker compose up -d --build
```

Open <http://localhost:8080>. To serve on port 80 instead:

```bash
WEB_PORT=80 docker compose up -d --build
```

Stop it with `docker compose down`.

### Moving it to other servers

**Option A – copy the folder:** copy the `ufq-website` folder to the server and run `docker compose up -d --build`.

**Option B – ship the image as a file (no source needed on the server):**

```bash
docker build -t ufq-website:latest .
docker save ufq-website:latest -o ufq-website.tar
# copy ufq-website.tar to the server, then on the server:
docker load -i ufq-website.tar
docker run -d --name ufq-website --restart unless-stopped -p 80:80 ufq-website:latest
```

**Option C – a registry (Docker Hub, GHCR…):**

```bash
docker tag ufq-website:latest <your-user>/ufq-website:latest
docker push <your-user>/ufq-website:latest
# on any server:
docker run -d --name ufq-website --restart unless-stopped -p 80:80 <your-user>/ufq-website:latest
```

## Editing the content

| What | Where |
|---|---|
| Arabic text | `site/index.html` (the text inside each element) |
| English text | `site/assets/js/i18n.js` (same keys as the `data-i18n` attributes in `index.html`) |
| Colours, fonts, layout | `site/assets/css/style.css` (colours are at the top in `:root`) |
| Logo | `site/assets/img/logo.png` (and the small browser-tab icon `favicon.png`) – replace with a new file of the same name to change it |
| Certificate images | put them in `site/assets/img/certificates/` and follow the comment above the Certificates section in `index.html` |
| Phone / WhatsApp | search for `27687519` in `index.html` |

When you add a new piece of text, give it a `data-i18n="some.key"` attribute in `index.html`
and add the English for `some.key` in `i18n.js`.

After editing, rebuild: `docker compose up -d --build`.
