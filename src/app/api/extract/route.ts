import { NextResponse } from "next/server";
import { chromium } from "playwright";

const HEADERS = {
  "accept": "*/*",
  "origin": "https://artlist.io",
  "referer": "https://artlist.io/",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
};

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "A URL é obrigatória." }, { status: 400 });

    let title = "artlist_media";
    try {
      const cleanUrl = url.split("?")[0].replace(/\/$/, "");
      const parts = cleanUrl.split("/");
      if (parts.length >= 2) {
        if (/^\d+$/.test(parts[parts.length - 1])) {
          title = parts[parts.length - 2];
        } else {
          const last = parts[parts.length - 1];
          if (!["clip", "song", "track", "sfx"].includes(last)) {
            title = last;
          }
        }
      }
    } catch (e) {}

    if (url.includes(".m3u8") || url.includes(".aac") || url.includes(".mp3")) {
       return NextResponse.json({ type: url.includes(".m3u8") ? "footage" : "music", url, title });
    }

    const isAudio = url.includes("/song/") || url.includes("/royalty-free-music/") || url.includes("/sfx/") || url.includes("/track/");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const text = await res.text();
        
        const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
          const rawTitle = titleMatch[1].split(" - ")[0].split(" | ")[0].trim();
          if (rawTitle) title = rawTitle;
        }

        const mediaMatch = text.match(/(https:\/\/[^"'\s]+\.(?:m3u8|aac|mp3))/);
        if (mediaMatch) {
          const foundUrl = mediaMatch[0];
          return NextResponse.json({ type: foundUrl.includes(".m3u8") ? "footage" : "music", url: foundUrl, title });
        }
      }
    } catch (e) {}

    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process"
        ]
      });
    } catch (err: any) {
      return NextResponse.json({ error: `Navegador falhou: ${err.message}` }, { status: 500 });
    }

    try {
      const context = await browser.newContext({ userAgent: HEADERS["user-agent"], viewport: { width: 1280, height: 800 } });
      await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
      const page = await context.newPage();

      let foundUrl: string | null = null;
      
      const interceptPromise = new Promise<string>((resolve) => {
        page.on("response", async (res) => {
          try {
            // Tenta procurar a mídia direto no código fonte (resposta HTML da página)
            if (res.url().includes(url.split('/').pop()!)) {
              const text = await res.text();
              const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
              if (titleMatch) {
                const rawTitle = titleMatch[1].split(" - ")[0].split(" | ")[0].trim();
                if (rawTitle) title = rawTitle;
              }
              // Regex para encontrar m3u8 (vídeo) ou aac/mp3 (áudio)
              const match = text.match(/(https:\/\/[^"'\s]+\.(?:m3u8|aac|mp3))/);
              if (match) {
                resolve(match[0]);
              }
            }

            // Fallback: Interceptação de rede caso o regex falhe
            if (isAudio && res.url().match(/\.(aac|mp3)$/)) resolve(res.url());
            if (!isAudio && res.url().includes(".m3u8")) resolve(res.url());
          } catch (e) {}
        });

        page.on("request", (req) => {
          if (isAudio && req.url().match(/\.(aac|mp3)$/)) resolve(req.url());
          if (!isAudio && req.url().includes(".m3u8")) resolve(req.url());
        });
      });

      page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

      // Forçar play apenas para música, já que footage pega do código fonte
      if (isAudio) {
        page.waitForSelector('button:has-text("Play"), button[aria-label*="Play"], [data-testid*="play"]', { timeout: 10000 }).then(async () => {
          await page.click('button:has-text("Play"), button[aria-label*="Play"], [data-testid*="play"]');
        }).catch(() => {});
      }

      // Espera interceptar ou dar timeout de 45s
      const finalUrl = await Promise.race([
        interceptPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 45000))
      ]);

      try {
        const pTitle = await page.title();
        if (pTitle) {
          const cleanPTitle = pTitle.split(" - ")[0].split(" | ")[0].trim();
          if (cleanPTitle) title = cleanPTitle;
        }
      } catch (e) {}

      if (finalUrl) {
        return NextResponse.json({ type: isAudio ? "music" : "footage", url: finalUrl, title });
      }

    } finally {
      await browser.close();
    }

    return NextResponse.json({ error: "Mídia não interceptada. Verifique se o link está correto." }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
